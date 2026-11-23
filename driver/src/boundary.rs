//! The two launch descriptors for one sandbox, built with NVIDIA's own types.
//!
//! This module owns the paired `BoundaryConfig` and `SandboxRuntimeDescriptor`
//! and the fence evidence they share; `provision()` is their single point of
//! construction. Other upstream types are used elsewhere too: `lifecycle.rs`
//! decodes the launch authentication, generates the session TLS material,
//! resolves the workload identity and sets the supervisor environment, and
//! `service.rs`, `health.rs` and `main.rs` use the compute-driver protocol
//! types. Expect a breaking upstream release (0.2.0) to touch all of them.
//!
//! Modeled on NVIDIA's Docker driver (`crates/openshell-driver-docker/src/isolation.rs`,
//! Apache-2.0). Same shape, different evidence: Docker proves "the workload
//! container has network mode none"; we prove "the fenced network namespace in
//! the worker VM contains only loopback, and E2B denies the VM all egress".
//!
//!                     E2bBoundarySpec (inputs, one sandbox, one generation)
//!                                       │  .provision()
//!               ┌───────────────────────┴───────────────────────┐
//!               ▼                                               ▼
//!      BoundaryConfig → bootstrap.json             SandboxRuntimeDescriptor → runtime-descriptor.json
//!      read by openshell-sandbox (worker VM B)     read by openshell-supervisor (supervisor VM A)
//!      "dial control.sock, serve TLS with          "listen on 127.0.0.1:17000, accept only
//!       this cert, trust this gateway's keys"       this session's TLS identity"
//!
//! Both come from the same inputs in one call, so they cannot disagree.
//!
//! Connection direction (upstream #4656): the worker's runtime dials the
//! supervisor. In B, `control.sock` is the listening end of a reverse
//! wstunnel that the supervisor VM opened. The network connection still goes
//! from A to B, so B needs no outbound network at all.

use openshell_core::SandboxSessionId;
use openshell_core::jwt::{CredentialEpoch, SessionRotation};
use openshell_isolation_interface::contract::{
    BackendError, ProvisioningEvidence, ResolvedWorkloadIdentity,
};
use openshell_sandbox_backend::boundary_protocol::{
    BoundaryConfig, BoundaryListener, GatewayVerificationKey, SandboxRuntimeDescriptor,
    SandboxTlsClientConfig, SandboxTlsServerConfig, SandboxTransport,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::path::PathBuf;

/// Paths inside the worker VM (created by the workload template).
pub const BOOTSTRAP_PATH: &str = "/.openshell/channel/sandbox/bootstrap.json";
/// The worker's tunnel server (uid 1501) listens here; the runtime (uid 1500)
/// dials it. Its own directory, separate from the runtime's private files.
pub const CONTROL_SOCKET_PATH: &str = "/.openshell/channel/control/control.sock";
pub const SERVER_CERT_PATH: &str = "/.openshell/channel/sandbox/server.crt";
pub const SERVER_KEY_PATH: &str = "/.openshell/channel/sandbox/server.key";

/// Where the supervisor in VM A listens for the worker's runtime.
pub const SUPERVISOR_LISTEN: SocketAddr =
    SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 17000);

/// What the driver observed about the worker's fence. Hashed into the
/// descriptors, so both sides are bound to the same observation.
#[derive(Serialize)]
struct E2bFenceEvidence<'a> {
    e2b_sandbox_id: &'a str,
    network_namespace: &'static str,
    fenced_interfaces: &'a [String],
    /// E2B created the worker with `allowInternetAccess: false`.
    host_egress_denied: bool,
}

