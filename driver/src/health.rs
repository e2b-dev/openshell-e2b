//! Health monitor: notices when a running sandbox breaks and tells the gateway.
//!
//!   every 5 s   did the supervisor or the tunnel client exit?     (local, cheap)
//!   every 30 s  does the E2B box still exist?                     (one E2B API call for all)
//!               retry killing boxes whose create rollback failed
//!
//! A problem flips the sandbox's Ready condition to False with a reason, and
//! the change goes out on the watch stream. Without this, a sandbox whose
//! tunnel died would keep reporting Ready.

use crate::lifecycle::{self, Running};
use crate::service::Shared;
use openshell_core::proto::compute::v1::{
    WatchSandboxesEvent, WatchSandboxesSandboxEvent, watch_sandboxes_event::Payload,
};
use std::collections::HashSet;
use std::time::Duration;
use tracing::{info, warn};

const PROCESS_CHECK: Duration = Duration::from_secs(5);
/// Check E2B every Nth process check (6 × 5 s = 30 s).
const E2B_CHECK_EVERY: u32 = 6;
/// Names for `Running::children`, in the order lifecycle.rs starts them.
const CHILD_NAMES: [&str; 2] = ["tunnel", "supervisor"];

pub fn spawn(shared: Shared) {
    tokio::spawn(async move {
        let mut tick: u32 = 0;
        loop {
            tokio::time::sleep(PROCESS_CHECK).await;
            tick = tick.wrapping_add(1);
            let box_check = if tick.is_multiple_of(E2B_CHECK_EVERY) {
                retry_leaked(&shared).await;
                check_boxes(&shared).await
            } else {
                None
            };
            let mut table = shared.sandboxes.lock().await;
            for running in table.values_mut() {
                if running.deleting {
                    continue; // the delete task owns this one now
                }
                if let Some((reason, message)) = problem(running, box_check.as_ref())
                    && lifecycle::mark_not_ready(running, reason, &message)
                {
                    warn!(sandbox = %running.sandbox.name, reason, %message, "health: sandbox not ready");
                    let _ = shared.events.send(WatchSandboxesEvent {
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

/// Boxes we knew about BEFORE asking E2B, and the boxes E2B reports alive.
/// Only boxes in the first set can be judged, so a sandbox created while the
/// query was in flight is never mistaken for a dead one.
struct BoxCheck {
    known_before: HashSet<String>,
    alive: HashSet<String>,
}

async fn check_boxes(shared: &Shared) -> Option<BoxCheck> {
    let known_before: HashSet<String> = shared
        .sandboxes
        .lock()
        .await
        .values()
        .map(|r| r.e2b_id.clone())
        .collect();
    if known_before.is_empty() {
        return None;
    }
    // The network call happens outside the lock.
    match shared.cfg.e2b.list_ids(&shared.cfg.owner).await {
        Ok(alive) => Some(BoxCheck {
            known_before,
            alive,
        }),
        Err(e) => {
            warn!(error = %e, "health: E2B list failed; skipping box check");
            None
        }
    }
}

async fn retry_leaked(shared: &Shared) {
    let leaked: Vec<String> = shared.leaked.lock().await.iter().cloned().collect();
    for box_id in leaked {
        if shared.cfg.e2b.kill(&box_id).await.is_ok() {
            shared.leaked.lock().await.remove(&box_id);
            info!(e2b = %box_id, "health: leaked E2B box killed");
        }
    }
}

/// The first thing wrong with this sandbox, if anything.
fn problem(running: &mut Running, box_check: Option<&BoxCheck>) -> Option<(&'static str, String)> {
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
    if let Some(check) = box_check
        && check.known_before.contains(&running.e2b_id)
        && !check.alive.contains(&running.e2b_id)
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
