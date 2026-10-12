//! Create and delete sandboxes. This is where the pieces meet.
//!
//! CREATE, step by step (numbers match the comments below):
//!
//!   gateway ── CreateSandbox(spec + `launch_authentication`) ──► driver
//!     1  decode the gateway's signed launch authentication
//!     2  create a private E2B box from the openshell-workload template
//!     3  build the fence (netns with only loopback) and check it
//!     4  make this session's TLS cert and both security papers (NVIDIA code)
//!     5  write bootstrap.json + cert + key into the box, owned by uid 1500
//!     6  start openshell-sandbox inside the fence
//!     7  start socat + wstunnel in the box (tunnel 2, server side)
//!     8  start the wstunnel client here (tunnel 2, local end on 127.0.0.1:<port>)
//!     9  start openshell-supervisor here, pointed at that port
//!   gateway ◄── supervisor connects ── sandbox becomes Ready
//!
//! Secrets and where they live:
//!   gateway/sandbox JWTs ........ control box only (supervisor auth bundle, 0600)
//!   E2B API key ................. control box only (driver environment)
//!   traffic access token ........ control box only (wstunnel client header)
//!   agent box ................... session TLS key + gateway PUBLIC keys. No tokens.

use crate::boundary::{self, E2bBoundarySpec};
use crate::e2b::E2b;
use openshell_core::jwt::SandboxLaunchAuthentication;
use openshell_core::proto::compute::v1::{DriverCondition, DriverSandbox, DriverSandboxStatus};
use openshell_core::sandbox_env as env;
use openshell_isolation_interface::contract::ResolvedWorkloadIdentity;
use openshell_sandbox_backend::boundary_protocol::{
    GatewayVerificationKey, SandboxTlsClientConfig, generate_sandbox_tls_material,
};
use rand::RngCore;
use std::collections::HashMap;
use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use tokio::process::{Child, Command};
use tracing::{info, warn};

const WORKLOAD_UID: u32 = 1500;
/// Port inside the agent box that E2B's proxy exposes (tunnel server).
const TUNNEL_PORT: u16 = 9000;
/// socat inside the agent box: TCP 127.0.0.1:7000 → control.sock.
const SOCAT_PORT: u16 = 7000;

/// Everything the driver needs to know about its surroundings.
#[derive(Clone, Debug)]
pub struct Config {
    pub template: String,
    pub e2b: E2b,
    pub supervisor_bin: PathBuf,
    pub wstunnel_bin: PathBuf,
    pub gateway_endpoint: String,
    /// Client cert the supervisor uses to reach the gateway with mutual TLS.
    pub gateway_ca: PathBuf,
    pub gateway_cert: PathBuf,
    pub gateway_key: PathBuf,
    pub state_dir: PathBuf,
    pub owner: String,
}

/// A running sandbox: its `OpenShell` record plus the local helper processes.
pub struct Running {
    pub sandbox: DriverSandbox,
    pub e2b_id: String,
    pub children: Vec<Child>,
    /// A delete is in progress; the record stays visible until E2B confirms.
    pub deleting: bool,
}

/// Why a create failed, and the E2B box it could not roll back (if any), so
/// the caller can keep retrying that kill instead of losing track of it.
pub struct CreateError {
    pub message: String,
    pub leaked_box: Option<String>,
}

impl From<String> for CreateError {
    fn from(message: String) -> Self {
        Self {
            message,
            leaked_box: None,
        }
    }
}

