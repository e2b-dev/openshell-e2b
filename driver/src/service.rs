//! The `ComputeDriver` gRPC service: the list of questions the gateway can ask us.
//!
//! NVIDIA defines the questions in `proto/compute_driver.proto`. Their build
//! turns that file into a Rust trait (`ComputeDriver`), and we answer each
//! question by implementing one method of it:
//!
//!   gateway asks                      we answer
//!   ──────────────────────────────    ─────────────────────────────────────────
//!   `GetCapabilities`  "who are you?"   name, version, rules we accept        ✅
//!   `ValidateSandboxCreate`             "fine"                                ✅
//!   `CreateSandbox`                     E2B box + fence + runtime + supervisor ✅ (lifecycle.rs)
//!   Get / List / `WatchSandboxes`       from our in-memory table              ✅
//!   `DeleteSandbox`                     stop supervisor + tunnel, kill E2B box ✅
//!   Stop / Start / Suspend            "not implemented yet"                 ⏳
//!
//! State lives in memory. If the driver restarts, it forgets its sandboxes
//! (the E2B boxes stay tagged with metadata, so they can be found and cleaned).

use crate::lifecycle::{self, Config, Running};
use futures::Stream;
use openshell_core::extension_protocol::{
    ExtensionFamily, extension_metadata, validate_gateway_metadata,
};
use openshell_core::proto::compute::v1::{
    AuthenticateSandboxRequest, AuthenticateSandboxResponse, CreateSandboxRequest,
    CreateSandboxResponse, DeleteSandboxRequest, DeleteSandboxResponse, DeleteWorkspaceRequest,
    DeleteWorkspaceResponse, EnsureWorkspaceRequest, EnsureWorkspaceResponse,
    GetCapabilitiesRequest, GetCapabilitiesResponse, GetSandboxRequest, GetSandboxResponse,
    ListSandboxesRequest, ListSandboxesResponse, StartSandboxRequest, StartSandboxResponse,
    StopSandboxRequest, StopSandboxResponse, SuspendSandboxRequest, SuspendSandboxResponse,
    ValidateSandboxCreateRequest, ValidateSandboxCreateResponse, WatchSandboxesDeletedEvent,
    WatchSandboxesEvent, WatchSandboxesRequest, WatchSandboxesSandboxEvent,
    compute_driver_server::ComputeDriver, watch_sandboxes_event::Payload,
};
use openshell_core::resource_admission::{DriverAdmissionConfig, ResourceAdmissionConfig};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Mutex, broadcast, watch};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use tonic::{Request, Response, Status};

pub const DRIVER_NAME: &str = "e2b";
const IMPLEMENTATION: &str = "e2b-dev/openshell-driver-e2b";

/// State shared by the gRPC handlers, the driver-owned create/delete tasks,
/// the health loop and the shutdown path.
#[derive(Clone)]
pub struct Shared {
    pub cfg: Config,
    /// `OpenShell` sandbox id → running sandbox.
    pub sandboxes: Arc<Mutex<HashMap<String, Running>>>,
    /// Creates in flight (rejects duplicate creates; lets delete cancel one).
    /// Lock order: `pending` before `sandboxes`.
    pub pending: Arc<Mutex<HashMap<String, PendingCreate>>>,
    /// VMs whose rollback failed (VM id → sandbox id); the health loop keeps
    /// retrying the kill. Until they are gone, delete stays retryable and a
    /// new create for that sandbox is refused.
    pub leaked: Arc<Mutex<HashMap<String, String>>>,
    /// Set by shutdown under the `pending` lock: no new creates after that.
    pub stopping: Arc<AtomicBool>,
    /// Fan-out of changes to every open `WatchSandboxes` stream.
    pub events: broadcast::Sender<WatchSandboxesEvent>,
}

impl Shared {
    fn announce(&self, payload: Payload) {
        // No listeners is fine: the gateway may not be watching yet.
        let _ = self.events.send(WatchSandboxesEvent {
            payload: Some(payload),
        });
    }
}

