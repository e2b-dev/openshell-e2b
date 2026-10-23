# Separate-supervisor integration verification

Live E2B runs on 2026-10-23, using OpenShell v0.1.2 with the repository’s Landlock ABI v2 and eMudhra trust patches.

## Results

| Run | Assertions | Supervisor A | Worker B |
|---|---:|---|---|
| Standard demo, automatic reconnect | 11 passed | `iutm2avrh9u2gvqx4hpm5` | `i1x2e2rec0pk62mlf96ag` |
| Supervisor-loss failure drill | 13 passed | `if5br8r1jbihwakk3qcu5` | `i89op0hwp2qcdhwswlwrk` |

Both used shared control plane `iveay7fm552ml9lnnpzkb`. All task VMs and the build VM were deleted after verification. The shared control plane remained available.

Observed create-to-gateway-Ready times were 10.5 seconds for the standard run and 10.7 seconds for the failure drill. These are individual demo measurements, not a platform benchmark.

## Live assertions

- No supervisor process in the control plane.
- Gateway Ready with a distinct supervisor/worker pair.
- Supervisor and session credentials live in A; E2B management key stays in control.
- Unlisted destination denied before any network policy is added.
- Direct HTTPS works from A; blocked from B even as root outside the agent namespace.
- curl GET api.github.com/zen → HTTP 200.
- curl POST api.github.com/gists → HTTP 403 (blocked by OpenShell).
- wget denied for the same host: program identity enforced.
- OpenShell audit records retained across the separate supervisor channel.
- Worker runtime suspended the agent when its supervisor disappeared.
- Worker root egress remains denied after supervisor loss.
- Supervisor and worker deleted together.
- Shared control plane still available.

The live log viewer also discovered sandbox A automatically and streamed its policy load, HTTP allow/deny and program-identity audit events alongside the shared gateway and driver logs.

## Build checks

- Rust release build succeeded in an E2B Linux builder.
- Five Rust tests passed, including partial-delete failure and rollback retry bookkeeping.
- `cargo clippy --release -- -D warnings` passed.
- `npm run typecheck` passed.
- Python supervisor launcher parsed successfully and ran in the live supervisor VM.

## E2B templates

| Role | Template ID | Verified build ID |
|---|---|---|
| Control | `es2xarqheh9gwbg9qh82` | `3e82ac42-b208-4483-916d-90cd7f993570` |
| Supervisor A | `pbk6uy8y2vbofhm3mruw` | `87980c14-b6d3-4c4f-a494-015ae04f45e7` |
| Worker B | `z56j2f9wjzdta7x7zn4o` | `362c5a2a-32a7-4e53-b0a7-610fe98da037` |

Reproduce with `npm run demo:verify`. The [README](../README.md) describes setup, transport, credential boundaries and the remaining production limitations.
