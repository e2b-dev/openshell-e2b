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

## Three-pane studio recording

The [45-second recording](../media/separated-supervisor-demo.mp4) was captured from a live task pair on 2026-10-23. Supervisor A was `izp5c9p5qf0ddihua8d8d`; worker B was `i8yxqv6k05hd4r4t41yqy`. The 63.72-second capture is accelerated to approximately 1.42× playback at 1920×1080.

All 14 studio assertions passed, including a heartbeat that continued through the policy update, actual GET-allow and POST-deny audit events from A, and an agent frozen at heartbeat 79 after A was terminated. B's kernel reported the agent stopped; its heartbeat remained unchanged; a fresh root HTTPS probe still failed. Both task VMs were removed and the existing shared control plane remained available. The captured results are in [studio-recording.json](studio-recording.json).

Reproduce the recording with `npm run demo:record`, or open the interactive three-pane layout with `npm run demo:studio`.

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
