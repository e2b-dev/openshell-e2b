//! The two "security papers" for one sandbox, built with NVIDIA's own types.
//!
//! Modeled on NVIDIA's Docker driver (crates/openshell-driver-docker/src/isolation.rs,
//! Apache-2.0). Same shape, different evidence: instead of "Docker network mode
//! is none" we prove "the fenced network namespace contains only loopback".
//!
//!                         E2bBoundarySpec (inputs, one sandbox, one generation)
//!                                       │  .provision()
//!               ┌───────────────────────┴───────────────────────┐
//!               ▼                                               ▼
//!      BoundaryConfig  → bootstrap.json               SandboxRuntimeDescriptor → runtime-descriptor.json
//!      read by openshell-sandbox (agent box)          read by openshell-supervisor (control box)
//!      "listen on control.sock with this TLS cert,    "connect to 127.0.0.1:<port>, trust only
//!       accept only this gateway's keys"               this session's CA, expect this fence"
//!
//! Both are produced from the same inputs in one call, so they can't disagree.

use openshell_core::SandboxSessionId;
use openshell_core::jwt::{CredentialEpoch, SessionRotation};
use openshell_isolation_interface::contract::{
    BackendError, OuterFenceGuarantee, OuterFenceGuarantees, ResolvedWorkloadIdentity,
};
use openshell_sandbox_backend::boundary_protocol::{
    BoundaryConfig, BoundaryListener, GatewayVerificationKey, SandboxRuntimeDescriptor,
    SandboxTlsClientConfig, SandboxTlsServerConfig, SandboxTransport,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::path::PathBuf;

/// Paths inside the agent box (created by the openshell-workload template).
pub const BOOTSTRAP_PATH: &str = "/.openshell/channel/sandbox/bootstrap.json";
pub const CONTROL_SOCKET_PATH: &str = "/.openshell/channel/sandbox/control.sock";
pub const SERVER_CERT_PATH: &str = "/.openshell/channel/sandbox/server.crt";
pub const SERVER_KEY_PATH: &str = "/.openshell/channel/sandbox/server.key";

/// What we observed about the fence, fingerprinted into the papers.
/// launch-sandbox.sh refuses to start unless `fenced_interfaces` is exactly ["lo"].
#[derive(Serialize)]
struct E2bOuterFenceEvidence<'a> {
    e2b_sandbox_id: &'a str,
    network_namespace: &'static str,
    fenced_interfaces: &'a [String],
    public_traffic: bool,
}

impl E2bOuterFenceEvidence<'_> {
    /// Turn observed facts into OpenShell's four fence guarantees. Each
    /// guarantee is only claimed if the matching fact holds.
    fn project(&self, generation: &str) -> Result<OuterFenceGuarantees, BackendError> {
        if self.e2b_sandbox_id.is_empty() {
            return Err(BackendError::Descriptor("E2B fence evidence is incomplete".into()));
        }
        let mut established = Vec::new();
        if self.fenced_interfaces == ["lo".to_string()] {
            // Loopback only: packets have nowhere to go, even if the supervisor
            // dies or access is revoked.
            established.extend([
                OuterFenceGuarantee::DefaultDenyEgress,
                OuterFenceGuarantee::RevocationVerified,
                OuterFenceGuarantee::ControllerLossFailsClosed,
                OuterFenceGuarantee::NoUnmanagedEgressPath,
            ]);
        }
        let encoded = serde_json::to_vec(self)
            .map_err(|e| BackendError::Descriptor(format!("encode E2B fence evidence: {e}")))?;
        let projection = OuterFenceGuarantees::from_enforcement_evidence(generation, established, &encoded)?;
        projection.validate(generation)?;
        Ok(projection)
    }
}

pub struct E2bBoundarySpec {
    pub boundary_id: String,
    pub generation: String,
    pub session_id: SandboxSessionId,
    pub session_rotation: SessionRotation,
    pub auth_epoch: CredentialEpoch,
    pub gateway_id: String,
    pub verification_keys: Vec<GatewayVerificationKey>,
    pub e2b_sandbox_id: String,
    pub template: String,
    pub fenced_interfaces: Vec<String>,
    /// Local end of tunnel 2 in the control box; the supervisor connects here.
    pub supervisor_connect: SocketAddr,
    pub supervisor_tls: SandboxTlsClientConfig,
    pub workload_identity: ResolvedWorkloadIdentity,
    pub child_env: HashMap<String, String>,
}

pub struct Provisioned {
    pub boundary_config: BoundaryConfig,
    pub runtime_descriptor: SandboxRuntimeDescriptor,
}

impl E2bBoundarySpec {
    pub fn provision(self) -> Result<Provisioned, BackendError> {
        // Resource claims pin the papers to this exact E2B box and template.
        let resource_claims = BTreeMap::from([
            ("e2b.sandbox_id".to_string(), self.e2b_sandbox_id.clone()),
            ("e2b.template".to_string(), self.template.clone()),
        ]);
        let outer_fence = E2bOuterFenceEvidence {
            e2b_sandbox_id: &self.e2b_sandbox_id,
            network_namespace: "os",
            fenced_interfaces: &self.fenced_interfaces,
            public_traffic: false,
        }
        .project(&self.generation)?;

        Ok(Provisioned {
            boundary_config: BoundaryConfig {
                boundary_id: self.boundary_id.clone(),
                generation: self.generation.clone(),
                session_id: self.session_id,
                session_rotation: self.session_rotation,
                auth_epoch: self.auth_epoch,
                gateway_id: self.gateway_id,
                verification_keys: self.verification_keys,
                // The agent side listens on a Unix socket inside its box.
                // socat + wstunnel carry it to the supervisor.
                listener: BoundaryListener::Unix {
                    socket_path: PathBuf::from(CONTROL_SOCKET_PATH),
                    tls: SandboxTlsServerConfig {
                        certificate_chain_path: PathBuf::from(SERVER_CERT_PATH),
                        private_key_path: PathBuf::from(SERVER_KEY_PATH),
                    },
                },
                resource_claims: resource_claims.clone(),
                resource_claim_files: BTreeMap::new(),
                workload_identity: self.workload_identity.clone(),
                outer_fence: outer_fence.clone(),
                child_env: self.child_env,
            },
            runtime_descriptor: SandboxRuntimeDescriptor {
                boundary_id: self.boundary_id,
                generation: self.generation,
                session_id: self.session_id,
                workload_identity: self.workload_identity,
                // The supervisor reaches the agent box via the local tunnel port.
                transport: SandboxTransport::Tcp {
                    authority: format!("e2b:{}", self.e2b_sandbox_id),
                    addresses: vec![self.supervisor_connect],
                },
                tls: self.supervisor_tls,
                host_gateway_ip: None,
                resource_claims,
                outer_fence,
            },
        })
    }
}
