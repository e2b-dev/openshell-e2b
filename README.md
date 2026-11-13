# OpenShell on E2B: separate supervisor and worker

An [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) compute driver that creates **two private E2B microVMs per task**. The shared gateway and compute driver stay outside both task VMs. OpenShell owns policy, program identity, request authorization and audit; E2B owns VM isolation, provisioning and the worker's external network fence.

This is a live demo integration pinned to OpenShell **v0.1.2**, with the limitations below.

```text
                         SHARED CONTROL PLANE
 Laptop CLI ── mTLS ──►  OpenShell gateway ↔ E2B compute driver ──► E2B API
                         Policies, sessions, lifecycle             │
                                  ▲                               │ creates/deletes
                                  │ authenticated gateway channel │ both per task
                 ┌────────────────┴───────────────┐     ┌─────────┴────────────────────┐
                 │ Sandbox A · supervisor         │     │ Sandbox B · worker           │
                 │ 1 vCPU / 1 GiB                 │     │ 2 vCPU / 2 GiB               │
                 │ OpenShell supervisor + proxy   │◄═══►│ OpenShell runtime + agent    │
                 │ Task auth + worker traffic key │     │ Per-session TLS identity     │
                 │ Allowed outbound requests ─────┼─►   │ E2B host-enforced deny-all   │
                 │                         internet     │ outbound, including root     │
                 └────────────────────────────────┘     └──────────────────────────────┘
                       Separate guest kernels; task pair destroyed together
```

A initiates authenticated WSS tunnels through E2B's port proxy to B and to the shared gateway. OpenShell's TLS session channel runs inside the worker tunnel. An agent's DNS/TCP/HTTP requests travel from B over that channel to A; A applies OpenShell policy and opens the approved upstream connection. **B never needs a direct internet connection.** This uses the existing public E2B HTTPS transport with private ingress tokens, not private VPC peering.

## Run

Requires Node 22+, `E2B_API_KEY` in `.env`, and the templates built in that E2B team. The templates are already built in the local demo account.

```bash
npm ci
npm run setup           # OpenShell CLI + wstunnel, if .bin/ is missing
npm run demo            # connects control automatically; demonstrates a pair; deletes the pair
npm run demo:verify     # also kills A and verifies the worker fails closed
```

The demo prints all three VM IDs and checks:

- No supervisor process runs in the shared control plane.
- Every task has a distinct supervisor A and worker B.
- E2B management credentials stay in control; the worker has no supervisor auth bundle.
- Default-deny policy blocks an unlisted destination.
- Direct HTTPS works from A but fails from B **even as root outside the agent namespace**.
- A live OpenShell policy permits `curl GET`, denies `curl POST`, and denies `wget` for the same host.
- OpenShell audit records reach the gateway.
- With `demo:verify`, killing A suspends the agent in B and leaves B's external egress blocked.
- Deletion removes both task VMs while the shared control plane remains available.

`dist/separated-demo-verification.json` and `dist/separated-demo-fault-verification.json` record the assertions and VM IDs from the latest successful standard and failure-drill runs. `npm run demo -- --keep` retains a live task for inspection instead of deleting it.

For a two-terminal presentation:

```bash
# Terminal 1: keep the CLI tunnel open; --new creates a fresh shared control VM.
npm run connect -- --new

# Terminal 2:
npm run demo
npm run watch           # live gateway/driver logs plus each separate supervisor's logs
```

Local state is isolated from the original demo: `.control-separated-id`, `.openshell-separated/`, and localhost port `17691`. Use `XDG_CONFIG_HOME=$PWD/.openshell-separated .bin/openshell …` for manual CLI commands. Closing the laptop tunnel does not stop the control plane or active pairs. Reconnecting reuses the gateway tunnel identity.

```bash
npm run demo:down       # deletes this control plane's task VMs and the control VM
```

## Native OpenShell dashboard demo

```bash
cd /Users/matt/e2b/openshell-e2b
npm run demo:dashboard
```

