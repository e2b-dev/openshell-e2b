//! openshell-driver-e2b: an external OpenShell compute driver backed by E2B sandboxes.
//!
//! HOW IT FITS
//! -----------
//! OpenShell's gateway is the "boss": it owns users, policies and sandbox
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
    #[arg(long, env = "OPENSHELL_E2B_TEMPLATE", default_value = "base")]
    template: String,

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
    info!(socket = %args.bind_socket.display(), template = %args.template, "starting E2B compute driver");

    // Serve NVIDIA's ComputeDriver gRPC interface (defined in their
    // compute_driver.proto) with our implementation in service.rs.
    // Runs until Ctrl-C / SIGINT.
    tonic::transport::Server::builder()
        .add_service(ComputeDriverServer::new(service::E2bDriver::new(args.template)))
        .serve_with_incoming_shutdown(SameUidUnixIncoming::new(listener), async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .into_diagnostic()
}
