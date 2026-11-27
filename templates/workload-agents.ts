// Worker template with two coding agents, for the coding-agent fleet under OpenShell:
// - Claude Code, from E2B's `claude` template (/usr/local/bin/claude);
// - Codex, OpenAI's native binary at /usr/bin/codex, pinned and checksum-verified.
// Both are single native binaries, so an OpenShell rule can name each one.
// /usr is read-only for the sandbox user under OpenShell's default filesystem policy.
//
// Build after `npm run build:binaries`:  npm run template:workload:agents
import { Template, defaultBuildLogger } from 'e2b'
import { withOpenShellWorker } from './worker-layers.ts'

// Released 2026-11-13. The SHA-256 is of the release asset codex-x86_64-unknown-linux-musl.tar.gz.
const CODEX_VERSION = '0.169.0'
const CODEX_SHA256 = '9af4d751fce183faedea629437d5252dbf458eeb04130cf4f97be844621ea985'

export const template = withOpenShellWorker(Template({ fileContextPath: process.cwd() }).fromTemplate('claude'))
  .runCmd([
    'set -eu',
    `curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/codex.tar.gz https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz`,
    `echo '${CODEX_SHA256}  /tmp/codex.tar.gz' | sha256sum -c -`,
    'tar -xzf /tmp/codex.tar.gz -C /tmp',
    'install -m 0755 -o root -g root /tmp/codex-x86_64-unknown-linux-musl /usr/bin/codex',
    'rm -f /tmp/codex.tar.gz /tmp/codex-x86_64-unknown-linux-musl',
    `codex --version | grep -q "${CODEX_VERSION}"`,
    'claude --version',
  ].join(' && '), { user: 'root' })

await Template.build(template, process.env.OPENSHELL_WORKLOAD_TEMPLATE ?? 'openshell-workload-agents', {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
})
