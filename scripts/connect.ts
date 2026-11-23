// connect.ts: bring up (or reconnect to) the OpenShell control plane on E2B
// and link your laptop's `openshell` CLI to it. One command:
//
//   npm run connect              reuse the control box in .control-separated-id, or create one
//   npm run connect -- --new     always create a fresh control box
//
//   laptop                                         E2B control sandbox (private, openshell-control-separated template)
//   ┌───────────────────────────┐                  ┌──────────────────────────────────────────────┐
//   │ openshell CLI             │                  │  wstunnel server :9000 (secret path only)     │
//   │   → https://127.0.0.1:17691                  │     → 127.0.0.1:17670 openshell-gateway        │
//   │ wstunnel client :17691 ═══╪══ wss:// ════════╪══►        ↕ unix socket                       │
//   │   + e2b-traffic-access-token header          │     openshell-driver-e2b → E2B API (task pairs) │
//   └───────────────────────────┘                  └──────────────────────────────────────────────┘
//
// Layers of protection (defence in depth; the inner mTLS is what protects the session):
//   1. E2B rejects requests without the sandbox's traffic access token
//   2. wstunnel only accepts our random path and only forwards to the gateway port
//   3. the tunnel client verifies E2B's TLS certificate (otherwise 1 and 2 could be intercepted)
//   4. inside the tunnel, the CLI and gateway speak mutual TLS end to end
//      (supervisors use the same tunnel server with server-verified TLS + their launch JWT)
//
// Keeps running (it holds the tunnel open). Ctrl-C to stop; the control box keeps running.
// Note: on a team with a 1-hour sandbox cap the control box dies an hour after creation;
// run `npm run connect -- --new` shortly before a demo.
import { randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sandbox } from 'e2b'
import { TEMPLATES } from './openshell.ts'

const GATEWAY_PORT = 17670 // gateway inside the control box (localhost only)
const TUNNEL_PORT = 9000 // the only port we use through E2B's proxy
const LOCAL_PORT = 17691 // where the CLI connects on the laptop
const GATEWAY_NAME = 'e2b-separated'
const ROOT = '/opt/openshell-e2b' // baked into the openshell-control-separated template
const STATE = '/home/user/openshell' // per-box: certificates, config, logs
const CONFIG = `${process.cwd()}/.openshell-separated` // isolated CLI config on the laptop (gitignored)
const ID_FILE = '.control-separated-id'

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
  const sbx = await Sandbox.create(TEMPLATES.control, {
    timeoutMs: 60 * 60_000,
    network: { allowPublicTraffic: false },
    metadata: { 'openshell.ai/role': 'control-plane' },
  })
  await writeFile(ID_FILE, sbx.sandboxId)
  log('created control box', sbx.sandboxId, '(expires in 60 min on capped teams)')
  return sbx
}