/// A create that has not finished. The entry stays until the create is
/// published or fully rolled back, so its VMs are always tracked somewhere:
/// here, in the sandbox table, or in the leaked set.
pub struct PendingCreate {
    /// Delete or shutdown sends `true`. Provisioning stops at its next step
    /// and rolls its VMs back instead of publishing them.
    pub cancel: watch::Sender<bool>,
    /// `Some` once the create has finished. For a create that was not
    /// published: `Ok` when none of its VMs remain, `Err` when a kill failed
    /// (the VMs are then in the leaked set, retried by the health loop).
    pub done: watch::Receiver<Option<Result<(), String>>>,
}

impl PendingCreate {
    /// Cancel and return a handle to wait for the outcome.
    pub fn cancel(&self) -> watch::Receiver<Option<Result<(), String>>> {
        self.cancel.send_replace(true);
        self.done.clone()
    }
}

/// Wait for a cancelled create to finish and report whether its VMs are gone.
pub async fn wait_cancelled(
    mut done: watch::Receiver<Option<Result<(), String>>>,
) -> Result<(), String> {
    done.wait_for(Option::is_some).await.map_or_else(
        |_| Err("create task ended without reporting its outcome".to_owned()),
        |outcome| outcome.clone().unwrap_or(Ok(())),
    )
}

pub struct E2bDriver {
    cfg: Config,
    shared: Shared,
    sandboxes: Arc<Mutex<HashMap<String, Running>>>,
    events: broadcast::Sender<WatchSandboxesEvent>,
}

impl E2bDriver {
    pub fn new(cfg: Config) -> Self {
        let (events, _) = broadcast::channel(256);
        let shared = Shared {
            cfg: cfg.clone(),
            sandboxes: Arc::default(),
            pending: Arc::default(),
            leaked: Arc::default(),
            stopping: Arc::default(),
            events: events.clone(),
        };
        crate::health::spawn(shared.clone());
        Self {
            cfg,
            sandboxes: shared.sandboxes.clone(),
            shared,
            events,
        }
    }

    /// A handle for the shutdown path in main.rs.
    pub fn shared(&self) -> Shared {
        self.shared.clone()
    }

    /// The handshake answer. The gateway refuses to start until it gets this.
    fn capabilities(&self) -> GetCapabilitiesResponse {
        GetCapabilitiesResponse {
            // Which sandbox-creation requests we accept. We use NVIDIA's
            // default policy unchanged: callers may not pass raw driver config,
            // and sandboxes must carry the standard "attachable" labels.
            // The gateway compares this string byte for byte on every call.
            resource_admission_policy: DriverAdmissionConfig {
                allow_driver_config: false,
                resource_admission: ResourceAdmissionConfig::default(),
            }
            .acknowledgement(),
            driver_name: DRIVER_NAME.to_string(),
            driver_version: env!("CARGO_PKG_VERSION").to_string(),
            default_image: self.cfg.template.clone(),
            // The gateway decides when to create/stop/delete; we just do it.
            gateway_manages_lifecycle: true,
            supports_sandbox_authentication: false,
            // "Ready" is declared by the gateway when the supervisor connects,
            // not by us. That's the safer choice: ready means policed.
            driver_reports_runtime_readiness: false,
            resource_capabilities: None,
            rootfs_tar_staging_dir: String::new(),
            rootfs_tar_max_bytes: 0,
            // Version handshake: both sides state their protocol version and
            // refuse to talk if they're incompatible (checked in get_capabilities).
            extension: Some(extension_metadata(
                ExtensionFamily::Compute,
                IMPLEMENTATION,
                env!("CARGO_PKG_VERSION"),
                [],
            )),
        }
    }
}

type WatchStream =
    Pin<Box<dyn Stream<Item = Result<WatchSandboxesEvent, Status>> + Send + 'static>>;

#[tonic::async_trait]
impl ComputeDriver for E2bDriver {
    async fn get_capabilities(
        &self,
        request: Request<GetCapabilitiesRequest>,
    ) -> Result<Response<GetCapabilitiesResponse>, Status> {
        let caps = self.capabilities();
        validate_gateway_metadata(
            ExtensionFamily::Compute,
            DRIVER_NAME,
            caps.extension.as_ref(),
            request.into_inner().gateway,
        )
        .map_err(|e| Status::failed_precondition(e.to_string()))?;
        Ok(Response::new(caps))
    }