/// Flip Ready to False with a reason. Returns true if anything changed, so the
/// caller only announces real transitions (not the same problem every 5 s).
pub fn mark_not_ready(running: &mut Running, reason: &str, message: &str) -> bool {
    let already = running
        .sandbox
        .status
        .as_ref()
        .and_then(|s| s.conditions.iter().find(|c| c.r#type == "Ready"))
        .is_some_and(|c| c.status == "False" && c.reason == reason);
    if already {
        return false;
    }
    running.sandbox.status = Some(status(message, false, &running.e2b_id, reason));
    true
}

fn status(message: &str, ready: bool, e2b_id: &str, reason: &str) -> DriverSandboxStatus {
    DriverSandboxStatus {
        name: e2b_id.to_string(),
        instance_id: e2b_id.to_string(),
        conditions: vec![DriverCondition {
            r#type: "Ready".into(),
            status: if ready { "True" } else { "False" }.into(),
            reason: reason.into(),
            message: message.into(),
            transition_time: None,
        }],
        ..Default::default()
    }
}

fn free_local_port() -> std::io::Result<SocketAddr> {
    // Ask the OS for a free port, then release it for wstunnel to bind.
    TcpListener::bind("127.0.0.1:0")?.local_addr()
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buf);
    buf.iter()
        .fold(String::with_capacity(bytes * 2), |mut hex, b| {
            use std::fmt::Write;
            let _ = write!(hex, "{b:02x}");
            hex
        })
}

/// Create a 0700 directory, or accept an existing one only if it is a real
/// directory (not a symlink) owned by us and closed to group/others.
pub fn private_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            // SAFETY: geteuid has no preconditions and cannot fail.
            let me = unsafe { libc::geteuid() };
            if !meta.file_type().is_dir() {
                return Err(format!(
                    "{} exists and is not a directory (symlink?)",
                    path.display()
                ));
            }
            if meta.uid() != me {
                return Err(format!(
                    "{} is owned by uid {}, not us ({me})",
                    path.display(),
                    meta.uid()
                ));
            }
            if meta.mode() & 0o077 != 0 {
                return Err(format!(
                    "{} is accessible to other users (mode {:o})",
                    path.display(),
                    meta.mode() & 0o777
                ));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::DirBuilder::new()
            .mode(0o700)
            .create(path)
            .map_err(|e| format!("create {}: {e}", path.display())),
        Err(e) => Err(format!("inspect {}: {e}", path.display())),
    }
}

async fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let shown = path.display().to_string();
    let path = path.to_path_buf();
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        // 0600 from the moment the file exists, and never follow a symlink
        // someone planted where a secret should go (O_NOFOLLOW).
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)?;
        // An existing file keeps its old mode on open; force 0600 either way.
        f.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
        f.write_all(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("write {shown}: {e}"))
}

pub async fn create(cfg: &Config, sandbox: &DriverSandbox) -> Result<Running, CreateError> {
    let spec = sandbox
        .spec
        .as_ref()
        .ok_or_else(|| String::from("sandbox spec is required"))?;

    // 1. The gateway's launch authentication: JWTs for the supervisor, and the
    //    session id + gateway public keys for the sandbox.
    let auth: SandboxLaunchAuthentication = serde_json::from_slice(&spec.launch_authentication)
        .map_err(|e| format!("decode launch authentication: {e}"))?;
    auth.validate()
        .map_err(|e| format!("validate launch authentication: {e}"))?;
    let session_id = auth.supervisor.session_id;
    let generation = auth.supervisor.runtime_generation.to_string();

    // 2. A private E2B box. Metadata lets `list` and cleanup find our boxes.
    let metadata = serde_json::json!({
        "openshell.ai/managed-by": "openshell-e2b",
        "openshell.ai/driver-owner": cfg.owner,
        "openshell.ai/sandbox-id": sandbox.id,
        "openshell.ai/sandbox-name": sandbox.name,
    });
    let boxed = cfg.e2b.create(&cfg.template, metadata).await?;
    let e2b_id = boxed.sandbox_id.clone();
    info!(sandbox = %sandbox.name, e2b = %e2b_id, "E2B box created");

    // From here on, delete the box if anything fails.
    match provision_and_start(cfg, sandbox, &auth, session_id, &generation, &boxed).await {
        Ok(children) => Ok(Running {
            sandbox: DriverSandbox {
                status: Some(status(
                    "OpenShell runtime and supervisor started",
                    true,
                    &e2b_id,
                    "BackendReady",
                )),
                ..sandbox.clone()
            },
            e2b_id,
            children,
            deleting: false,
        }),
        Err(message) => {
            warn!(e2b = %e2b_id, error = %message, "create failed, deleting E2B box");
            let leaked_box = match cfg.e2b.kill(&e2b_id).await {
                Ok(()) => None,
                Err(kill_error) => {
                    tracing::error!(e2b = %e2b_id, error = %kill_error, "rollback failed; will retry the kill");
                    Some(e2b_id)
                }
            };
            Err(CreateError {
                message,
                leaked_box,
            })
        }
    }
}

