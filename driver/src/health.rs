//! Monitor both task microVMs and the remote supervisor process tree.
//! Snapshot before network calls; never hold the sandbox table lock over I/O.
use crate::lifecycle;
use crate::service::Shared;
use openshell_core::proto::compute::v1::{
    WatchSandboxesEvent, WatchSandboxesSandboxEvent, watch_sandboxes_event::Payload,
};
use std::time::Duration;
use tracing::{info, warn};

pub fn spawn(shared: Shared) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let leaked: Vec<_> = shared.leaked.lock().await.iter().cloned().collect();
            for id in leaked {
                if shared.cfg.e2b.kill(&id).await.is_ok() {
                    shared.leaked.lock().await.remove(&id);
                    info!(e2b = %id, "health: rollback cleaned up");
                }
            }
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