    async fn authenticate_sandbox(
        &self,
        _request: Request<AuthenticateSandboxRequest>,
    ) -> Result<Response<AuthenticateSandboxResponse>, Status> {
        Err(Status::unimplemented(
            "e2b does not authenticate sandbox credentials",
        ))
    }

    async fn validate_sandbox_create(
        &self,
        request: Request<ValidateSandboxCreateRequest>,
    ) -> Result<Response<ValidateSandboxCreateResponse>, Status> {
        let sandbox = request
            .into_inner()
            .sandbox
            .ok_or_else(|| Status::invalid_argument("sandbox is required"))?;
        // Reject what this driver can't honour, before any VM is allocated.
        lifecycle::check_supported(&self.cfg, &sandbox).map_err(Status::invalid_argument)?;
        Ok(Response::new(ValidateSandboxCreateResponse {}))
    }

    async fn get_sandbox(
        &self,
        request: Request<GetSandboxRequest>,
    ) -> Result<Response<GetSandboxResponse>, Status> {
        let id = request.into_inner().sandbox_id;
        // Clone and release the lock right away; never hold it across awaits.
        let sandbox = self
            .sandboxes
            .lock()
            .await
            .get(&id)
            .map(|running| running.sandbox.clone())
            .ok_or_else(|| Status::not_found("sandbox not found"))?;
        Ok(Response::new(GetSandboxResponse {
            sandbox: Some(sandbox),
        }))
    }

    async fn list_sandboxes(
        &self,
        _request: Request<ListSandboxesRequest>,
    ) -> Result<Response<ListSandboxesResponse>, Status> {
        let table = self.sandboxes.lock().await;
        Ok(Response::new(ListSandboxesResponse {
            sandboxes: table.values().map(|r| r.sandbox.clone()).collect(),
        }))
    }

    async fn create_sandbox(
        &self,
        request: Request<CreateSandboxRequest>,
    ) -> Result<Response<CreateSandboxResponse>, Status> {
        let sandbox = request
            .into_inner()
            .sandbox
            .ok_or_else(|| Status::invalid_argument("sandbox is required"))?;
        lifecycle::check_supported(&self.cfg, &sandbox).map_err(Status::invalid_argument)?;
        let id = sandbox.id.clone();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(None);
        {
            // Reserve the id: a second create for the same sandbox is rejected
            // instead of allocating another VM and overwriting the record.
            let mut pending = self.shared.pending.lock().await;
            if self.shared.stopping.load(Ordering::SeqCst) {
                return Err(Status::unavailable("driver is stopping"));
            }
            if pending.contains_key(&id) || self.sandboxes.lock().await.contains_key(&id) {
                return Err(Status::already_exists(
                    "sandbox is already being created or exists",
                ));
            }
            if self.shared.leaked.lock().await.values().any(|s| s == &id) {
                return Err(Status::unavailable(
                    "VMs of an earlier attempt are still being removed; retry",
                ));
            }
            pending.insert(
                id.clone(),
                PendingCreate {
                    cancel: cancel_tx,
                    done: done_rx,
                },
            );
        }
        // The work runs in a driver-owned task: if the gateway cancels this
        // request, provisioning still finishes (and is tracked) or rolls back.
        let shared = self.shared.clone();
        let task = tokio::spawn(async move {
            let id = sandbox.id.clone();
            let result = lifecycle::create(&shared.cfg, &sandbox, cancel_rx).await;
            // Decide under the `pending` lock, so a delete sees this sandbox
            // either as pending or in the table, never as neither.
            let mut pending = shared.pending.lock().await;
            let cancelled = pending.get(&id).is_some_and(|p| *p.cancel.borrow());
            let (outcome, cleanup) = match result {
                Ok(running) if cancelled => {
                    // Cancelled after provisioning finished: never publish.
                    // The pending entry stays while the rollback runs.
                    drop(pending);
                    let ids = [running.e2b_id, running.supervisor_id];
                    let cleanup = lifecycle::delete(&shared.cfg, &id, &ids[0], &ids[1]).await;
                    if let Err(error) = &cleanup {
                        tracing::warn!(%error, "rollback of cancelled create failed; health monitor will retry");
                        shared
                            .leaked
                            .lock()
                            .await
                            .extend(ids.map(|vm| (vm, id.clone())));
                    }
                    pending = shared.pending.lock().await;
                    (
                        Err("sandbox was deleted while it was being created".to_owned()),
                        cleanup,
                    )
                }
                Ok(running) => {
                    let runtime_identity = running.e2b_id.clone();
                    // Insert and announce under one lock, so a watcher that
                    // snapshots the table (also under the lock) sees it either way.
                    let mut table = shared.sandboxes.lock().await;
                    shared.announce(Payload::Sandbox(WatchSandboxesSandboxEvent {
                        sandbox: Some(running.sandbox.clone()),
                    }));
                    table.insert(id.clone(), running);
                    drop(table);
                    (Ok(runtime_identity), Ok(()))
                }
                Err(error) => {
                    // lifecycle::create already rolled back; anything it could
                    // not kill is handed to the health loop before we let go.
                    let cleanup = if error.leaked_boxes.is_empty() {
                        Ok(())
                    } else {
                        Err(format!("could not kill {:?}", error.leaked_boxes))
                    };
                    shared
                        .leaked
                        .lock()
                        .await
                        .extend(error.leaked_boxes.into_iter().map(|vm| (vm, id.clone())));
                    (Err(error.message), cleanup)
                }
            };
            pending.remove(&id);
            drop(pending);
            // Wake any delete or shutdown waiting for this create.
            done_tx.send_replace(Some(cleanup));
            outcome
        });
        let runtime_identity = task
            .await
            .map_err(|e| Status::internal(format!("create task failed: {e}")))?
            .map_err(Status::internal)?;
        Ok(Response::new(CreateSandboxResponse { runtime_identity }))
    }

