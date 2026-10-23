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
