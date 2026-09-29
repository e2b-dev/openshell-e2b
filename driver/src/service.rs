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
//!   Stop / Start                      "not implemented yet"                 ⏳
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
    StopSandboxRequest, StopSandboxResponse, ValidateSandboxCreateRequest,
    ValidateSandboxCreateResponse, WatchSandboxesDeletedEvent, WatchSandboxesEvent,
    WatchSandboxesRequest, WatchSandboxesSandboxEvent, compute_driver_server::ComputeDriver,
    watch_sandboxes_event::Payload,
};
use openshell_core::resource_admission::{DriverAdmissionConfig, ResourceAdmissionConfig};
use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{Mutex, broadcast};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use tonic::{Request, Response, Status};

pub const DRIVER_NAME: &str = "e2b";
const IMPLEMENTATION: &str = "sudolabs/openshell-driver-e2b";

/// State shared by the gRPC handlers, the driver-owned create/delete tasks,
/// the health loop and the shutdown path.
#[derive(Clone)]
pub struct Shared {
    pub cfg: Config,
    /// `OpenShell` sandbox id → running sandbox.
    pub sandboxes: Arc<Mutex<HashMap<String, Running>>>,
    /// Sandbox ids with a create in flight (rejects duplicate creates).
    pub pending: Arc<Mutex<HashSet<String>>>,
    /// E2B boxes whose rollback failed; the health loop keeps retrying the kill.
    pub leaked: Arc<Mutex<HashSet<String>>>,
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
        {
            // Reserve the id: a second create for the same sandbox is rejected
            // instead of allocating another VM and overwriting the record.
            let mut pending = self.shared.pending.lock().await;
            if pending.contains(&id) || self.sandboxes.lock().await.contains_key(&id) {
                return Err(Status::already_exists(
                    "sandbox is already being created or exists",
                ));
            }
            pending.insert(id.clone());
        }
        // The work runs in a driver-owned task: if the gateway cancels this
        // request, provisioning still finishes (and is tracked) or rolls back.
        let shared = self.shared.clone();
        let task = tokio::spawn(async move {
            let result = lifecycle::create(&shared.cfg, &sandbox).await;
            let outcome = match result {
                Ok(running) => {
                    let runtime_identity = running.e2b_id.clone();
                    // Insert and announce under one lock, so a watcher that
                    // snapshots the table (also under the lock) sees it either way.
                    let mut table = shared.sandboxes.lock().await;
                    shared.announce(Payload::Sandbox(WatchSandboxesSandboxEvent {
                        sandbox: Some(running.sandbox.clone()),
                    }));
                    table.insert(sandbox.id.clone(), running);
                    drop(table);
                    Ok(runtime_identity)
                }
                Err(error) => {
                    if let Some(box_id) = error.leaked_box {
                        shared.leaked.lock().await.insert(box_id);
                    }
                    Err(error.message)
                }
            };
            shared.pending.lock().await.remove(&sandbox.id);
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

    async fn delete_sandbox(
        &self,
        request: Request<DeleteSandboxRequest>,
    ) -> Result<Response<DeleteSandboxResponse>, Status> {
        let id = request.into_inner().sandbox_id;
        // Mark the record as deleting (it stays in Get/List/Watch) and take
        // what the cleanup needs. A second delete meanwhile is told to wait.
        let (e2b_id, children) = {
            let mut table = self.sandboxes.lock().await;
            let Some(running) = table.get_mut(&id) else {
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
            let parts = (
                running.e2b_id.clone(),
                std::mem::take(&mut running.children),
            );
            drop(table); // announced under the lock; released right after
            parts
        };
        // Driver-owned task: cancellation of this request can't abandon it.
        let shared = self.shared.clone();
        let task = tokio::spawn(async move {
            let result = lifecycle::delete(&shared.cfg, &id, &e2b_id, children).await;
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