    async fn stop_sandbox(
        &self,
        _request: Request<StopSandboxRequest>,
    ) -> Result<Response<StopSandboxResponse>, Status> {
        Err(Status::unimplemented(
            "e2b driver: stop not implemented yet",
        ))
    }

    async fn start_sandbox(
        &self,
        _request: Request<StartSandboxRequest>,
    ) -> Result<Response<StartSandboxResponse>, Status> {
        Err(Status::unimplemented(
            "e2b driver: start not implemented yet",
        ))
    }

    async fn suspend_sandbox(
        &self,
        _request: Request<SuspendSandboxRequest>,
    ) -> Result<Response<SuspendSandboxResponse>, Status> {
        Err(Status::unimplemented(
            "e2b driver: suspend not implemented yet",
        ))
    }

    async fn delete_sandbox(
        &self,
        request: Request<DeleteSandboxRequest>,
    ) -> Result<Response<DeleteSandboxResponse>, Status> {
        let id = request.into_inner().sandbox_id;
        // A create still in flight: cancel it, and wait until it has rolled
        // back. It never reaches the table, so there is nothing else to do.
        let in_flight = self
            .shared
            .pending
            .lock()
            .await
            .get(&id)
            .map(PendingCreate::cancel);
        if let Some(done) = in_flight {
            return match wait_cancelled(done).await {
                Ok(()) => Ok(Response::new(DeleteSandboxResponse { deleted: true })),
                Err(error) => Err(Status::unavailable(format!(
                    "delete not confirmed, retry: {error}"
                ))),
            };
        }
        // Mark the record as deleting (it stays in Get/List/Watch) and take
        // what the cleanup needs. A second delete meanwhile is told to wait.
        let (e2b_id, supervisor_id) = {
            let mut table = self.sandboxes.lock().await;
            let Some(running) = table.get_mut(&id) else {
                drop(table);
                // Not running, but VMs from a failed rollback may remain.
                if self.shared.leaked.lock().await.values().any(|s| s == &id) {
                    return Err(Status::unavailable(
                        "delete not confirmed, retry: VMs are still being removed",
                    ));
                }
                return Ok(Response::new(DeleteSandboxResponse { deleted: false }));
            };
            if running.deleting {
                return Err(Status::unavailable("delete already in progress"));
            }
            running.deleting = true;
            if let Some(status) = running.sandbox.status.as_mut() {
                status.deleting = true;
            }
            self.shared
                .announce(Payload::Sandbox(WatchSandboxesSandboxEvent {
                    sandbox: Some(running.sandbox.clone()),
                }));
            let parts = (running.e2b_id.clone(), running.supervisor_id.clone());
            drop(table); // announced under the lock; released right after
            parts
        };
        // Driver-owned task: cancellation of this request can't abandon it.
        let shared = self.shared.clone();
        let task = tokio::spawn(async move {
            let result = lifecycle::delete(&shared.cfg, &id, &e2b_id, &supervisor_id).await;
            let mut table = shared.sandboxes.lock().await;
            match &result {
                // Only now, after E2B confirmed, the record goes away.
                Ok(()) => {
                    table.remove(&id);
                    shared.announce(Payload::Deleted(WatchSandboxesDeletedEvent {
                        sandbox_id: id,
                    }));
                }
                // Keep the record so a retry can find the box; say what happened.
                Err(e) => {
                    if let Some(running) = table.get_mut(&id) {
                        running.deleting = false;
                        lifecycle::mark_not_ready(running, "DeleteFailed", e);
                        shared.announce(Payload::Sandbox(WatchSandboxesSandboxEvent {
                            sandbox: Some(running.sandbox.clone()),
                        }));
                    }
                }
            }
            drop(table);
            result
        });
        task.await
            .map_err(|e| Status::internal(format!("delete task failed: {e}")))?
            .map_err(|e| Status::unavailable(format!("delete not confirmed, retry: {e}")))?;
        Ok(Response::new(DeleteSandboxResponse { deleted: true }))
    }

