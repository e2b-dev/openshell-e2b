//! One task = a supervisor microVM (A) plus a worker microVM (B).
//!
//! The shared gateway and this driver own both lifecycles; no task process runs
//! in the control VM. E2B denies B all egress outside the guest. `OpenShell`
//! keeps its runtime fence and session-authenticated channel inside that.
//!
//!   A: supervisor ── listens 127.0.0.1:17000 ◄── wstunnel client ══ wss ══╗
//!      wstunnel client ══ wss ══► control VM :9000 → gateway             ║
//!   B: wstunnel server :9000 (reverse, one Unix socket only) ◄════════════╝
//!      └─ control.sock ◄── openshell-sandbox dials (runtime-initiated)

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
use std::path::{Path, PathBuf};
use tokio::sync::watch;

use tracing::{info, warn};

const WORKLOAD_UID: u32 = 1500;
/// The worker's tunnel server runs as its own user (workload template).
const TUNNEL_UID: u32 = 1501;
/// Port inside the worker VM that E2B's proxy exposes (tunnel server).
const TUNNEL_PORT: u16 = 9000;
/// Task state in the supervisor VM.
const DIR: &str = "/run/openshell-task";
/// Tunnel server state in the worker VM: rules and log. Root-owned; the
/// tunnel user can only read the rules, the workload user cannot see either.
const TUNNEL_DIR: &str = "/run/openshell-tunnel";

/// Everything the driver needs to know about its surroundings.
#[derive(Clone, Debug)]
pub struct Config {
    pub template: String,
    pub e2b: E2b,
    pub supervisor_template: String,
    pub gateway_tunnel: PathBuf,
    pub gateway_endpoint: String,
    /// CA that signed the gateway's server certificate. Supervisors verify the
    /// gateway with it and authenticate with their own launch JWT; they hold
    /// no client certificate.
    pub gateway_ca: PathBuf,
    pub owner: String,
}

/// Both microVMs belong to exactly one `OpenShell` sandbox.
pub struct Running {
    pub sandbox: DriverSandbox,
    pub e2b_id: String,
    pub supervisor_id: String,
    /// A delete is in progress; the record stays visible until E2B confirms.
    pub deleting: bool,
}

/// Why a create failed, and what its rollback left: boxes it could not kill
/// (the caller keeps retrying those), how many it did remove, and whether
/// VMs that only E2B knows about may still exist (a create call failed after
/// E2B may have allocated the VM).
pub struct CreateError {
    pub message: String,
    pub leaked_boxes: Vec<String>,
    pub removed: usize,
    pub sweep_pending: bool,
}

impl From<String> for CreateError {
    fn from(message: String) -> Self {
        Self {
            message,
            leaked_boxes: Vec::new(),
            removed: 0,
            sweep_pending: false,
        }
    }
}

/// VM ids a create owns, recorded the moment E2B returns each one. Shared
/// with the driver task that awaits the create, so a panic mid-create still
/// leaves a list of what to roll back.
#[derive(Clone, Default)]
pub struct Allocations(std::sync::Arc<std::sync::Mutex<Vec<String>>>);

impl Allocations {
    pub(crate) fn record(&self, id: &str) {
        if let Ok(mut ids) = self.0.lock() {
            ids.push(id.to_owned());
        }
    }

