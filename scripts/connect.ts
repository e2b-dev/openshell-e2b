// connect.ts: bring up (or reconnect to) the OpenShell control plane on E2B
// and link your laptop's `openshell` CLI to it. One command:
//
//   npm run connect              reuse the control box in .control-id, or create one
//   npm run connect -- --new     always create a fresh control box
//
//   laptop                                         E2B control sandbox (private, openshell-control template)
//   ┌───────────────────────────┐                  ┌──────────────────────────────────────────────┐
//   │ openshell CLI             │                  │  wstunnel server :9000 (secret path only)     │
//   │   → https://127.0.0.1:17690                  │     → 127.0.0.1:17670 openshell-gateway        │
//   │ wstunnel client :17690 ═══╪══ wss:// ════════╪══►        ↕ unix socket                       │
//   │   + e2b-traffic-access-token header          │     openshell-driver-e2b → E2B API (agent boxes) │
//   └───────────────────────────┘                  └──────────────────────────────────────────────┘
//
// Layers of protection (defence in depth; the inner mTLS is what protects the session):
//   1. E2B rejects requests without the sandbox's traffic access token
//   2. wstunnel only accepts our random path and only forwards to the gateway port
//   3. the tunnel client verifies E2B's TLS certificate (otherwise 1 and 2 could be intercepted)
//   4. inside the tunnel, the CLI and gateway speak mutual TLS end to end
//
// Keeps running (it holds the tunnel open). Ctrl-C to stop; the control box keeps running.
// Note: on a team with a 1-hour sandbox cap the control box dies an hour after creation;
// run `npm run connect -- --new` shortly before a demo.
import { randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sandbox } from 'e2b'

const GATEWAY_PORT = 17670 // gateway inside the control box (localhost only)
const TUNNEL_PORT = 9000 // the only port we use through E2B's proxy
const LOCAL_PORT = 17690 // where the CLI connects on the laptop
const GATEWAY_NAME = 'e2b'
const ROOT = '/opt/openshell-e2b' // baked into the openshell-control template
const STATE = '/home/user/openshell' // per-box: certificates, config, logs
const CONFIG = `${process.cwd()}/.openshell` // isolated CLI config on the laptop (gitignored)
const ID_FILE = '.control-id'

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function controlBox(): Promise<Sandbox> {
  if (!process.argv.includes('--new')) {
    const id = (await readFile(ID_FILE, 'utf8').catch(() => '')).trim()
    if (id) {
      try {
        const sbx = await Sandbox.connect(id)
        log('reusing control box', id)
        return sbx
      } catch {
        log('control box', id, 'is gone; creating a new one')
      }
    }
  }
  const sbx = await Sandbox.create('openshell-control', {
    timeoutMs: 60 * 60_000,
    network: { allowPublicTraffic: false },
    metadata: { 'openshell.ai/role': 'control-plane' },
  })
  await writeFile(ID_FILE, sbx.sandboxId)
  log('created control box', sbx.sandboxId, '(expires in 60 min on capped teams)')
  return sbx
}

