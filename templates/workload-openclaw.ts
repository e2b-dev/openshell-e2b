// Worker template with OpenClaw, for running a personal agent under OpenShell.
// OpenClaw and its bundled Node are installed under /usr/lib/openclaw:
// - inside /usr, which OpenShell's default filesystem policy lets the sandbox
//   user (uid 1500) read and execute (/opt is not allowed);
// - not under /usr/local, which E2B's base image keeps world-writable (777),
//   and OpenClaw refuses to load plugins from world-writable paths.
// `openclaw` is /usr/bin/openclaw. State lives in the sandbox user's HOME.
//
// Build after `npm run build:binaries`:  npm run template:workload:openclaw
import { Template, defaultBuildLogger } from 'e2b'
import { withOpenShellWorker } from './worker-layers.ts'

const OPENCLAW_VERSION = process.env.OPENCLAW_VERSION ?? '2026.8.2'

export const template = withOpenShellWorker(Template({ fileContextPath: process.cwd() }).fromBaseImage())
  // `openclaw` on PATH: sets SQLite's temp dir, then runs the real CLI.
  .copy('templates/openclaw-wrapper.sh', '/usr/bin/openclaw', { mode: 0o755, user: 'root' })
  // System config: web tools accept OpenShell's synthetic DNS range (see the wrapper).
  .copy('templates/openclaw.json', '/etc/openclaw/openclaw.json', { mode: 0o644, user: 'root' })
  .runCmd([
    `curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --prefix /usr/lib/openclaw --version ${OPENCLAW_VERSION}`,
    // Readable by all, writable by root only: OpenClaw refuses to load plugins
    // (including its bundled Anthropic provider) from world-writable paths.
    'chmod -R a+rX,go-w /usr/lib/openclaw',
    // Record the bundled Node's path: the OpenShell policy has to name it.
    'readlink -f $(ls -d /usr/lib/openclaw/tools/node*/bin/node | head -1) > /usr/lib/openclaw/NODE_PATH && cat /usr/lib/openclaw/NODE_PATH',
    `openclaw --version | head -n 1 | grep -q "^OpenClaw ${OPENCLAW_VERSION} "`,
  ], { user: 'root' })

await Template.build(template, process.env.OPENSHELL_WORKLOAD_TEMPLATE ?? 'openshell-workload-openclaw', {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
})
