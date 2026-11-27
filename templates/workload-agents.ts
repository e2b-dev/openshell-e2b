// Worker template with two coding agents, for the coding-agent fleet under OpenShell:
// - Claude Code, from E2B's `claude` template (/usr/local/bin/claude);
// - Codex, OpenAI's native binary at /usr/bin/codex (plus its code-mode host), pinned
//   and checksum-verified.
// Both are single native binaries, so an OpenShell rule can name each one.
// /usr is read-only for the sandbox user under OpenShell's default filesystem policy.
//
// Build after `npm run build:binaries`:  npm run template:workload:agents
import { Template, defaultBuildLogger } from 'e2b'
import { withOpenShellWorker } from './worker-layers.ts'

// Released 2026-11-13. SHA-256 of the release assets: the CLI, and the code-mode host
// that Codex runs its shell tool through (without it, Codex can't run commands).
const CODEX_VERSION = '0.169.0'
const CODEX_SHA256 = '9af4d751fce183faedea629437d5252dbf458eeb04130cf4f97be844621ea985'
const CODE_MODE_HOST_SHA256 = 'cbed6a8d25e8268792b757767fbc76d4c62e84bcf8ee4a63f97547f0de3aaceb'
const RELEASE = `https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}`

export const template = withOpenShellWorker(Template({ fileContextPath: process.cwd() }).fromTemplate('claude'))
  .runCmd([
    'set -eu',
    `curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/codex.tar.gz ${RELEASE}/codex-x86_64-unknown-linux-musl.tar.gz`,
    `curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/host.tar.gz ${RELEASE}/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz`,
    `printf '%s  %s\\n' ${CODEX_SHA256} /tmp/codex.tar.gz ${CODE_MODE_HOST_SHA256} /tmp/host.tar.gz | sha256sum -c -`,
    'tar -xzf /tmp/codex.tar.gz -C /tmp',
    'tar -xzf /tmp/host.tar.gz -C /tmp',
    'install -m 0755 -o root -g root /tmp/codex-x86_64-unknown-linux-musl /usr/bin/codex',
    'install -m 0755 -o root -g root /tmp/codex-code-mode-host-x86_64-unknown-linux-musl /usr/bin/codex-code-mode-host',
    'rm -f /tmp/codex.tar.gz /tmp/host.tar.gz /tmp/codex-x86_64-unknown-linux-musl /tmp/codex-code-mode-host-x86_64-unknown-linux-musl',
    `codex --version | grep -q "${CODEX_VERSION}"`,
    'claude --version',
  ].join(' && '), { user: 'root' })

await Template.build(template, process.env.OPENSHELL_WORKLOAD_TEMPLATE ?? 'openshell-workload-agents', {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
})