async function main() {
  const sbx = await controlBox()
  const token = sbx.trafficAccessToken
  if (!token) throw new Error('control box is public; it must be private')

  // One-time setup per box, each piece checked on its own so a half-finished
  // earlier run is completed rather than skipped: PKI (CA, server + client
  // certs, JWT signing key), gateway config, and the E2B API key for the
  // driver (0600, this box only).
  const exists = async (path: string) =>
    (await sbx.commands.run(`test -f ${path} && echo yes || echo no`)).stdout.trim() === 'yes'
  await sbx.commands.run(`mkdir -p ${STATE}/run && chmod 700 ${STATE}`)
  if (!(await exists(`${STATE}/pki/ca.crt`))) {
    await sbx.commands.run(
      `${ROOT}/bin/openshell-gateway generate-certs --output-dir ${STATE}/pki --server-san localhost --server-san 127.0.0.1 > ${STATE}/certgen.log 2>&1`,
      { timeoutMs: 60_000 },
    )
    log('control box: PKI generated')
  }
  if (!(await exists(`${STATE}/gateway.toml`))) {
    // [gateway_jwt] lets the gateway mint launch credentials (without it
    // CreateSandbox arrives with no launch_authentication).
    // ttl_secs = 3600: sandbox tokens expire and get renewed, never "forever".
    await sbx.files.write(`${STATE}/gateway.toml`, [
      '[openshell]',
      'version = 2',
      '',
      '[openshell.gateway.gateway_jwt]',
      `signing_key_path = "${STATE}/pki/jwt/signing.pem"`,
      `public_key_path  = "${STATE}/pki/jwt/public.pem"`,
      `kid_path         = "${STATE}/pki/jwt/kid"`,
      'gateway_id       = "openshell-e2b"',
      'ttl_secs         = 3600',
      '',
    ].join('\n'))
    log('control box: gateway config written')
  }
  if (!(await exists(`${STATE}/driver.env`))) {
    const lines = (await readFile('.env', 'utf8')).split('\n')
    const key = lines.find((l) => l.startsWith('E2B_API_KEY='))
    if (!key) throw new Error('.env has no E2B_API_KEY')
    // E2B_DOMAIN (optional) points the driver at the same cluster as this laptop, e.g. EU.
    const domain = lines.find((l) => l.startsWith('E2B_DOMAIN='))
    await sbx.files.write(`${STATE}/driver.env`, [key, domain].filter(Boolean).join('\n') + '\n')
    await sbx.commands.run(`chmod 600 ${STATE}/driver.env`)
    log('control box: driver credentials written')
  }

  // Long-running programs: each is its own E2B background command, tracked by
  // a PID file (matching by name is fragile: a script mentioning "wstunnel
  // server" matches `pkill -f "wstunnel server"` too).
  const daemon = async (name: string, cmd: string, restart = false) => {
    const alive = await sbx.commands.run(
      `test -f ${STATE}/run/${name}.pid && kill -0 $(cat ${STATE}/run/${name}.pid) 2>/dev/null && echo yes || echo no`,
    )
    if (alive.stdout.trim() === 'yes') {
      if (!restart) return log(`${name}: already running`)
      await sbx.commands.run(`kill $(cat ${STATE}/run/${name}.pid) || true`)
      await sleep(500)
    }
    // timeoutMs: 0 matters. The SDK's default is 60 s even for background
    // commands, so without it E2B kills the gateway after one minute.
    const handle = await sbx.commands.run(
      `cd ${STATE} && echo $$ > run/${name}.pid && exec ${cmd} > ${name}.log 2>&1`,
      { background: true, timeoutMs: 0 },
    )
    await handle.disconnect()
    await sleep(1000)
    log(`${name}: started`)
  }
  const restart = process.env.RESTART === '1'
  // The driver reads the E2B API key from driver.env. Agent boxes never get it.
  await daemon('driver',
    `sh -c 'set -a; . ${STATE}/driver.env; set +a; exec ${ROOT}/bin/openshell-driver-e2b ` +
    `--bind-socket ${STATE}/run/e2b.sock --template openshell-workload ` +
    `--helper ${ROOT}/helper/e2b-helper.mjs --node ${ROOT}/node/bin/node ` +
    `--supervisor ${ROOT}/bin/openshell-supervisor --wstunnel ${ROOT}/bin/wstunnel ` +
    `--state-dir ${STATE}/sandboxes ` +
    `--gateway-ca ${STATE}/pki/ca.crt --gateway-cert ${STATE}/pki/client/tls.crt --gateway-key ${STATE}/pki/client/tls.key'`,
    restart)
  await daemon('gateway',
    `${ROOT}/bin/openshell-gateway --config ${STATE}/gateway.toml ` +
    `--tls-cert ${STATE}/pki/server/tls.crt --tls-key ${STATE}/pki/server/tls.key --tls-client-ca ${STATE}/pki/ca.crt ` +
    `--enable-mtls-auth true --compute-driver e2b --compute-driver-socket ${STATE}/run/e2b.sock`,
    restart)
  // Always restart the tunnel server: it must use this run's fresh secret path.
  const pathSecret = randomBytes(16).toString('hex')
  await daemon('wstunnel',
    `${ROOT}/bin/wstunnel server ws://0.0.0.0:${TUNNEL_PORT} --restrict-to 127.0.0.1:${GATEWAY_PORT} ` +
    `--restrict-http-upgrade-path-prefix ${pathSecret}`,
    true)

  // Register the gateway with the isolated CLI config, unless it already is.
  const cli = (args: string[]) =>
    execFileSync('.bin/openshell', args, { env: { ...process.env, XDG_CONFIG_HOME: CONFIG }, encoding: 'utf8' })
  const registered = cli(['gateway', 'list']).split('\n').some((line) => line.replace('*', '').trim().startsWith(`${GATEWAY_NAME} `))
  if (!registered) {
    cli(['gateway', 'add', '--local', '--name', GATEWAY_NAME, `https://127.0.0.1:${LOCAL_PORT}`])
    log(`CLI: registered gateway '${GATEWAY_NAME}'`)
  }

  // The CLI's client certificate. These files ARE the login: whoever holds
  // tls.key can talk to the gateway. Written after `gateway add --local`,
  // which copies in the certs of any local OpenShell gateway on this laptop.
  const mtls = `${CONFIG}/openshell/gateways/${GATEWAY_NAME}/mtls`
  await mkdir(mtls, { recursive: true, mode: 0o700 })
  for (const [remote, local] of [['pki/ca.crt', 'ca.crt'], ['pki/client/tls.crt', 'tls.crt'], ['pki/client/tls.key', 'tls.key']]) {
    await writeFile(`${mtls}/${local}`, await sbx.files.read(`${STATE}/${remote}`))
    await chmod(`${mtls}/${local}`, 0o600)
  }

  // Open the tunnel on the laptop. 10 s heartbeat: spike A showed E2B's
  // proxy drops connections that stay silent for about a minute.
  const client = spawn(`${process.cwd()}/.bin/wstunnel`, [
    'client', '-L', `tcp://127.0.0.1:${LOCAL_PORT}:127.0.0.1:${GATEWAY_PORT}`,
    '--http-upgrade-path-prefix', pathSecret,
    '-H', `e2b-traffic-access-token: ${token}`,
    '--websocket-ping-frequency', '10s',
    // Verify E2B's TLS certificate; wstunnel skips it by default.
    '--tls-verify-certificate',
    `wss://${sbx.getHost(TUNNEL_PORT)}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  // Surface tunnel errors (bind failures, auth rejections) instead of hiding them.
  client.stderr?.on('data', (d) => {
    const line = String(d).trim()
    if (/error|failed|denied|refused|in use/i.test(line)) log('tunnel client:', line.slice(0, 300))
  })
  log(`ready: laptop 127.0.0.1:${LOCAL_PORT} → gateway in ${sbx.sandboxId}`)
  log(`try:   XDG_CONFIG_HOME=${CONFIG} .bin/openshell status`)

  const stop = () => { client.kill(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  client.on('exit', (code) => { log('tunnel client exited', code); process.exit(1) })
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