async fn provision_and_start(
    cfg: &Config,
    sandbox: &DriverSandbox,
    auth: &SandboxLaunchAuthentication,
    session_id: openshell_core::SandboxSessionId,
    generation: &str,
    boxed: &crate::e2b::Created,
) -> Result<Vec<Child>, String> {
    let e2b_id = boxed.sandbox_id.as_str();

    // 3. Build the fence now (idempotent; launch-sandbox.sh checks it again)
    //    and read back what's inside it. That observation is our evidence.
    let fence = cfg
        .e2b
        .run_ok(e2b_id, "ip netns add os 2>/dev/null; ip -n os link set lo up && ip -n os -o link show | awk -F': ' '{print $2}'", "root")
        .await?;
    let fenced_interfaces: Vec<String> = fence
        .stdout
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if fenced_interfaces != ["lo"] {
        return Err(format!(
            "fence check failed: interfaces {fenced_interfaces:?}"
        ));
    }

    // 4. This session's TLS identity + both papers, via NVIDIA's functions.
    let tls = generate_sandbox_tls_material(session_id).map_err(|e| e.to_string())?;
    let verification_keys = auth
        .verification_keys
        .iter()
        .map(|k| {
            Ok(GatewayVerificationKey {
                key_id: k.key_id.clone(),
                public_key_pem: String::from_utf8(k.public_key_pem.clone())
                    .map_err(|e| e.to_string())?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let supervisor_connect = free_local_port().map_err(|e| e.to_string())?;
    let identity = ResolvedWorkloadIdentity::new(
        WORKLOAD_UID,
        WORKLOAD_UID,
        Vec::new(),
        "template".into(),
        format!("e2b-template:{}", cfg.template),
    )
    .map_err(|e| e.to_string())?;
    let papers = E2bBoundarySpec {
        boundary_id: sandbox.id.clone(),
        generation: generation.to_string(),
        session_id,
        session_rotation: auth.supervisor.session_rotation,
        auth_epoch: auth.supervisor.auth_epoch,
        gateway_id: auth.gateway_id.clone(),
        verification_keys,
        e2b_sandbox_id: e2b_id.to_string(),
        template: cfg.template.clone(),
        fenced_interfaces,
        supervisor_connect,
        supervisor_tls: SandboxTlsClientConfig {
            server_name: tls.server_name.clone(),
            trust_anchor_pem: tls.trust_anchor_pem.clone(),
        },
        workload_identity: identity,
        child_env: child_environment(sandbox),
    }
    .provision()
    .map_err(|e| e.to_string())?;

    // 5. Write the agent side's papers, readable only by uid 1500.
    let bootstrap = papers.boundary_config.encode().map_err(|e| e.to_string())?;
    for (path, bytes) in [
        (boundary::BOOTSTRAP_PATH, bootstrap.as_slice()),
        (
            boundary::SERVER_CERT_PATH,
            tls.certificate_chain_pem.as_bytes(),
        ),
        (boundary::SERVER_KEY_PATH, tls.private_key_pem.as_bytes()),
    ] {
        cfg.e2b
            .write(e2b_id, path, bytes, "root", Some(0o600))
            .await?;
    }
    cfg.e2b
        .run_ok(
            e2b_id,
            "chown 1500:1500 /.openshell/channel/sandbox/*",
            "root",
        )
        .await?;

    // 6. Start OpenShell's runtime inside the fence (see launch-sandbox.sh).
    cfg.e2b
        .run_background(
            e2b_id,
            "exec /opt/openshell/launch-sandbox.sh > /tmp/openshell-sandbox.log 2>&1",
            "root",
        )
        .await?;

    // 7. Tunnel 2, server side. socat turns the Unix socket into a local TCP
    //    port; wstunnel exposes only that port, only on a random path.
    let path_secret = random_hex(16);
    cfg.e2b
        .run_background(
            e2b_id,
            &format!(
                "for i in $(seq 50); do [ -S {sock} ] && break; sleep 0.2; done; [ -S {sock} ] || exit 1; \
                 exec socat TCP-LISTEN:{SOCAT_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:{sock} > /tmp/socat.log 2>&1",
                sock = boundary::CONTROL_SOCKET_PATH
            ),
            "root",
        )
        .await?;
    cfg.e2b
        .run_background(
            e2b_id,
            &format!(
                "exec /opt/openshell/wstunnel server ws://0.0.0.0:{TUNNEL_PORT} --restrict-to 127.0.0.1:{SOCAT_PORT} \
                 --restrict-http-upgrade-path-prefix {path_secret} > /tmp/wstunnel.log 2>&1"
            ),
            "root",
        )
        .await?;

    // Local state for this sandbox: supervisor papers (0600) and sockets.
    let dir = cfg.state_dir.join(&sandbox.id);
    private_dir(&dir)?;
    private_dir(&dir.join("proxy-tls"))?;
    let descriptor = papers
        .runtime_descriptor
        .backend_descriptor()
        .map_err(|e| e.to_string())?;
    let descriptor_path = dir.join("runtime-descriptor.json");
    write_private(&descriptor_path, &descriptor.payload).await?;
    let auth_path = dir.join("auth.json");
    let auth_bundle = serde_json::to_vec(&auth.supervisor).map_err(|e| e.to_string())?;
    write_private(&auth_path, &auth_bundle).await?;

    // 8. Tunnel 2, local end. The traffic token rides in a header only we have.
    //    10 s heartbeat: E2B's proxy drops silent connections after about a minute.
    let wstunnel = Command::new(&cfg.wstunnel_bin)
        .args([
            "client",
            "-L",
            &format!("tcp://{supervisor_connect}:127.0.0.1:{SOCAT_PORT}"),
            "--http-upgrade-path-prefix",
            &path_secret,
            "-H",
            &format!("e2b-traffic-access-token: {}", boxed.traffic_access_token),
            "--websocket-ping-frequency",
            "10s",
            // Verify E2B's TLS certificate. wstunnel skips this by default,
            // which would let an interceptor capture the token and path.
            "--tls-verify-certificate",
            &format!("wss://{}", boxed.host9000),
        ])
        .stdout(std::fs::File::create(dir.join("wstunnel.log")).map_err(|e| e.to_string())?)
        .stderr(std::fs::File::create(dir.join("wstunnel.err.log")).map_err(|e| e.to_string())?)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("start wstunnel client: {e}"))?;
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    // 9. NVIDIA's supervisor: policy engine + egress proxy for this sandbox.
    let main_process_spec = env::MainProcessConfig::encode_driver_spec(sandbox.spec.as_ref())
        .map_err(|e| e.to_string())?;
    let supervisor = Command::new(&cfg.supervisor_bin)
        .arg("--backend-descriptor-file")
        .arg(&descriptor_path)
        .arg("--auth-bundle-file")
        .arg(&auth_path)
        .args(["--workdir", "/sandbox"])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env(
            env::ADMITTED_ISOLATION_BACKEND,
            openshell_sandbox_backend::BACKEND_NAME,
        )
        .env(env::MAIN_PROCESS_SPEC, main_process_spec)
        .env(env::ENDPOINT, &cfg.gateway_endpoint)
        .env(env::SANDBOX_ID, &sandbox.id)
        .env(env::SANDBOX, &sandbox.name)
        .env(env::SSH_SOCKET_PATH, dir.join("ssh.sock"))
        .env(env::PROXY_TLS_DIR, dir.join("proxy-tls"))
        .env(
            env::NETWORK_RUNTIME_CAPABILITIES,
            env::POLICY_DNS_TRANSPARENT_TCP_CAPABILITY,
        )
        .env(env::LOG_LEVEL, "info")
        .env(env::TELEMETRY_ENABLED, "false")
        .env(env::TLS_CA, &cfg.gateway_ca)
        .env(env::TLS_CERT, &cfg.gateway_cert)
        .env(env::TLS_KEY, &cfg.gateway_key)
        .stdout(std::fs::File::create(dir.join("supervisor.log")).map_err(|e| e.to_string())?)
        .stderr(std::fs::File::create(dir.join("supervisor.err.log")).map_err(|e| e.to_string())?)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("start supervisor: {e}"))?;
    info!(sandbox = %sandbox.name, e2b = %e2b_id, port = %supervisor_connect, "supervisor started");

    Ok(vec![wstunnel, supervisor])
}

/// User environment for the agent, minus names `OpenShell` reserves for itself
/// (same protected list as NVIDIA's Docker driver).
fn child_environment(sandbox: &DriverSandbox) -> HashMap<String, String> {
    let mut vars = sandbox
        .spec
        .as_ref()
        .and_then(|s| s.template.as_ref())
        .map(|t| t.environment.clone())
        .unwrap_or_default();
    if let Some(spec) = sandbox.spec.as_ref() {
        vars.extend(spec.environment.clone());
    }
    vars.retain(|k, _| !k.starts_with("OPENSHELL_"));
    vars
}

/// Stop the local processes and kill the E2B box. Returns an error if E2B
/// didn't confirm, so the caller keeps the record and the delete can be retried.
pub async fn delete(
    cfg: &Config,
    sandbox_id: &str,
    e2b_id: &str,
    mut children: Vec<Child>,
) -> Result<(), String> {
    for child in &mut children {
        let _ = child.kill().await;
    }
    cfg.e2b.kill(e2b_id).await?;
    let _ = tokio::fs::remove_dir_all(cfg.state_dir.join(sandbox_id)).await;
    info!(sandbox_id, e2b = %e2b_id, "deleted");
    Ok(())
}

/// Requests this driver cannot honour. Rejected up front rather than silently
/// replaced with defaults: every agent box runs the one configured template,
/// as uid/gid 1500, without user namespaces.
pub fn check_supported(cfg: &Config, sandbox: &DriverSandbox) -> Result<(), String> {
    check_identity(sandbox)?;
    let Some(template) = sandbox.spec.as_ref().and_then(|s| s.template.as_ref()) else {
        return Ok(());
    };
    if !template.image.is_empty() && template.image != cfg.template {
        return Err(format!(
            "image '{}' is not supported; this driver runs E2B template '{}'",
            template.image, cfg.template
        ));
    }
    if template.user_namespaces == Some(true) {
        return Err("user namespaces are not supported by the e2b driver".into());
    }
    Ok(())
}

/// The agent always runs as uid/gid 1500 ("sandbox" in the workload template).
/// A request for any other user or group is rejected, not silently replaced.
fn check_identity(sandbox: &DriverSandbox) -> Result<(), String> {
    const ACCEPTED: [&str; 3] = ["", "sandbox", "1500"];
    let Some(identity) = sandbox
        .spec
        .as_ref()
        .and_then(|s| s.workload_identity.as_ref())
    else {
        return Ok(());
    };
    for (kind, selector) in [("user", &identity.user), ("group", &identity.group)] {
        if !ACCEPTED.contains(&selector.as_str()) {
            return Err(format!(
                "workload {kind} '{selector}' is not supported; the e2b driver runs the agent as sandbox (1500)"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::private_dir;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("osd-e2b-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&dir);
        dir
    }

    #[test]
    fn creates_new_dir_as_0700() {
        let dir = scratch("new");
        assert!(private_dir(&dir).is_ok());
        assert_eq!(
            std::fs::metadata(&dir).map(|m| m.mode() & 0o777).ok(),
            Some(0o700)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_dir_open_to_others() {
        let dir = scratch("open");
        std::fs::create_dir(&dir).ok();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).ok();
        assert!(private_dir(&dir).is_err_and(|e| e.contains("accessible to other users")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_symlink() {
        let target = scratch("target");
        let link = scratch("link");
        std::fs::create_dir(&target).ok();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).ok();
        std::os::unix::fs::symlink(&target, &link).ok();
        assert!(private_dir(&link).is_err_and(|e| e.contains("not a directory")));
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&target);
    }
}