The upper pane is the unmodified OpenShell v0.1.2 `openshell term` UI. The lower-left pane controls the walkthrough; the lower-right pane samples the worker's real heartbeat and kernel process state through E2B. The launcher connects to the gateway automatically and isolates its state under `dist/dashboard/`.

Run these commands in the lower-left pane, pausing to explain each result:

```bash
demo create       # one logical OpenShell sandbox → supervisor A + worker B
demo links        # show task name and all three E2B IDs
demo fence        # default deny; root HTTPS succeeds in A and fails in B
ui policy         # from the initial dashboard, open the first sandbox
demo policy       # allow /usr/bin/curl read-only access to api.github.com
ui logs           # from policy, open native logs filtered to sandbox events
demo requests     # curl GET 200, curl POST 403, wget denied
ui audit          # scroll up one page to inspect the request decisions
ui follow         # resume following all events
demo sever        # destroy this task's supervisor; observe the worker freeze
demo cleanup      # remove the task pair; verify the shared gateway survives
```

For manual navigation, click the upper pane. On the dashboard, Tab switches panels and Enter opens a selected sandbox. In a sandbox, `l` opens logs; `s` cycles the log source; `f` follows; Page Up scrolls; Enter expands a selected event; Esc returns. Click the lower-left pane before running the next command. The `ui` shortcuts assume the sequence above and that the demo is the first sandbox; with other tasks present, select the printed task name manually.

Keep your signed-in **local browser** open to E2B Console → Sandboxes, sorted by Started at descending. After `demo create`, inspect the two new rows: `openshell-supervisor-separated` and `openshell-workload-separated`. Their metadata has the same `openshell.ai/sandbox-name` and different `openshell.ai/role` values. Open a row for E2B CPU/memory monitoring. Return to the native OpenShell view for policy and audit, then show worker B surviving supervisor loss. The Console template filter selects a single template; use the unfiltered list to show both roles together.

Use a large terminal (about 140 columns × 35 rows or larger). Ctrl-B, D exits the presentation and triggers cleanup of only its task pair. The shared control VM remains available. Before presenting, check the control VM has enough time remaining: this prototype has a one-hour lifetime. To start fresh, stop the existing `npm run connect` process in its terminal, then run `npm run connect -- --new` in that terminal and leave it open.

```bash
npm run demo:record:dashboard
# → media/openshell-dashboard-demo.mp4, 45 seconds, 1080p
```

Recording requires VHS, tmux, FFmpeg and Menlo. The tape executes the live scenario, waits for actual results, and exports only after all 14 assertions plus supervisor GET-allow and POST-deny audit records pass. The capture is accelerated; network and provisioning wait times vary. The edited `media/openshell-dashboard-console-demo.mp4` adds a six-second cutaway captured from the signed-in local Chrome Console for the same task. Console captures are manual and are not part of the unattended recorder. To pause a recording for this cutaway, use `DASHBOARD_CAPTURE=1 npm run demo:record:dashboard`; after `dist/dashboard/console-ready` appears, capture the list and run `touch dist/dashboard/console-captured` from another terminal within three minutes.

Evidence is saved in `dist/dashboard/state.json` and `dist/dashboard/supervisor-events.jsonl`. The separate `demo:studio` view below keeps the raw supervisor feed visible alongside the worker.

## Three-pane live demo and video

```bash
npm run demo:studio     # interactive: walkthrough, supervisor audit, worker heartbeat
npm run demo:record     # live run → media/separated-supervisor-demo.mp4 (45 seconds)
```

The left pane runs `studio create`, `studio fence`, `studio policy`, `studio requests`, `studio sever`, and `studio cleanup`. The upper-right pane streams audit records directly from supervisor A. The lower-right pane reads the agent heartbeat and kernel process state directly from worker B. `studio sever` destroys only this demo's supervisor VM: the worker survives, its agent freezes, and a root-level HTTPS probe remains blocked by E2B's network fence.