    type WatchSandboxesStream = WatchStream;

    async fn watch_sandboxes(
        &self,
        _request: Request<WatchSandboxesRequest>,
    ) -> Result<Response<Self::WatchSandboxesStream>, Status> {
        // Subscribe and snapshot under the same lock that create/delete hold
        // while announcing: no event can slip between the snapshot and the
        // live stream.
        let table = self.sandboxes.lock().await;
        let subscription = self.events.subscribe();
        let current: Vec<_> = table
            .values()
            .map(|r| {
                Ok(WatchSandboxesEvent {
                    payload: Some(Payload::Sandbox(WatchSandboxesSandboxEvent {
                        sandbox: Some(r.sandbox.clone()),
                    })),
                })
            })
            .collect();
        drop(table);
        // If this watcher falls too far behind, end the stream with an error
        // instead of silently skipping events; the gateway re-subscribes and
        // gets a fresh snapshot.
        let live = BroadcastStream::new(subscription).map(|event| {
            event.map_err(|_| {
                Status::aborted("watch fell behind; re-subscribe for a fresh snapshot")
            })
        });
        Ok(Response::new(Box::pin(
            tokio_stream::iter(current).chain(live),
        )))
    }

    async fn ensure_workspace(
        &self,
        _request: Request<EnsureWorkspaceRequest>,
    ) -> Result<Response<EnsureWorkspaceResponse>, Status> {
        Ok(Response::new(EnsureWorkspaceResponse::default()))
    }

    async fn delete_workspace(
        &self,
        _request: Request<DeleteWorkspaceRequest>,
    ) -> Result<Response<DeleteWorkspaceResponse>, Status> {
        Ok(Response::new(DeleteWorkspaceResponse::default()))
    }
}

#[cfg(test)]
mod tests {
    use super::{ComputeDriver, E2bDriver, PendingCreate};
    use openshell_core::proto::compute::v1::DeleteSandboxRequest;
    use std::sync::Arc;
    use tokio::sync::watch;
    use tonic::Request;

