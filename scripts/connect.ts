// connect.ts: link your laptop's `openshell` CLI to the gateway in an E2B control sandbox.
//
//   laptop                                         E2B control sandbox (private)
//   ┌───────────────────────────┐                  ┌──────────────────────────────────┐
//   │ openshell CLI             │                  │                                  │
//   │   → https://127.0.0.1:17690                  │   wstunnel server :9000          │
//   │ wstunnel client :17690 ═══╪══ wss:// ════════╪══►  (secret path only)           │
//   │   + e2b-traffic-access-token header          │      → 127.0.0.1:17670 gateway   │
//   └───────────────────────────┘                  └──────────────────────────────────┘
//
// Three locks, each enough on its own:
//   1. E2B rejects requests without the sandbox's traffic access token
//   2. wstunnel only accepts our random path and only forwards to the gateway port
//   3. inside the tunnel, the CLI and gateway speak mutual TLS end to end
//
// Usage: tsx scripts/connect.ts <control-sandbox-id>
// Keeps running (it holds the tunnel open). Ctrl-C to stop.
import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { Sandbox } from 'e2b'

const GATEWAY_PORT = 17670 // gateway inside the sandbox (localhost only)
const TUNNEL_PORT = 9000 // the only port exposed through E2B's proxy
const LOCAL_PORT = 17690 // where the CLI connects on the laptop
const GATEWAY_NAME = 'e2b'
const CONFIG = `${process.cwd()}/.openshell` // isolated CLI config (gitignored)

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function main() {
  const id = process.argv[2]
  if (!id) throw new Error('usage: tsx scripts/connect.ts <control-sandbox-id>')
  const sbx = await Sandbox.connect(id)
  const token = sbx.trafficAccessToken
  if (!token) throw new Error('sandbox is public; control sandboxes must be private')

  // Step 1: start the gateway (if not running) behind a locked-down wstunnel.
  // A fresh random path per connect; the old wstunnel is replaced.
  const pathSecret = randomBytes(16).toString('hex')
  await sbx.commands.run(
    'cd /tmp && mkdir -p run && (test -x wstunnel || (curl -fsSL https://github.com/erebe/wstunnel/releases/download/v11.0.0/wstunnel_11.0.0_linux_amd64.tar.gz | tar xz wstunnel)) && chmod +x wstunnel',
    { timeoutMs: 60_000 },
  )

  // Each long-running program is started as its own E2B background command and
  // tracked by a PID file. (Matching processes by name is fragile: a script
  // that mentions "wstunnel server" matches `pkill -f "wstunnel server"` too.)
  const daemon = async (name: string, cmd: string, restart = false) => {
    const alive = await sbx.commands.run(
      `test -f /tmp/run/${name}.pid && kill -0 $(cat /tmp/run/${name}.pid) 2>/dev/null && echo yes || echo no`,
    )
    if (alive.stdout.trim() === 'yes') {
      if (!restart) return log(`${name}: already running`)
      await sbx.commands.run(`kill $(cat /tmp/run/${name}.pid) || true`)
    }
    await sbx.commands.run(`cd /tmp && echo $$ > /tmp/run/${name}.pid && exec ${cmd} > /tmp/${name}.log 2>&1`, {
      background: true,
    })
    await new Promise((r) => setTimeout(r, 1000))
    log(`${name}: started`)
  }
  await daemon('driver', 'driver/target/release/openshell-driver-e2b --bind-socket /tmp/run/e2b.sock')
  await daemon('gateway',
    './openshell-gateway --tls-cert pki/server/tls.crt --tls-key pki/server/tls.key --tls-client-ca pki/ca.crt ' +
    '--enable-mtls-auth true --compute-driver e2b --compute-driver-socket /tmp/run/e2b.sock')
  // Always restart wstunnel: it must use this run's fresh secret path.
  await daemon('wstunnel',
    `./wstunnel server ws://0.0.0.0:${TUNNEL_PORT} --restrict-to 127.0.0.1:${GATEWAY_PORT} ` +
    `--restrict-http-upgrade-path-prefix ${pathSecret}`, true)

  // Step 2: copy the CLI's client certificate out of the sandbox.
  // These files ARE the login: whoever holds tls.key can talk to the gateway.
  const mtls = `${CONFIG}/openshell/gateways/${GATEWAY_NAME}/mtls`
  await mkdir(mtls, { recursive: true, mode: 0o700 })
  for (const [remote, local] of [['pki/ca.crt', 'ca.crt'], ['pki/client/tls.crt', 'tls.crt'], ['pki/client/tls.key', 'tls.key']]) {
    await writeFile(`${mtls}/${local}`, await sbx.files.read(`/tmp/${remote}`))
    await chmod(`${mtls}/${local}`, 0o600)
  }
  log('client certificate saved to', mtls)

  // Step 3: open the tunnel on the laptop. 10 s heartbeat: spike A showed
  // E2B's proxy drops connections that stay silent for about a minute.
  const client = spawn(`${process.cwd()}/.bin/wstunnel`, [
    'client', '-L', `tcp://127.0.0.1:${LOCAL_PORT}:127.0.0.1:${GATEWAY_PORT}`,
    '--http-upgrade-path-prefix', pathSecret,
    '-H', `e2b-traffic-access-token: ${token}`,
    '--websocket-ping-frequency', '10s',
    `wss://${sbx.getHost(TUNNEL_PORT)}`,
  ], { stdio: 'ignore' })
  log(`tunnel open: laptop 127.0.0.1:${LOCAL_PORT} → gateway`)
  log(`in another terminal:  XDG_CONFIG_HOME=${CONFIG} .bin/openshell status`)

  const stop = () => { client.kill(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  client.on('exit', (code) => { log('tunnel client exited', code); process.exit(1) })
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
