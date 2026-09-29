//! Health monitor: notices when a running sandbox breaks and tells the gateway.
//!
//!   every 5 s   did the supervisor or the tunnel client exit?     (local, cheap)
//!   every 30 s  does the E2B box still exist?                     (one E2B API call for all)
//!
//! A problem flips the sandbox's Ready condition to False with a reason, and
//! the change goes out on the watch stream. Without this, a sandbox whose
//! tunnel died would keep reporting Ready.

use crate::lifecycle::{self, Config, Running};
use openshell_core::proto::compute::v1::{
    WatchSandboxesEvent, WatchSandboxesSandboxEvent, watch_sandboxes_event::Payload,
};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, broadcast};
use tracing::warn;

const PROCESS_CHECK: Duration = Duration::from_secs(5);
/// Check E2B every Nth process check (6 × 5 s = 30 s).
const E2B_CHECK_EVERY: u32 = 6;
/// Names for `Running::children`, in the order lifecycle.rs starts them.
const CHILD_NAMES: [&str; 2] = ["tunnel", "supervisor"];

pub fn spawn(
    cfg: Config,
    sandboxes: Arc<Mutex<HashMap<String, Running>>>,
    events: broadcast::Sender<WatchSandboxesEvent>,
) {
    tokio::spawn(async move {
        let mut tick: u32 = 0;
        loop {
            tokio::time::sleep(PROCESS_CHECK).await;
            tick = tick.wrapping_add(1);
            // Ask E2B outside the lock: it's a network call.
            let alive_boxes = if tick.is_multiple_of(E2B_CHECK_EVERY) {
                match cfg.e2b.list_ids(&cfg.owner).await {
                    Ok(ids) => Some(ids),
                    Err(e) => {
                        warn!(error = %e, "health: E2B list failed; skipping box check");
                        None
                    }
                }
            } else {
                None
            };
            let mut table = sandboxes.lock().await;
            for running in table.values_mut() {
                if let Some((reason, message)) = problem(running, alive_boxes.as_ref())
                    && lifecycle::mark_not_ready(running, reason, &message)
                {
                    warn!(sandbox = %running.sandbox.name, reason, %message, "health: sandbox not ready");
                    let _ = events.send(WatchSandboxesEvent {
                        payload: Some(Payload::Sandbox(WatchSandboxesSandboxEvent {
                            sandbox: Some(running.sandbox.clone()),
                        })),
                    });
                }
            }
            drop(table);
        }
    });
}

/// The first thing wrong with this sandbox, if anything.
fn problem(
    running: &mut Running,
    alive_boxes: Option<&HashSet<String>>,
) -> Option<(&'static str, String)> {
    for (child, name) in running.children.iter_mut().zip(CHILD_NAMES) {
        if let Ok(Some(status)) = child.try_wait() {
            let reason = if name == "supervisor" {
                "SupervisorExited"
            } else {
                "TunnelExited"
            };
            return Some((reason, format!("{name} process exited ({status})")));
        }
    }
    if let Some(alive) = alive_boxes
        && !alive.contains(&running.e2b_id)
    {
        return Some((
            "E2bSandboxGone",
            format!(
                "E2B box {} no longer exists (expired or killed)",
                running.e2b_id
            ),
        ));
    }
    None
}
