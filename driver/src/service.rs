//! The ComputeDriver gRPC service: the list of questions the gateway can ask us.
//!
//! NVIDIA defines the questions in `proto/compute_driver.proto`. Their build
//! turns that file into a Rust trait (`ComputeDriver`), and we answer each
//! question by implementing one method of it:
//!
//!   gateway asks                      we answer (today)
//!   ──────────────────────────────    ─────────────────────────────────
//!   GetCapabilities  "who are you?"   name, version, rules we accept  ✅
//!   ListSandboxes / WatchSandboxes    "none yet" / quiet stream       ✅
//!   Create / Start / Stop / Delete    "not implemented yet"           ⏳
//!
//! STATUS: skeleton. Enough for the gateway to start and accept CLI
//! connections. Creating real E2B sandboxes comes next.

use futures::Stream;
use openshell_core::extension_protocol::{ExtensionFamily, extension_metadata, validate_gateway_metadata};
use openshell_core::proto::compute::v1::{
    AuthenticateSandboxRequest, AuthenticateSandboxResponse, CreateSandboxRequest,
    CreateSandboxResponse, DeleteSandboxRequest, DeleteSandboxResponse, DeleteWorkspaceRequest,
    DeleteWorkspaceResponse, EnsureWorkspaceRequest, EnsureWorkspaceResponse,
    GetCapabilitiesRequest, GetCapabilitiesResponse, GetSandboxRequest, GetSandboxResponse,
    ListSandboxesRequest, ListSandboxesResponse, StartSandboxRequest, StartSandboxResponse,
    StopSandboxRequest, StopSandboxResponse, ValidateSandboxCreateRequest,
    ValidateSandboxCreateResponse, WatchSandboxesEvent, WatchSandboxesRequest,
    compute_driver_server::ComputeDriver,
};
use openshell_core::resource_admission::{DriverAdmissionConfig, ResourceAdmissionConfig};
use std::pin::Pin;
use tonic::{Request, Response, Status};

pub const DRIVER_NAME: &str = "e2b";
const IMPLEMENTATION: &str = "sudolabs/openshell-driver-e2b";

pub struct E2bDriver {
    template: String,
}

impl E2bDriver {
    pub fn new(template: String) -> Self {
        Self { template }
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
            default_image: self.template.clone(),
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

type WatchStream = Pin<Box<dyn Stream<Item = Result<WatchSandboxesEvent, Status>> + Send + 'static>>;

fn todo<T>(what: &str) -> Result<Response<T>, Status> {
    Err(Status::unimplemented(format!("e2b driver: {what} not implemented yet")))
}

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
        Err(Status::unimplemented("e2b does not authenticate sandbox credentials"))
    }

    async fn validate_sandbox_create(
        &self,
        _request: Request<ValidateSandboxCreateRequest>,
    ) -> Result<Response<ValidateSandboxCreateResponse>, Status> {
        todo("validate_sandbox_create")
    }

    async fn get_sandbox(&self, _request: Request<GetSandboxRequest>) -> Result<Response<GetSandboxResponse>, Status> {
        Err(Status::not_found("sandbox not found"))
    }

    async fn list_sandboxes(
        &self,
        _request: Request<ListSandboxesRequest>,
    ) -> Result<Response<ListSandboxesResponse>, Status> {
        Ok(Response::new(ListSandboxesResponse::default()))
    }

    async fn create_sandbox(&self, _request: Request<CreateSandboxRequest>) -> Result<Response<CreateSandboxResponse>, Status> {
        todo("create_sandbox")
    }

    async fn stop_sandbox(&self, _request: Request<StopSandboxRequest>) -> Result<Response<StopSandboxResponse>, Status> {
        todo("stop_sandbox")
    }

    async fn start_sandbox(&self, _request: Request<StartSandboxRequest>) -> Result<Response<StartSandboxResponse>, Status> {
        todo("start_sandbox")
    }

    async fn delete_sandbox(&self, _request: Request<DeleteSandboxRequest>) -> Result<Response<DeleteSandboxResponse>, Status> {
        todo("delete_sandbox")
    }

    type WatchSandboxesStream = WatchStream;

    async fn watch_sandboxes(
        &self,
        _request: Request<WatchSandboxesRequest>,
    ) -> Result<Response<Self::WatchSandboxesStream>, Status> {
        // No sandboxes yet: an open, silent stream.
        Ok(Response::new(Box::pin(futures::stream::pending())))
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