    /// Ids recorded so far (a poisoned lock still yields its contents).
    pub fn snapshot(&self) -> Vec<String> {
        match self.0.lock() {
            Ok(ids) => ids.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }
}

/// Leaked-set key for "VMs of this sandbox may exist that we have no id for".
const SWEEP_PREFIX: &str = "sweep:";

pub fn sweep_key(sandbox_id: &str) -> String {
    format!("{SWEEP_PREFIX}{sandbox_id}")
}

/// Kill every VM this driver tagged with `sandbox_id`. Returns how many E2B
/// removed; an error means the lookup or a kill failed and must be retried.
pub async fn sweep(cfg: &Config, sandbox_id: &str) -> Result<usize, String> {
    let ids = cfg
        .e2b
        .list_ids_matching(serde_json::json!({
            "openshell.ai/driver-owner": cfg.owner,
            "openshell.ai/sandbox-id": sandbox_id,
        }))
        .await?;
    let mut removed = 0;
    for id in ids {
        if cfg.e2b.kill_reporting(&id).await? {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Retry one leaked-set entry: a VM id, or a sweep key.
pub async fn retry_cleanup(cfg: &Config, key: &str) -> Result<(), String> {
    match key.strip_prefix(SWEEP_PREFIX) {
        Some(sandbox_id) => sweep(cfg, sandbox_id).await.map(|_| ()),
        None => cfg.e2b.kill(key).await,
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

/// Create and start one task pair. `cancel` (delete or shutdown) stops it at
/// the next step and rolls back whatever it allocated.
pub async fn create(
    cfg: &Config,
    sandbox: &DriverSandbox,
    cancel: watch::Receiver<bool>,
    allocations: &Allocations,
) -> Result<Running, CreateError> {
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

    let metadata = |role: &str| {
        serde_json::json!({
            "openshell.ai/managed-by": "openshell-e2b",
            "openshell.ai/driver-owner": cfg.owner,
            "openshell.ai/sandbox-id": sandbox.id,
            "openshell.ai/sandbox-name": sandbox.name,
            "openshell.ai/role": role,
        })
    };
    let (worker, supervisor) = allocate_pair(
        cfg,
        &sandbox.id,
        [metadata("worker"), metadata("supervisor")],
        cancel.clone(),
        allocations,
    )
    .await?;
    info!(sandbox = %sandbox.name, worker = %worker.sandbox_id, supervisor = %supervisor.sandbox_id, "E2B task pair created");
    run_or_roll_back(
        cfg,
        &[&supervisor.sandbox_id, &worker.sandbox_id],
        cancel,
        provision_and_start(
            cfg,
            sandbox,
            &auth,
            session_id,
            &generation,
            &worker,
            &supervisor,
        ),
    )
    .await?;
    Ok(Running {
        sandbox: DriverSandbox {
            status: Some(status(
                "Separate supervisor and worker started",
                true,
                &worker.sandbox_id,
                "BackendReady",
            )),
            ..sandbox.clone()
        },
        e2b_id: worker.sandbox_id,
        supervisor_id: supervisor.sandbox_id,
        deleting: false,
    })
}

const CANCELLED: &str = "create cancelled (sandbox deleted or driver stopping)";

/// Create B first, then A. A failure or a cancel after either create kills
/// what exists. An E2B create already in flight is never abandoned: its VM
/// id would be lost.
async fn allocate_pair(
    cfg: &Config,
    sandbox_id: &str,
    [worker_metadata, supervisor_metadata]: [serde_json::Value; 2],
    cancel: watch::Receiver<bool>,
    allocations: &Allocations,
) -> Result<(crate::e2b::Created, crate::e2b::Created), CreateError> {
    // Already cancelled (e.g. shutdown began): allocate nothing.
    if *cancel.borrow() {
        return Err(CANCELLED.to_owned().into());
    }
    let worker = match cfg.e2b.create(&cfg.template, worker_metadata, false).await {
        Ok(created) => created,
        Err(message) => return Err(after_failed_create(cfg, sandbox_id, message, &[]).await),
    };
    allocations.record(&worker.sandbox_id);
    if *cancel.borrow() {
        return Err(rollback(cfg, CANCELLED.into(), &[&worker.sandbox_id]).await);
    }
    let supervisor = match cfg
        .e2b
        .create(&cfg.supervisor_template, supervisor_metadata, true)
        .await
    {
        Ok(created) => created,
        Err(message) => {
            return Err(after_failed_create(cfg, sandbox_id, message, &[&worker.sandbox_id]).await);
        }
    };
    allocations.record(&supervisor.sandbox_id);
    if *cancel.borrow() {
        let ids = [supervisor.sandbox_id.as_str(), worker.sandbox_id.as_str()];
        return Err(rollback(cfg, CANCELLED.into(), &ids).await);
    }
    Ok((worker, supervisor))
}

/// An E2B create call failed. E2B may still have allocated the VM (a lost or
/// malformed reply), so besides the known ids, remove anything tagged with
/// this sandbox. If that lookup fails, the sweep stays pending.
async fn after_failed_create(
    cfg: &Config,
    sandbox_id: &str,
    message: String,
    known: &[&str],
) -> CreateError {
    let mut error = rollback(cfg, message, known).await;
    match sweep(cfg, sandbox_id).await {
        Ok(removed) => error.removed += removed,
        Err(sweep_error) => {
            warn!(sandbox_id, %sweep_error, "sweep after a failed create failed; health monitor will retry");
            error.sweep_pending = true;
        }
    }
    error
}

/// Run `work` until it finishes or `cancel` fires. On an error or a cancel,
/// kill `ids`. Dropping `work` mid-way is safe: every VM it touches is in `ids`.
async fn run_or_roll_back(
    cfg: &Config,
    ids: &[&str],
    mut cancel: watch::Receiver<bool>,
    work: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), CreateError> {
    let cancelled = async {
        // A dropped sender means nobody can cancel any more.
        if cancel.wait_for(|c| *c).await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    let outcome = tokio::select! {
        result = work => result,
        () = cancelled => Err(CANCELLED.into()),
    };
    match outcome {
        Ok(()) => Ok(()),
        Err(message) => Err(rollback(cfg, message, ids).await),
    }
}

/// Kill every VM at once, so one stalled kill cannot hold back the others.
pub async fn rollback(cfg: &Config, message: String, ids: &[&str]) -> CreateError {
    let results = futures::future::join_all(ids.iter().map(|id| cfg.e2b.kill_reporting(id))).await;
    let mut leaked_boxes = Vec::new();
    let mut removed = 0;
    for (id, result) in ids.iter().zip(results) {
        match result {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(error) => {
                warn!(e2b = %id, %error, "rollback failed; health monitor will retry");
                leaked_boxes.push((*id).to_owned());
            }
        }
    }
    CreateError {
        message,
        leaked_boxes,
        removed,
        sweep_pending: false,
    }
}

async fn provision_and_start(
    cfg: &Config,
    sandbox: &DriverSandbox,
    auth: &SandboxLaunchAuthentication,
    session_id: openshell_core::SandboxSessionId,
    generation: &str,
    boxed: &crate::e2b::Created,
    supervisor_box: &crate::e2b::Created,
) -> Result<(), String> {
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
        host_egress_denied: !boxed.allow_internet_access,
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

    // 7. The worker side of the control channel. The supervisor VM opens a
    //    reverse tunnel to this server; the server then listens on
    //    control.sock, which the runtime dials. Only that one reverse Unix
    //    socket, only behind the random path.
    //    The server runs as its own uid 1501, so the workload uid can neither
    //    change its rules (wstunnel reloads them) nor signal it. The socket
    //    directory is 1501:1500 mode 2710 (workload template): with umask
    //    0007 the socket is group 1500, which lets the runtime connect.
    let path_secret = random_hex(16);
    let rules = tunnel_rules(&path_secret);
    cfg.e2b
        .run_ok(
            e2b_id,
            &format!("install -d -m 0750 -o root -g {TUNNEL_UID} {TUNNEL_DIR}"),
            "root",
        )
        .await?;
    cfg.e2b
        .write(
            e2b_id,
            &format!("{TUNNEL_DIR}/rules.yaml"),
            rules.as_bytes(),
            "root",
            Some(0o640),
        )
        .await?;
    cfg.e2b
        .run_ok(
            e2b_id,
            &format!("chown root:{TUNNEL_UID} {TUNNEL_DIR}/rules.yaml"),
            "root",
        )
        .await?;
    cfg.e2b
        .run_background(
            e2b_id,
            &format!(
                "exec setpriv --reuid={TUNNEL_UID} --regid={TUNNEL_UID} --clear-groups --no-new-privs \
                 sh -c 'umask 0007; exec /opt/openshell/wstunnel server ws://0.0.0.0:{TUNNEL_PORT} \
                 --restrict-config {TUNNEL_DIR}/rules.yaml' > {TUNNEL_DIR}/wstunnel.log 2>&1"
            ),
            "root",
        )
        .await?;
    // It runs in the background: confirm it is up (a bad rules file exits it).
    cfg.e2b
        .run_ok(
            e2b_id,
            &format!(
                "for i in $(seq 50); do ss -ltn | grep -q ':{TUNNEL_PORT} ' && exit 0; sleep 0.2; done; \
                 tail -5 {TUNNEL_DIR}/wstunnel.log >&2; exit 1"
            ),
            "root",
        )
        .await?;

    // All task-specific supervisor state is written into A, never the control VM.
    let supervisor_id = &supervisor_box.sandbox_id;
    cfg.e2b
        .run_ok(
            supervisor_id,
            "install -d -m 0700 /run/openshell-task /run/openshell-task/proxy-tls /sandbox",
            "root",
        )
        .await?;
    let descriptor = papers
        .runtime_descriptor
        .backend_descriptor()
        .map_err(|e| e.to_string())?;
    let auth_bundle = serde_json::to_vec(&auth.supervisor).map_err(|e| e.to_string())?;
    for (name, bytes) in [
        ("runtime-descriptor.json", descriptor.payload),
        ("auth.json", auth_bundle),
        (
            "gateway-ca.crt",
            tokio::fs::read(&cfg.gateway_ca)
                .await
                .map_err(|e| e.to_string())?,
        ),
    ] {
        cfg.e2b
            .write(
                supervisor_id,
                &format!("{DIR}/{name}"),
                &bytes,
                "root",
                Some(0o600),
            )
            .await?;
    }
    let gateway: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(&cfg.gateway_tunnel)
            .await
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("gateway tunnel config: {e}"))?;
    let main_process_spec = env::MainProcessConfig::encode_driver_spec(sandbox.spec.as_ref())
        .map_err(|e| e.to_string())?;
    let environment = HashMap::from([
        ("PATH", "/usr/local/bin:/usr/bin:/bin".to_owned()),
        (
            env::ADMITTED_ISOLATION_BACKEND,
            openshell_sandbox_backend::BACKEND_NAME.to_owned(),
        ),
        (env::MAIN_PROCESS_SPEC, main_process_spec),
        (env::ENDPOINT, cfg.gateway_endpoint.clone()),
        (env::SANDBOX_ID, sandbox.id.clone()),
        (env::SANDBOX, sandbox.name.clone()),
        (env::SSH_SOCKET_PATH, format!("{DIR}/ssh.sock")),
        (env::PROXY_TLS_DIR, format!("{DIR}/proxy-tls")),
        (
            env::NETWORK_RUNTIME_CAPABILITIES,
            env::POLICY_DNS_TRANSPARENT_TCP_CAPABILITY.to_owned(),
        ),
        (env::LOG_LEVEL, "info".to_owned()),
        (env::TELEMETRY_ENABLED, "false".to_owned()),
        (env::TLS_CA, format!("{DIR}/gateway-ca.crt")),
    ]);
    let config = serde_json::json!({
        "worker": {
            "host": boxed.host9000,
            "token": boxed.traffic_access_token,
            "path": path_secret,
            "socket": boundary::CONTROL_SOCKET_PATH,
            "listen": boundary::SUPERVISOR_LISTEN.to_string(),
        },
        "gateway": gateway,
        "environment": environment,
    });
    cfg.e2b
        .write(
            supervisor_id,
            &format!("{DIR}/config.json"),
            &serde_json::to_vec(&config).map_err(|e| e.to_string())?,
            "root",
            Some(0o600),
        )
        .await?;
    cfg.e2b
        .run_background(
            supervisor_id,
            "exec /opt/openshell/launch-supervisor.py > /run/openshell-task/launcher.log 2>&1",
            "root",
        )
        .await?;
    cfg.e2b.run_ok(supervisor_id, "for i in $(seq 300); do test -f /run/openshell-task/ready && exit 0; test -f /run/openshell-task/failed && exit 1; sleep 0.2; done; exit 1", "root").await?;
    info!(sandbox = %sandbox.name, worker = %e2b_id, supervisor = %supervisor_id, "separate supervisor started");
    Ok(())
}

/// wstunnel server rules for the worker VM: deny everything except one
/// reverse tunnel that listens on the runtime's control socket, and only for
/// clients that know this task's random path.
fn tunnel_rules(path_secret: &str) -> String {
    let socket = boundary::CONTROL_SOCKET_PATH.replace('.', "\\.");
    [
        "restrictions:".to_owned(),
        "  - name: openshell-control".to_owned(),
        "    match:".to_owned(),
        // Single-quoted YAML: backslashes in the regex stay literal.
        format!("      - !PathPrefix '^{path_secret}$'"),
        "    allow:".to_owned(),
        "      - !ReverseTunnel".to_owned(),
        "        protocol: [Unix]".to_owned(),
        format!("        unix_path: '^{socket}$'"),
        String::new(),
    ]
    .join("\n")
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

/// Attempt both deletes even if one fails. Retain the record for safe retry.
/// Returns how many of the two E2B actually removed.
pub async fn delete(
    cfg: &Config,
    sandbox_id: &str,
    worker: &str,
    supervisor: &str,
) -> Result<usize, String> {
    let results: [Result<bool, String>; 2] = tokio::join!(
        cfg.e2b.kill_reporting(supervisor),
        cfg.e2b.kill_reporting(worker)
    )
    .into();
    let mut removed = 0;
    let mut failures = Vec::new();
    for result in results {
        match result {
            Ok(true) => removed += 1,
            Ok(false) => {}
            Err(error) => failures.push(error),
        }
    }
    if !failures.is_empty() {
        return Err(failures.join("; "));
    }
    info!(sandbox_id, worker, supervisor, "task pair deleted");
    Ok(removed)
}

/// Requests this driver cannot honour. Rejected up front rather than silently
/// replaced with defaults: every agent box runs the one configured template,
/// as uid/gid 1500, without user namespaces.
pub fn check_supported(cfg: &Config, sandbox: &DriverSandbox) -> Result<(), String> {
    check_identity(sandbox)?;
    // We do not advertise `openshell.compute.isolation-backend`; never fall
    // back to the built-in runtime when an operator selected another one.
    if sandbox
        .spec
        .as_ref()
        .is_some_and(|s| s.isolation_backend.is_some())
    {
        return Err("external isolation backends are not supported by the e2b driver".into());
    }
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
pub mod tests {
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
    /// A Config whose E2B helper is a Python fake that logs every call to
    /// calls.jsonl. Special inputs: sandboxId "unreachable" fails, "stalled"
    /// kills after 3 s; template "slow" creates after 1 s, "lost" reports an
    /// error after E2B "allocated" lost-vm; list returns listed.json and fails
    /// while list-fails exists; a `run` of "sleep" records its pid and sleeps.
    pub fn fake_config(
        name: &str,
    ) -> Result<(super::Config, std::path::PathBuf), Box<dyn std::error::Error>> {
        let dir = scratch(name);
        std::fs::create_dir(&dir)?;
        let helper = dir.join("helper.py");
        std::fs::write(
            &helper,
            r"
import json, pathlib, sys
req = json.load(sys.stdin)
root = pathlib.Path(__file__).parent
with (root / 'calls.jsonl').open('a') as f:
    f.write(json.dumps({'op': sys.argv[1], **req}) + '\n')
import os, time
op = sys.argv[1]
if req.get('sandboxId') == 'unreachable':
    print(json.dumps({'ok': False, 'error': 'injected API failure'}))
elif req.get('sandboxId') == 'stalled':
    time.sleep(3)
    print(json.dumps({'ok': True, 'killed': True}))
elif op == 'create' and req['template'] == 'lost':
    print(json.dumps({'ok': False, 'error': 'reply lost after allocation'}))
elif op == 'create':
    if req['template'] == 'slow':
        time.sleep(1)
    sid = req['template'] + '-vm'
    print(json.dumps({'ok': True, 'sandboxId': sid, 'trafficAccessToken': 't', 'host9000': 'h',
                      'allowInternetAccess': req.get('allowInternetAccess', False)}))
elif op == 'list':
    if (root / 'list-fails').exists():
        print(json.dumps({'ok': False, 'error': 'list unavailable'}))
    else:
        listed = root / 'listed.json'
        print(json.dumps({'ok': True, 'sandboxes': json.loads(listed.read_text()) if listed.exists() else []}))
elif op == 'run' and req.get('cmd') == 'sleep':
    (root / 'run.pid').write_text(str(os.getpid()))
    time.sleep(30)
    print(json.dumps({'ok': True, 'exitCode': 0, 'stdout': '', 'stderr': ''}))
else:
    print(json.dumps({'ok': True, 'killed': True}))
",
        )?;
        let cfg = super::Config {
            template: "worker".into(),
            supervisor_template: "supervisor".into(),
            e2b: crate::e2b::E2b {
                node: "python3".into(),
                helper,
            },
            gateway_tunnel: dir.join("gateway.json"),
            gateway_endpoint: "https://localhost:17670".into(),
            gateway_ca: dir.join("ca"),
            owner: "test-owner".into(),
        };
        Ok((cfg, dir))
    }

    #[test]
    fn tunnel_rules_allow_only_the_control_socket() {
        let rules = super::tunnel_rules("abc123");
        assert!(rules.contains("!PathPrefix '^abc123$'"));
        assert!(rules.contains("protocol: [Unix]"));
        assert!(rules.contains(r"unix_path: '^/\.openshell/channel/control/control\.sock$'"));
        assert!(!rules.contains("!Tunnel"));
    }

    #[tokio::test]
    async fn delete_attempts_worker_even_when_supervisor_delete_fails()
    -> Result<(), Box<dyn std::error::Error>> {
        let (cfg, dir) = fake_config("delete-pair")?;
        assert!(
            super::delete(&cfg, "task", "worker", "unreachable")
                .await
                .is_err()
        );
        let calls = std::fs::read_to_string(dir.join("calls.jsonl"))?;
        assert_eq!(calls.lines().count(), 2);
        assert!(calls.contains("worker") && calls.contains("unreachable"));
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    fn kills(dir: &std::path::Path) -> Result<Vec<String>, Box<dyn std::error::Error>> {
        Ok(std::fs::read_to_string(dir.join("calls.jsonl"))?
            .lines()
            .filter(|l| l.contains(r#""op": "kill""#))
            .map(str::to_owned)
            .collect())
    }

    #[tokio::test]
    async fn cancel_during_provisioning_kills_both_vms_promptly()
    -> Result<(), Box<dyn std::error::Error>> {
        let (cfg, dir) = fake_config("cancel-provision")?;
        let (cancel, cancel_rx) = tokio::sync::watch::channel(false);
        let started = std::time::Instant::now();
        let creating = tokio::spawn(async move {
            // Provisioning that would take far longer than the shutdown budget.
            let slow = async {
                tokio::time::sleep(std::time::Duration::from_mins(1)).await;
                Ok(())
            };
            super::run_or_roll_back(&cfg, &["supervisor-vm", "worker-vm"], cancel_rx, slow).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cancel.send_replace(true);
        let error = creating.await?.err().ok_or("cancelled create must fail")?;
        assert!(error.message.contains("cancelled"));
        assert!(error.leaked_boxes.is_empty());
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        let kills = kills(&dir)?;
        assert_eq!(kills.len(), 2);
        assert!(kills.iter().any(|k| k.contains("supervisor-vm")));
        assert!(kills.iter().any(|k| k.contains("worker-vm")));
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    fn calls(dir: &std::path::Path, op: &str) -> usize {
        std::fs::read_to_string(dir.join("calls.jsonl"))
            .map_or(0, |c| c.matches(&format!(r#""op": "{op}""#)).count())
    }

    #[tokio::test]
    async fn an_already_cancelled_create_allocates_nothing()
    -> Result<(), Box<dyn std::error::Error>> {
        let (cfg, dir) = fake_config("cancel-first")?;
        let (_cancel, cancel_rx) = tokio::sync::watch::channel(true);
        let allocations = super::Allocations::default();
        let error = super::allocate_pair(
            &cfg,
            "sbx",
            [serde_json::json!({}), serde_json::json!({})],
            cancel_rx,
            &allocations,
        )
        .await
        .err()
        .ok_or("cancelled allocation must fail")?;
        assert!(error.message.contains("cancelled"));
        assert_eq!(calls(&dir, "create"), 0);
        assert!(allocations.snapshot().is_empty());
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[tokio::test]
    async fn a_cancel_during_an_outstanding_create_rolls_that_vm_back()
    -> Result<(), Box<dyn std::error::Error>> {
        let (mut cfg, dir) = fake_config("cancel-outstanding")?;
        cfg.template = "slow".into();
        let (cancel, cancel_rx) = tokio::sync::watch::channel(false);
        let allocations = super::Allocations::default();
        let recorded = allocations.clone();
        let creating = tokio::spawn(async move {
            super::allocate_pair(
                &cfg,
                "sbx",
                [serde_json::json!({}), serde_json::json!({})],
                cancel_rx,
                &allocations,
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        cancel.send_replace(true);
        let error = creating
            .await?
            .err()
            .ok_or("cancelled allocation must fail")?;
        assert!(error.message.contains("cancelled"));
        // The outstanding create was awaited for its id, recorded, then killed;
        // the supervisor was never created.
        assert_eq!(calls(&dir, "create"), 1);
        assert_eq!(recorded.snapshot(), vec!["slow-vm"]);
        assert_eq!(error.removed, 1);
        assert!(kills(&dir)?.iter().any(|k| k.contains("slow-vm")));
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[tokio::test]
    async fn a_lost_create_reply_is_swept_by_tag() -> Result<(), Box<dyn std::error::Error>> {
        let (mut cfg, dir) = fake_config("lost-reply")?;
        cfg.template = "lost".into();
        std::fs::write(dir.join("listed.json"), r#"[{"sandboxId": "lost-vm"}]"#)?;
        let (_cancel, cancel_rx) = tokio::sync::watch::channel(false);
        let error = super::allocate_pair(
            &cfg,
            "sbx",
            [serde_json::json!({}), serde_json::json!({})],
            cancel_rx,
            &super::Allocations::default(),
        )
        .await
        .err()
        .ok_or("a failed create must fail")?;
        assert!(error.message.contains("reply lost"));
        assert!(!error.sweep_pending);
        assert_eq!(error.removed, 1);
        let log = std::fs::read_to_string(dir.join("calls.jsonl"))?;
        assert!(log.contains(r#""openshell.ai/sandbox-id": "sbx""#));
        assert!(kills(&dir)?.iter().any(|k| k.contains("lost-vm")));
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[tokio::test]
    async fn the_sweep_stays_pending_when_the_lookup_fails()
    -> Result<(), Box<dyn std::error::Error>> {
        let (mut cfg, dir) = fake_config("lost-reply-no-list")?;
        cfg.template = "lost".into();
        std::fs::write(dir.join("list-fails"), "")?;
        let (_cancel, cancel_rx) = tokio::sync::watch::channel(false);
        let error = super::allocate_pair(
            &cfg,
            "sbx",
            [serde_json::json!({}), serde_json::json!({})],
            cancel_rx,
            &super::Allocations::default(),
        )
        .await
        .err()
        .ok_or("a failed create must fail")?;
        assert!(error.sweep_pending);
        // The health loop retries the sweep through this key.
        std::fs::remove_file(dir.join("list-fails"))?;
        assert!(
            super::retry_cleanup(&cfg, &super::sweep_key("sbx"))
                .await
                .is_ok()
        );
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[tokio::test]
    async fn a_cancelled_helper_call_kills_its_process() -> Result<(), Box<dyn std::error::Error>> {
        let (cfg, dir) = fake_config("kill-on-drop")?;
        let e2b = cfg.e2b.clone();
        let call = tokio::spawn(async move { e2b.run("vm", "sleep", "root").await });
        let pid_file = dir.join("run.pid");
        for _ in 0..50 {
            if pid_file.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let pid: i32 = std::fs::read_to_string(&pid_file)?.trim().parse()?;
        call.abort();
        let mut alive = true;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            // SAFETY: signal 0 only checks that the process exists.
            alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                break;
            }
        }
        assert!(
            !alive,
            "helper process {pid} kept running after its call was cancelled"
        );
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[tokio::test]
    async fn uncancelled_provisioning_kills_nothing() -> Result<(), Box<dyn std::error::Error>> {
        let (cfg, dir) = fake_config("no-cancel")?;
        let (_cancel, cancel_rx) = tokio::sync::watch::channel(false);
        super::run_or_roll_back(&cfg, &["supervisor-vm", "worker-vm"], cancel_rx, async {
            Ok(())
        })
        .await
        .map_err(|e| e.message)?;
        assert!(!dir.join("calls.jsonl").exists());
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[tokio::test]
    async fn rollback_kills_all_vms_at_once() -> Result<(), Box<dyn std::error::Error>> {
        let (cfg, dir) = fake_config("rollback-parallel")?;
        let rolling_back = tokio::spawn(async move {
            super::rollback(&cfg, "cancelled".into(), &["stalled", "worker-vm"]).await
        });
        // The worker kill starts while the supervisor kill is still stalled.
        let mut worker_killed = false;
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if kills(&dir).is_ok_and(|k| k.iter().any(|l| l.contains("worker-vm"))) {
                worker_killed = true;
                break;
            }
        }
        assert!(worker_killed && !rolling_back.is_finished());
        assert!(rolling_back.await?.leaked_boxes.is_empty());
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[tokio::test]
    async fn rollback_tracks_only_failed_deletes_for_retry()
    -> Result<(), Box<dyn std::error::Error>> {
        let (cfg, dir) = fake_config("rollback-pair")?;
        let result =
            super::rollback(&cfg, "provision failed".into(), &["unreachable", "worker"]).await;
        assert_eq!(result.message, "provision failed");
        assert_eq!(result.leaked_boxes, vec!["unreachable"]);
        assert_eq!(
            std::fs::read_to_string(dir.join("calls.jsonl"))?
                .lines()
                .count(),
            2
        );
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }
}
