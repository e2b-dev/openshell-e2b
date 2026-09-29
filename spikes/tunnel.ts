// Spike A: secure tunnel into a private E2B sandbox.
//
// Checks, in order:
//   1. the sandbox URL rejects requests without E2B's traffic access token
//   2. a WebSocket tunnel with the token (and a secret upgrade path) works
//   3. a request with the token but the wrong path is rejected by wstunnel
//   4. the tunnel survives an idle period (default 6 min)
//
// The sandbox is private (allowPublicTraffic: false), wstunnel forwards only to
// 127.0.0.1:7000 (an echo service), and the sandbox is killed at the end.
import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { Sandbox } from 'e2b'

const WSTUNNEL = 'https://github.com/erebe/wstunnel/releases/download/v11.0.0/wstunnel_11.0.0_linux_amd64.tar.gz'
const PORT = 9000
const LOCAL = 17000
const IDLE_SEC = Number(process.env.IDLE_SEC ?? 360)
const PING = process.env.PING ?? '20s'
const CLIENT_LOG = process.env.CLIENT_LOG

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

function echoRoundTrip(bytes: Buffer, port = LOCAL): Promise<{ ok: boolean; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const sock = connect(port, '127.0.0.1')
    const chunks: Buffer[] = []
    let got = 0
    const done = (ok: boolean) => { sock.destroy(); resolve({ ok, ms: Date.now() - t0 }) }
    sock.setTimeout(30_000, () => done(false))
    sock.on('error', () => done(false))
    sock.on('connect', () => sock.write(bytes))
    sock.on('data', (d) => {
      chunks.push(d); got += d.length
      if (got >= bytes.length) done(Buffer.concat(chunks).subarray(0, bytes.length).equals(bytes))
    })
  })
}

async function main() {
  const sbx = await Sandbox.create('base', { timeoutMs: 60 * 60_000, network: { allowPublicTraffic: false } })
  log('sandbox', sbx.sandboxId, 'private:', Boolean(sbx.trafficAccessToken))
  const pathSecret = randomBytes(16).toString('hex')
  let client: ReturnType<typeof spawn> | undefined
  let badClient: ReturnType<typeof spawn> | undefined
  try {
    await sbx.commands.run(
      `cd /tmp && curl -fsSL ${WSTUNNEL} | tar xz wstunnel && chmod +x wstunnel && ` +
      `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq socat >/dev/null`,
      { timeoutMs: 180_000 },
    )
    await sbx.commands.run('socat TCP-LISTEN:7000,fork,reuseaddr EXEC:cat', { background: true })
    await sbx.commands.run(
      `/tmp/wstunnel server ws://0.0.0.0:${PORT} --restrict-to 127.0.0.1:7000 ` +
      `--restrict-http-upgrade-path-prefix ${pathSecret} > /tmp/wst.log 2>&1`,
      { background: true },
    )
    await new Promise((r) => setTimeout(r, 1500))
    const host = sbx.getHost(PORT)

    // 1. no token: E2B's proxy must refuse
    const noToken = await fetch(`https://${host}/${pathSecret}/events`)
    log('1. no token        ->', noToken.status, noToken.status >= 400 ? 'REJECTED (good)' : 'ACCEPTED (bad)')

    // 2. token + secret path: tunnel works
    client = spawn('.bin/wstunnel', [
      'client', '-L', `tcp://127.0.0.1:${LOCAL}:127.0.0.1:7000`,
      '--http-upgrade-path-prefix', pathSecret,
      '-H', `e2b-traffic-access-token: ${sbx.trafficAccessToken}`,
      '--websocket-ping-frequency', PING,
      `wss://${host}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, RUST_LOG: 'debug' } })
    client.stderr?.on('data', (d) => {
      if (CLIENT_LOG) import('node:fs').then((fs) => fs.appendFileSync(CLIENT_LOG, d))
      if (/error|denied|failed|close/i.test(String(d))) log('client:', String(d).trim().slice(0, 300))
    })
    await new Promise((r) => setTimeout(r, 1500))

    const small = await echoRoundTrip(Buffer.from('hello from openshell-e2b'))
    log('2. token + path    ->', small.ok ? 'ECHO OK' : 'FAILED', `${small.ms} ms`)
    const big = randomBytes(8 * 1024 * 1024)
    const bulk = await echoRoundTrip(big)
    log('   8 MiB echo      ->', bulk.ok ? 'OK' : 'FAILED', `${(16 / (bulk.ms / 1000)).toFixed(1)} MiB/s both ways`)

    // 3. token but wrong upgrade path: wstunnel must refuse
    badClient = spawn('.bin/wstunnel', [
      'client', '-L', `tcp://127.0.0.1:${LOCAL + 1}:127.0.0.1:7000`,
      '--http-upgrade-path-prefix', 'wrong-path',
      '-H', `e2b-traffic-access-token: ${sbx.trafficAccessToken}`,
      `wss://${host}`,
    ], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 1500))
    const wrong = await echoRoundTrip(Buffer.from('should not arrive'), LOCAL + 1)
    log('3. token, bad path ->', wrong.ok ? 'ECHO WORKED (bad)' : 'REJECTED (good)')
    badClient.kill()

    // 4. idle: one long-lived connection, silent for IDLE_SEC, then used again
    log(`4. idle test: holding one connection silent for ${IDLE_SEC}s`)
    const survived = await new Promise<boolean>((resolve) => {
      const sock = connect(LOCAL, '127.0.0.1')
      sock.on('error', () => resolve(false))
      sock.on('close', () => { log('   idle socket closed'); resolve(false) })
      sock.on('connect', () => setTimeout(() => {
        sock.once('data', (d) => { resolve(String(d) === 'still here'); sock.destroy() })
        sock.write('still here')
      }, IDLE_SEC * 1000))
    })
    log('   after idle      ->', survived ? 'CONNECTION ALIVE' : 'CONNECTION DROPPED')
    const srv = await sbx.commands.run('tail -20 /tmp/wst.log', { timeoutMs: 10_000 }).catch(() => undefined)
    log('server log:\n' + (srv?.stdout ?? '(none)'))
  } finally {
    client?.kill()
    badClient?.kill()
    await sbx.kill()
    log('sandbox killed')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