impl E2bFenceEvidence<'_> {
    /// Refuse to produce evidence unless every fact holds.
    fn project(&self, generation: &str) -> Result<ProvisioningEvidence, BackendError> {
        if self.e2b_sandbox_id.is_empty()
            || self.fenced_interfaces != ["lo"]
            || !self.host_egress_denied
        {
            return Err(BackendError::Descriptor(
                "E2B fence evidence is incomplete".into(),
            ));
        }
        let encoded = serde_json::to_vec(self)
            .map_err(|e| BackendError::Descriptor(format!("encode E2B fence evidence: {e}")))?;
        let evidence = ProvisioningEvidence::from_enforcement_evidence(generation, &encoded)?;
        evidence.validate(generation)?;
        Ok(evidence)
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
    /// The worker was created with E2B internet access off.
    pub host_egress_denied: bool,
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
        // Resource claims pin both descriptors to this exact VM and template.
        let resource_claims = BTreeMap::from([
            ("e2b.sandbox_id".to_string(), self.e2b_sandbox_id.clone()),
            ("e2b.template".to_string(), self.template.clone()),
        ]);
        let evidence = E2bFenceEvidence {
            e2b_sandbox_id: &self.e2b_sandbox_id,
            network_namespace: "os",
            fenced_interfaces: &self.fenced_interfaces,
            host_egress_denied: self.host_egress_denied,
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
                listener: BoundaryListener::RuntimeInitiatedUnix {
                    socket_path: PathBuf::from(CONTROL_SOCKET_PATH),
                    tls: SandboxTlsServerConfig {
                        certificate_chain_path: PathBuf::from(SERVER_CERT_PATH),
                        private_key_path: PathBuf::from(SERVER_KEY_PATH),
                    },
                },
                resource_claims: resource_claims.clone(),
                resource_claim_files: BTreeMap::new(),
                workload_identity: self.workload_identity.clone(),
                provisioning_evidence: evidence.clone(),
                child_env: self.child_env,
            },
            runtime_descriptor: SandboxRuntimeDescriptor {
                boundary_id: self.boundary_id,
                generation: self.generation,
                session_id: self.session_id,
                workload_identity: self.workload_identity,
                transport: SandboxTransport::RuntimeInitiatedTcp {
                    authority: format!("e2b:{}", self.e2b_sandbox_id),
                    listen_address: SUPERVISOR_LISTEN,
                },
                tls: self.supervisor_tls,
                host_gateway_ip: None,
                resource_claims,
                provisioning_evidence: evidence,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openshell_sandbox_backend::boundary_protocol::generate_sandbox_tls_material;

    fn spec(fenced: &[&str]) -> Result<E2bBoundarySpec, Box<dyn std::error::Error>> {
        spec_with_egress(fenced, true)
    }

    fn spec_with_egress(
        fenced: &[&str],
        host_egress_denied: bool,
    ) -> Result<E2bBoundarySpec, Box<dyn std::error::Error>> {
        let session_id = SandboxSessionId::new();
        let tls = generate_sandbox_tls_material(session_id)?;
        Ok(E2bBoundarySpec {
            boundary_id: "sandbox-1".into(),
            generation: "generation-1".into(),
            session_id,
            session_rotation: SessionRotation::new(1)?,
            auth_epoch: CredentialEpoch::new(1)?,
            gateway_id: "gateway-1".into(),
            verification_keys: vec![GatewayVerificationKey {
                key_id: "key-1".into(),
                public_key_pem: "public-key".into(),
            }],
            e2b_sandbox_id: "e2b-worker".into(),
            template: "openshell-workload".into(),
            fenced_interfaces: fenced.iter().map(ToString::to_string).collect(),
            host_egress_denied,
            supervisor_tls: SandboxTlsClientConfig {
                server_name: tls.server_name,
                trust_anchor_pem: tls.trust_anchor_pem,
            },
            workload_identity: ResolvedWorkloadIdentity::new(
                1500,
                1500,
                Vec::new(),
                "template".into(),
                "e2b-template:openshell-workload".into(),
            )?,
            child_env: HashMap::new(),
        })
    }

    #[test]
    fn both_descriptors_bind_the_same_vm_and_evidence() -> Result<(), Box<dyn std::error::Error>> {
        let provisioned = spec(&["lo"])?.provision()?;
        assert_eq!(
            provisioned.boundary_config.resource_claims,
            provisioned.runtime_descriptor.resource_claims
        );
        assert_eq!(
            provisioned.boundary_config.provisioning_evidence,
            provisioned.runtime_descriptor.provisioning_evidence
        );
        assert!(provisioned.runtime_descriptor.transport.validate().is_ok());
        assert!(matches!(
            provisioned.boundary_config.listener,
            BoundaryListener::RuntimeInitiatedUnix { .. }
        ));
        Ok(())
    }

    #[test]
    fn refuses_a_worker_created_with_internet_access() -> Result<(), Box<dyn std::error::Error>> {
        assert!(spec_with_egress(&["lo"], false)?.provision().is_err());
        Ok(())
    }

    #[test]
    fn refuses_a_fence_with_a_route_out() -> Result<(), Box<dyn std::error::Error>> {
        assert!(spec(&["lo", "eth0"])?.provision().is_err());
        assert!(spec(&[])?.provision().is_err());
        Ok(())
    }
}
