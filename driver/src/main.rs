//! openshell-driver-e2b: an external `OpenShell` compute driver backed by E2B sandboxes.
//!
//! HOW IT FITS
//! -----------
//! `OpenShell`'s gateway is the "boss": it owns users, policies and sandbox
//! records, but it cannot create machines by itself. For that it talks to a
//! *compute driver*. NVIDIA ships drivers for Docker, Podman, Kubernetes and
//! VMs. This program is a driver for E2B.
//!
//!   openshell-gateway  ──(gRPC over a Unix socket)──►  openshell-driver-e2b  ──►  E2B API
//!        NVIDIA                                              ours
//!
//! The gateway is started with:
//!   --compute-driver e2b --compute-driver-socket <path to our socket>
//! and connects to the socket this program creates.
//!
//! WHY A UNIX SOCKET
//! -----------------
//! A Unix socket is a file that two programs on the same machine use to talk.
//! It never touches the network, and file permissions decide who may connect.
//! NVIDIA's helper `bind_private` creates it readable only by our own user,
//! and `SameUidUnixIncoming` rejects any process running as a different user.

mod boundary;
mod e2b;
mod lifecycle;
mod service;

use clap::Parser;
use miette::{IntoDiagnostic, Result};
use openshell_core::external_driver_socket::{SameUidUnixIncoming, SocketCleanup, bind_private};
use openshell_core::proto::compute::v1::compute_driver_server::ComputeDriverServer;
use std::path::PathBuf;
use tracing::info;

/// Command-line flags. Each can also come from an environment variable,
/// which is handier when a script starts the driver.
#[derive(Parser, Debug)]
#[command(version, about)]
struct Args {
    /// Unix socket the gateway connects to.
    #[arg(long, env = "OPENSHELL_E2B_SOCKET")]
    bind_socket: PathBuf,

    /// E2B template used for workload (agent) sandboxes.
    #[arg(
        long,
        env = "OPENSHELL_E2B_TEMPLATE",
        default_value = "openshell-workload"
    )]
    template: String,

    /// Tags every E2B box we create, so several control planes can share a team.
    #[arg(long, env = "OPENSHELL_E2B_OWNER", default_value = "openshell-e2b")]
    owner: String,

    /// Where the E2B helper script lives, and the node binary to run it.
    #[arg(long, env = "OPENSHELL_E2B_HELPER")]
    helper: PathBuf,
    #[arg(long, env = "OPENSHELL_E2B_NODE", default_value = "node")]
    node: PathBuf,

    /// NVIDIA's supervisor (patched build) and the tunnel client, on this machine.
    #[arg(long, env = "OPENSHELL_E2B_SUPERVISOR")]
    supervisor: PathBuf,
    #[arg(long, env = "OPENSHELL_E2B_WSTUNNEL")]
    wstunnel: PathBuf,

    /// How supervisors reach the gateway, and the client certificate they use.
    #[arg(
        long,
        env = "OPENSHELL_E2B_GATEWAY",
        default_value = "https://127.0.0.1:17670"
    )]
    gateway_endpoint: String,
    #[arg(long, env = "OPENSHELL_E2B_GATEWAY_CA")]
    gateway_ca: PathBuf,
    #[arg(long, env = "OPENSHELL_E2B_GATEWAY_CERT")]
    gateway_cert: PathBuf,
    #[arg(long, env = "OPENSHELL_E2B_GATEWAY_KEY")]
    gateway_key: PathBuf,

    /// Per-sandbox local state (supervisor papers, logs).
    #[arg(
        long,
        env = "OPENSHELL_E2B_STATE_DIR",
        default_value = "/tmp/openshell-e2b"
    )]
    state_dir: PathBuf,

    #[arg(long, env = "OPENSHELL_E2B_LOG", default_value = "info")]
    log_level: String,
}

// `#[tokio::main]` starts an async runtime: the driver handles many requests
// at once (the gateway keeps a watch stream open while also calling create).
#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(&args.log_level))
        .init();

    // Create the private socket file. `SocketCleanup` deletes it again when
    // the program exits, so a restart doesn't fail on "address in use".
    let listener = bind_private(&args.bind_socket).map_err(|e| miette::miette!(e))?;
    let _cleanup = SocketCleanup::new(args.bind_socket.clone());
    info!(socket = %args.bind_socket.display(), template = %args.template, owner = %args.owner, "starting E2B compute driver");

    // Serve NVIDIA's ComputeDriver gRPC interface (defined in their
    // compute_driver.proto) with our implementation in service.rs.
    // Runs until SIGINT or SIGTERM. On either, the server stops and the
    // sandbox table is dropped, which kills local supervisors and tunnels.
    let config = lifecycle::Config {
        template: args.template,
        e2b: e2b::E2b {
            node: args.node,
            helper: args.helper,
        },
        supervisor_bin: args.supervisor,
        wstunnel_bin: args.wstunnel,
        gateway_endpoint: args.gateway_endpoint,
        gateway_ca: args.gateway_ca,
        gateway_cert: args.gateway_cert,
        gateway_key: args.gateway_key,
        state_dir: args.state_dir,
        owner: args.owner,
    };

    tonic::transport::Server::builder()
        .add_service(ComputeDriverServer::new(service::E2bDriver::new(config)))
        .serve_with_incoming_shutdown(SameUidUnixIncoming::new(listener), shutdown_signal())
        .await
        .into_diagnostic()
}

/// Resolve on SIGINT (Ctrl-C) or SIGTERM (what `kill` and process managers send).
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let Ok(mut term) = signal(SignalKind::terminate()) else {
        let _ = tokio::signal::ctrl_c().await;
        return;
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}