    fn driver() -> E2bDriver {
        E2bDriver::new(crate::lifecycle::Config {
            template: "worker".into(),
            e2b: crate::e2b::E2b {
                node: "false".into(),
                helper: "/nonexistent".into(),
            },
            supervisor_template: "supervisor".into(),
            gateway_tunnel: "/nonexistent".into(),
            gateway_endpoint: "https://127.0.0.1:17670".into(),
            gateway_ca: "/nonexistent".into(),
            owner: "test".into(),
        })
    }

    /// Register a fake in-flight create; returns its cancel receiver and done sender.
    async fn in_flight(
        driver: &E2bDriver,
    ) -> (
        watch::Receiver<bool>,
        watch::Sender<Option<Result<(), String>>>,
    ) {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(None);
        driver.shared.pending.lock().await.insert(
            "sbx".into(),
            PendingCreate {
                cancel: cancel_tx,
                done: done_rx,
            },
        );
        (cancel_rx, done_tx)
    }

    fn delete(
        driver: &Arc<E2bDriver>,
    ) -> tokio::task::JoinHandle<Result<tonic::Response<super::DeleteSandboxResponse>, tonic::Status>>
    {
        let driver = driver.clone();
        tokio::spawn(async move {
            driver
                .delete_sandbox(Request::new(DeleteSandboxRequest {
                    sandbox_id: "sbx".into(),
                    ..Default::default()
                }))
                .await
        })
    }

    #[tokio::test]
    async fn delete_cancels_an_in_flight_create_and_reports_its_rollback()
    -> Result<(), Box<dyn std::error::Error>> {
        let driver = Arc::new(driver());
        let (mut cancel, done) = in_flight(&driver).await;
        let first = delete(&driver);
        let second = delete(&driver);
        // Both deletes cancel the create, then wait for its outcome.
        tokio::time::timeout(std::time::Duration::from_secs(5), cancel.wait_for(|c| *c)).await??;
        tokio::task::yield_now().await;
        assert!(!first.is_finished() && !second.is_finished());
        driver.shared.pending.lock().await.remove("sbx");
        done.send_replace(Some(Ok(())));
        assert!(first.await??.into_inner().deleted);
        assert!(second.await??.into_inner().deleted);
        Ok(())
    }

    #[tokio::test]
    async fn sandbox_with_leaked_vms_stays_retryable_until_they_are_gone()
    -> Result<(), Box<dyn std::error::Error>> {
        let driver = Arc::new(driver());
        driver
            .shared
            .leaked
            .lock()
            .await
            .insert("vm-1".into(), "sbx".into());
        let status = delete(&driver)
            .await?
            .err()
            .ok_or("delete must stay retryable")?;
        assert_eq!(status.code(), tonic::Code::Unavailable);
        // Once the health loop has killed the VM, delete reports it gone.
        driver.shared.leaked.lock().await.remove("vm-1");
        assert!(!delete(&driver).await??.into_inner().deleted);
        Ok(())
    }

    #[tokio::test]
    async fn no_create_is_admitted_once_shutdown_started() -> Result<(), Box<dyn std::error::Error>>
    {
        let driver = driver();
        driver
            .shared
            .stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let status = driver
            .create_sandbox(Request::new(super::CreateSandboxRequest {
                sandbox: Some(openshell_core::proto::compute::v1::DriverSandbox {
                    id: "sbx".into(),
                    ..Default::default()
                }),
            }))
            .await
            .err()
            .ok_or("create must be refused")?;
        assert_eq!(status.code(), tonic::Code::Unavailable);
        assert!(driver.shared.pending.lock().await.is_empty());
        Ok(())
    }

    #[tokio::test]
    async fn delete_reports_a_failed_rollback_as_retryable()
    -> Result<(), Box<dyn std::error::Error>> {
        let driver = Arc::new(driver());
        let (_cancel, done) = in_flight(&driver).await;
        let deleting = delete(&driver);
        tokio::task::yield_now().await;
        done.send_replace(Some(Err("could not kill [\"w\"]".into())));
        let status = deleting.await?.err().ok_or("delete must fail")?;
        assert_eq!(status.code(), tonic::Code::Unavailable);
        Ok(())
    }
}