async function main() {
  // Before changing anything locally or remotely: the status check at the
  // end must talk through this run's own tunnel, not a leftover one, so
  // refuse to start when the local tunnel port is already taken.
  const portFree = await new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', () => { resolve(false) })
    probe.listen(LOCAL_PORT, '127.0.0.1', () => { probe.close(() => { resolve(true) }) })
  })
  if (!portFree) {
    throw new Error(`127.0.0.1:${LOCAL_PORT} is in use: stop the other \`npm run connect\` (or its wstunnel) first`)
  }

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
  // Gateway config, schema version 2. Rewritten on every connect so a control
  // VM always runs the config this checkout expects.
  //   [openshell.gateway.tls]   laptop CLI and supervisors reach the gateway over TLS.
  //                             client_ca_path makes client certificates optional
  //                             but verified: the CLI presents one, supervisors
  //                             authenticate with their launch JWT instead.
  //   [openshell.gateway.mtls_auth]    a valid CLI certificate = a gateway user.
  //   [openshell.gateway.gateway_jwt]  mints launch credentials; without it
  //                             CreateSandbox arrives with no launch_authentication.
  //   [openshell.drivers.e2b]   our external compute driver's socket.
  await sbx.files.write(`${STATE}/gateway.toml`, [
    '[openshell]',
    'version = 2',
    '',
    '[openshell.gateway]',
    `bind_address   = "127.0.0.1:${GATEWAY_PORT}"`,
    'compute_driver = "e2b"',
    '',
    '[openshell.gateway.tls]',
    `cert_path      = "${STATE}/pki/server/tls.crt"`,
    `key_path       = "${STATE}/pki/server/tls.key"`,
    `client_ca_path = "${STATE}/pki/ca.crt"`,
    '',
    '[openshell.gateway.mtls_auth]',
    'enabled = true',
    '',
    '[openshell.gateway.gateway_jwt]',
    `signing_key_path = "${STATE}/pki/jwt/signing.pem"`,
    `public_key_path  = "${STATE}/pki/jwt/public.pem"`,
    `kid_path         = "${STATE}/pki/jwt/kid"`,
    'gateway_id       = "openshell-e2b"',
    'ttl_secs         = 3600',
    '',
    '[openshell.drivers.e2b]',
    `socket_path = "${STATE}/run/e2b.sock"`,
    '',
  ].join('\n'))
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
  // `ready` is a shell test that passes once the new process serves.
  const daemon = async (name: string, cmd: string, restart = false, ready?: string) => {
    const alive = await sbx.commands.run(
      `test -f ${STATE}/run/${name}.pid && kill -0 $(cat ${STATE}/run/${name}.pid) 2>/dev/null && echo yes || echo no`,
    )
    if (alive.stdout.trim() === 'yes') {
      if (!restart) {
        if (ready) await probe(name, ready)
        return log(`${name}: already running`)
      }
      // Wait until the old process is gone: the driver takes up to 15 s to
      // clean up and removes its socket file on exit, which would otherwise
      // delete the socket its replacement just created.
      await sbx.commands.run(
        `pid=$(cat ${STATE}/run/${name}.pid); kill $pid 2>/dev/null; ` +
        'for i in $(seq 100); do kill -0 $pid 2>/dev/null || exit 0; sleep 0.2; done; exit 1',
        { timeoutMs: 30_000 },
      ).catch(() => { throw new Error(`${name}: old process did not exit within 20 s`) })
    }
    // timeoutMs: 0 matters. The SDK's default is 60 s even for background
    // commands, so without it E2B kills the gateway after one minute.
    const handle = await sbx.commands.run(
      `cd ${STATE} && echo $$ > run/${name}.pid && exec ${cmd} > ${name}.log 2>&1`,
      { background: true, timeoutMs: 0 },
    )
    await handle.disconnect()
    if (ready) {
      await probe(name, ready)
    } else {
      await sleep(1000)
    }
    log(`${name}: started`)
  }
  // Up means: the readiness test passes, the process is alive, and it is
  // still alive two seconds later (the driver binds its socket before its
  // startup sweep, which can still fail). The end-to-end check is the
  // authenticated CLI status call below.
  async function probe(name: string, ready: string) {
    const alive = `kill -0 $(cat ${STATE}/run/${name}.pid) 2>/dev/null`
    await sbx.commands.run(
      `for i in $(seq 100); do ${alive} || break; ${ready} && sleep 2 && ${alive} && exit 0; sleep 0.2; done; ` +
      `tail -5 ${STATE}/${name}.log >&2; exit 1`,
      { timeoutMs: 40_000 },
    ).catch(() => { throw new Error(`${name}: not up; see ${STATE}/${name}.log in the control VM`) })
  }
  // Persist the transport path: reconnecting a laptop must not invalidate
  // the gateway channel of existing task supervisors.
  const pathFile = `${STATE}/gateway-path`
  const pathSecret = (await exists(pathFile))
    ? (await sbx.files.read(pathFile)).trim()
    : randomBytes(16).toString('hex')
  await sbx.files.write(pathFile, pathSecret)
  await sbx.files.write(`${STATE}/gateway-tunnel.json`, JSON.stringify({
    host: sbx.getHost(TUNNEL_PORT), token, path: pathSecret,
  }))
  await sbx.commands.run(`chmod 600 ${pathFile} ${STATE}/gateway-tunnel.json`)
  const restart = process.env.RESTART === '1'
  await daemon('wstunnel',
    `${ROOT}/bin/wstunnel server ws://0.0.0.0:${TUNNEL_PORT} --restrict-to 127.0.0.1:${GATEWAY_PORT} ` +
    `--restrict-http-upgrade-path-prefix ${pathSecret}`, restart)
  await daemon('driver',
    `sh -c 'set -a; . ${STATE}/driver.env; set +a; exec ${ROOT}/bin/openshell-driver-e2b ` +
    `--bind-socket ${STATE}/run/e2b.sock --template ${TEMPLATES.workload} ` +
    `--supervisor-template ${TEMPLATES.supervisor} --owner ${sbx.sandboxId} ` +
    `--helper ${ROOT}/helper/e2b-helper.ts --node ${ROOT}/node/bin/node ` +
    `--gateway-tunnel ${STATE}/gateway-tunnel.json --state-dir ${STATE}/sandboxes ` +
    `--gateway-ca ${STATE}/pki/ca.crt'`,
    restart, `test -S ${STATE}/run/e2b.sock`)
  await daemon('gateway', `${ROOT}/bin/openshell-gateway --config ${STATE}/gateway.toml`, restart,
    `(exec 3<>/dev/tcp/127.0.0.1/${GATEWAY_PORT}) 2>/dev/null`)

  // `gateway add --local` requires the client certificates to exist already.
  const mtls = `${CONFIG}/openshell/gateways/${GATEWAY_NAME}/mtls`
  await mkdir(mtls, { recursive: true, mode: 0o700 })
  for (const [remote, local] of [['pki/ca.crt', 'ca.crt'], ['pki/client/tls.crt', 'tls.crt'], ['pki/client/tls.key', 'tls.key']]) {
    await writeFile(`${mtls}/${local}`, await sbx.files.read(`${STATE}/${remote}`))
    await chmod(`${mtls}/${local}`, 0o600)
  }

  // Register the gateway with the isolated CLI config, unless it already is.
  const cli = (args: string[]) =>
    execFileSync('.bin/openshell', args, { env: { ...process.env, XDG_CONFIG_HOME: CONFIG }, encoding: 'utf8' })
  const registered = cli(['gateway', 'list']).split('\n').some((line) => line.replace('*', '').trim().startsWith(`${GATEWAY_NAME} `))
  if (!registered) {
    cli(['gateway', 'add', '--local', '--name', GATEWAY_NAME, `https://127.0.0.1:${LOCAL_PORT}`])
    log(`CLI: registered gateway '${GATEWAY_NAME}'`)
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
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // wstunnel expects a boolean, while many terminal tools set NO_COLOR=1.
    env: { ...process.env, NO_COLOR: 'true' },
  })
  // Surface tunnel errors (bind failures, auth rejections) instead of hiding them.
  client.stderr?.on('data', (d) => {
    const line = String(d).trim()
    if (/error|failed|denied|refused|in use/i.test(line)) log('tunnel client:', line.slice(0, 300))
  })
  // From here on, never leave the tunnel holding the port behind.
  const stop = () => { client.kill(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  client.on('exit', (code) => {
    log('tunnel client exited', code)
    process.exit(1)
  })
  // End to end: an authenticated gateway call from the laptop CLI through
  // the tunnel. Fails loudly instead of reporting a gateway that is not usable.
  let status = ''
  for (let i = 0; i < 30; i++) {
    try {
      // This gateway, through this tunnel: explicit flags, and no inherited
      // OPENSHELL_GATEWAY* variables pointing somewhere else.
      const { OPENSHELL_GATEWAY: _g, OPENSHELL_GATEWAY_ENDPOINT: _e, ...env } = process.env
      status = execFileSync('.bin/openshell', [
        '--gateway', GATEWAY_NAME, '--gateway-endpoint', `https://127.0.0.1:${LOCAL_PORT}`, 'status',
      ], { env: { ...env, XDG_CONFIG_HOME: CONFIG }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 })
      if (/Status: Connected/.test(status) && /Authentication: Authenticated/.test(status)) break
    } catch (e) {
      status = String((e as { stdout?: string }).stdout ?? e)
    }
    await sleep(1000)
  }
  if (!/Status: Connected/.test(status) || !/Authentication: Authenticated/.test(status)) {
    client.kill()
    throw new Error(`gateway not usable through the tunnel:\n${status}`)
  }
  log(`ready: laptop 127.0.0.1:${LOCAL_PORT} → gateway in ${sbx.sandboxId}`)
  log(`try:   XDG_CONFIG_HOME=${CONFIG} .bin/openshell status`)
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
