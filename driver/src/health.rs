//! Monitor both task microVMs and the remote supervisor process tree.
//! Snapshot before network calls; never hold the sandbox table lock over I/O.
use crate::lifecycle;
use crate::service::Shared;
use openshell_core::proto::compute::v1::{
    WatchSandboxesEvent, WatchSandboxesSandboxEvent, watch_sandboxes_event::Payload,
};
use std::time::Duration;
use tracing::{info, warn};

/// Retry every leaked-set entry once. An entry goes when its cleanup works,
/// except a sweep key, which stays until its grace period has passed.
pub async fn retry_leaked(shared: &Shared) {
    let leaked: Vec<_> = shared.leaked.lock().await.keys().cloned().collect();
    for key in leaked {
        // A sweep that started before the deadline may have listed E2B too
        // early; only a clean sweep that started after it ends the grace.
        let started = std::time::Instant::now();
        if lifecycle::retry_cleanup(&shared.cfg, &key).await.is_err() {
            continue;
        }
        let in_grace = shared
            .sweep_until
            .lock()
            .is_ok_and(|until| until.get(&key).is_some_and(|deadline| started < *deadline));
        if in_grace {
            continue;
        }
        if let Ok(mut until) = shared.sweep_until.lock() {
            until.remove(&key);
        }
        shared.leaked.lock().await.remove(&key);
        info!(entry = %key, "health: rollback cleaned up");
    }
}

pub fn spawn(shared: Shared) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            retry_leaked(&shared).await;
            let snapshot: Vec<_> = shared
                .sandboxes
                .lock()
                .await
                .iter()
                .filter(|(_, r)| !r.deleting)
                .map(|(id, r)| (id.clone(), r.e2b_id.clone(), r.supervisor_id.clone()))
                .collect();
            if snapshot.is_empty() {
                continue;
            }
            let alive = match shared.cfg.e2b.list_ids(&shared.cfg.owner).await {
                Ok(alive) => alive,
                Err(error) => {
                    warn!(%error, "health: E2B list unavailable");
                    continue;
                }
            };
            for (id, worker, supervisor) in snapshot {
                let problem = if !alive.contains(&worker) || !alive.contains(&supervisor) {
                    Some((
                        "E2bSandboxGone",
                        "A member of the task pair expired or was killed",
                    ))
                } else {
                    match shared.cfg.e2b.run(&supervisor,
                        "test -f /run/openshell-task/ready && test ! -f /run/openshell-task/failed && kill -0 $(cat /run/openshell-task/launcher.pid) 2>/dev/null", "root").await {
                        Ok(result) if result.exit_code != 0 => Some(("SupervisorExited", "Supervisor or authenticated transport exited")),
                        // A transient SDK transport failure is not proof of a dead process.
                        _ => None,
                    }
                };
                if let Some((reason, message)) = problem {
                    let mut table = shared.sandboxes.lock().await;
                    if let Some(running) = table.get_mut(&id)
                        && !running.deleting
                        && running.supervisor_id == supervisor
                        && lifecycle::mark_not_ready(running, reason, message)
                    {
                        warn!(sandbox = %running.sandbox.name, reason, message, "health: sandbox not ready");
                        let _ = shared.events.send(WatchSandboxesEvent {
                            payload: Some(Payload::Sandbox(WatchSandboxesSandboxEvent {
                                sandbox: Some(running.sandbox.clone()),
                            })),
                        });
                    }
                }
            }
        }
    });
}