The recorder requires VHS, tmux, gum, FFmpeg and the Menlo font. It connects the gateway automatically, records the real commands, and accelerates the capture into a 45-second 1080p MP4. Export requires 14 live assertions plus GET-allow and POST-deny records from the supervisor feed. The full-speed capture, assertion report and source audit events are saved under `dist/studio/`. Detach with Ctrl-B, D to close the interactive studio; the launcher cleans up its task pair and any laptop tunnel it started. The shared control VM remains available. No other task pairs are removed.

## Build and test

```bash
npm run template:builder      # once per E2B team
npm run build:binaries        # builds current working-tree sources and runs Rust tests
npm run template:workload
npm run template:supervisor
npm run template:control
npm run typecheck
npm run demo:verify
```

The templates are `openshell-control-separated`, `openshell-supervisor-separated`, and `openshell-workload-separated`. Original demo template aliases are not changed. The build backports NVIDIA's eMudhra trust fix using rustls-webpki 0.103.16 and webpki-roots / webpki-root-certs 1.0.10.

For incremental development, `build:binaries -- --keep-builder` retains the compiler VM; `build:binaries -- --reuse --driver-only --keep-builder` rebuilds the driver there. A failed build retains the compiler VM for diagnosis until its one-hour timeout. It contains source and compiler outputs, not the E2B management key.

## Implementation boundaries

| Component | Responsibility |
|---|---|
| `driver/src/lifecycle.rs` | Create the pair, configure worker isolation, provision task credentials in A, start the supervisor; roll back both on failure |
| `driver/src/boundary.rs` | NVIDIA boundary descriptors, per-session TLS, workload identity and fence evidence |
| `driver/src/health.rs` | Check both VMs and A's process tree; report failed readiness; retry failed rollback deletes |
| `driver/e2b-helper.mjs` | E2B SDK operations; private ingress for both roles, internet disabled for workers |
| `templates/launch-supervisor.py` | A's supervisor and two tunnel clients; stop the group if any process exits |
| `templates/launch-sandbox.sh` | B's OpenShell runtime, isolated namespace, uid 1500 and dropped capabilities |
| `scripts/demo-separated.ts` | Real E2B/OpenShell assertions, failure drill and pair cleanup |

The worker keeps OpenShell's Landlock, seccomp, namespace and executable-identity mechanisms. E2B's VM boundary and host networking add independent isolation; this implementation does **not** silently translate filesystem or syscall policy into template scoping. E2B Secrets and request transforms are not integrated in this version.

## Demo limitations and production work

- **Landlock ABI v2 patch:** the current worker kernel is Linux 6.1. The existing demo patch accepts ABI v2, which does not protect read-only files against truncate. This is not full OpenShell filesystem-policy equivalence.
- **Shared gateway client certificate:** supervisors still use the demo's CLI mTLS certificate. Per-task launch JWTs and worker TLS sessions are distinct, but A remains trusted with broad gateway access. Production needs scoped gateway authorization and separate client identities; VM separation alone does not solve that.
- **Control-plane persistence:** driver inventory is in memory. Restarting the driver reaps its metadata-tagged task VMs instead of adopting sessions. Stop/start, pause/resume and durable reconciliation are not implemented.
- **Lifetimes:** task VMs and the demo control VM have a one-hour TTL. The logical control plane is shared across tasks, but this demo does not provision an indefinitely available production gateway. Create a fresh control plane shortly before presenting.
- **Network transport:** WSS through E2B's ingress proxy adds hops. Private sandbox-to-sandbox transport and narrower supervisor egress are future improvements. The external worker fence is configured at create time; the boundary evidence records this configuration rather than a platform-signed attestation.
- **Templates:** descriptors currently reference template aliases rather than immutable build IDs.

## License

Apache-2.0. Uses NVIDIA OpenShell (Apache-2.0) and wstunnel (BSD-3-Clause).
