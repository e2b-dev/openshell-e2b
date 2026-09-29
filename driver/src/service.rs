//! The ComputeDriver gRPC service: the list of questions the gateway can ask us.
//!
//! NVIDIA defines the questions in `proto/compute_driver.proto`. Their build
//! turns that file into a Rust trait (`ComputeDriver`), and we answer each
//! question by implementing one method of it:
//!
//!   gateway asks                      we answer
//!   ──────────────────────────────    ─────────────────────────────────────────
//!   GetCapabilities  "who are you?"   name, version, rules we accept        ✅
//!   ValidateSandboxCreate             "fine"                                ✅
//!   CreateSandbox                     E2B box + fence + runtime + supervisor ✅ (lifecycle.rs)
//!   Get / List / WatchSandboxes       from our in-memory table              ✅
//!   DeleteSandbox                     stop supervisor + tunnel, kill E2B box ✅
//!   Stop / Start                      "not implemented yet"                 ⏳
//!
//! State lives in memory. If the driver restarts, it forgets its sandboxes
//! (the E2B boxes stay tagged with metadata, so they can be found and cleaned).

use crate::lifecycle::{self, Config, Running};
use futures::Stream;
use openshell_core::extension_protocol::{ExtensionFamily, extension_metadata, validate_gateway_metadata};
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
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{Mutex, broadcast};
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use tonic::{Request, Response, Status};

pub const DRIVER_NAME: &str = "e2b";
const IMPLEMENTATION: &str = "sudolabs/openshell-driver-e2b";

pub struct E2bDriver {
    cfg: Config,
    /// OpenShell sandbox id → running sandbox.
    sandboxes: Arc<Mutex<HashMap<String, Running>>>,
    /// Fan-out of changes to every open WatchSandboxes stream.
    events: broadcast::Sender<WatchSandboxesEvent>,
}

impl E2bDriver {
    pub fn new(cfg: Config) -> Self {
        let (events, _) = broadcast::channel(256);
        Self { cfg, sandboxes: Arc::default(), events }
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

    fn announce(&self, payload: Payload) {
        // No listeners is fine: the gateway may not be watching yet.
        let _ = self.events.send(WatchSandboxesEvent { payload: Some(payload) });
    }
}

type WatchStream = Pin<Box<dyn Stream<Item = Result<WatchSandboxesEvent, Status>> + Send + 'static>>;

#[tonic::async_trait]
impl ComputeDriver for E2bDriver {
    async fn get_capabilities(
        &self,
        request: Request<GetCapabilitiesRequest>,
    ) -> Result<Response<GetCapabilitiesResponse>, Status> {
        let caps = self.capabilities();
        validate_gateway_metadata(ExtensionFamily::Compute, DRIVER_NAME, caps.extension.as_ref(), request.into_inner().gateway)
            .map_err(|e| Status::failed_precondition(e.to_string()))?;
        Ok(Response::new(caps))
    }

    async fn authenticate_sandbox(
        &self,
        _request: Request<AuthenticateSandboxRequest>,
    ) -> Result<Response<AuthenticateSandboxResponse>, Status> {
        Err(Status::unimplemented("e2b does not authenticate sandbox credentials"))
    }

    async fn validate_sandbox_create(
        &self,
        request: Request<ValidateSandboxCreateRequest>,
    ) -> Result<Response<ValidateSandboxCreateResponse>, Status> {
        request.into_inner().sandbox.ok_or_else(|| Status::invalid_argument("sandbox is required"))?;
        Ok(Response::new(ValidateSandboxCreateResponse {}))
    }

    async fn get_sandbox(&self, request: Request<GetSandboxRequest>) -> Result<Response<GetSandboxResponse>, Status> {
        let id = request.into_inner().sandbox_id;
        let table = self.sandboxes.lock().await;
        let running = table.get(&id).ok_or_else(|| Status::not_found("sandbox not found"))?;
        Ok(Response::new(GetSandboxResponse { sandbox: Some(running.sandbox.clone()) }))
    }

    async fn list_sandboxes(&self, _request: Request<ListSandboxesRequest>) -> Result<Response<ListSandboxesResponse>, Status> {
        let table = self.sandboxes.lock().await;
        Ok(Response::new(ListSandboxesResponse { sandboxes: table.values().map(|r| r.sandbox.clone()).collect() }))
    }

    async fn create_sandbox(&self, request: Request<CreateSandboxRequest>) -> Result<Response<CreateSandboxResponse>, Status> {
        let sandbox = request.into_inner().sandbox.ok_or_else(|| Status::invalid_argument("sandbox is required"))?;
        let running = lifecycle::create(&self.cfg, &sandbox).await.map_err(Status::internal)?;
        let runtime_identity = running.e2b_id.clone();
        self.announce(Payload::Sandbox(WatchSandboxesSandboxEvent { sandbox: Some(running.sandbox.clone()) }));
        self.sandboxes.lock().await.insert(sandbox.id.clone(), running);
        Ok(Response::new(CreateSandboxResponse { runtime_identity }))
    }

    async fn stop_sandbox(&self, _request: Request<StopSandboxRequest>) -> Result<Response<StopSandboxResponse>, Status> {
        Err(Status::unimplemented("e2b driver: stop not implemented yet"))
    }

    async fn start_sandbox(&self, _request: Request<StartSandboxRequest>) -> Result<Response<StartSandboxResponse>, Status> {
        Err(Status::unimplemented("e2b driver: start not implemented yet"))
    }

    async fn delete_sandbox(&self, request: Request<DeleteSandboxRequest>) -> Result<Response<DeleteSandboxResponse>, Status> {
        let id = request.into_inner().sandbox_id;
        let Some(running) = self.sandboxes.lock().await.remove(&id) else {
            return Ok(Response::new(DeleteSandboxResponse { deleted: false }));
        };
        lifecycle::delete(&self.cfg, running).await;
        self.announce(Payload::Deleted(WatchSandboxesDeletedEvent { sandbox_id: id }));
        Ok(Response::new(DeleteSandboxResponse { deleted: true }))
    }

    type WatchSandboxesStream = WatchStream;

    async fn watch_sandboxes(&self, _request: Request<WatchSandboxesRequest>) -> Result<Response<Self::WatchSandboxesStream>, Status> {
        // First replay what we have, then stream live changes.
        let current: Vec<_> = self
            .sandboxes
            .lock()
            .await
            .values()
            .map(|r| Ok(WatchSandboxesEvent {
                payload: Some(Payload::Sandbox(WatchSandboxesSandboxEvent { sandbox: Some(r.sandbox.clone()) })),
            }))
            .collect();
        let live = BroadcastStream::new(self.events.subscribe()).filter_map(|e| e.ok().map(Ok));
        Ok(Response::new(Box::pin(tokio_stream::iter(current).chain(live))))
    }

    async fn ensure_workspace(&self, _request: Request<EnsureWorkspaceRequest>) -> Result<Response<EnsureWorkspaceResponse>, Status> {
        Ok(Response::new(EnsureWorkspaceResponse::default()))
    }

    async fn delete_workspace(&self, _request: Request<DeleteWorkspaceRequest>) -> Result<Response<DeleteWorkspaceResponse>, Status> {
        Ok(Response::new(DeleteWorkspaceResponse::default()))
    }
}
