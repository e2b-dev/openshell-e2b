// Live, chapter-driven demo. Every displayed result comes from OpenShell or E2B.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sandbox, CommandExitError } from 'e2b'

const dir = 'dist/studio'
const file = `${dir}/state.json`
const exec = promisify(execFile)
const env = { ...process.env, XDG_CONFIG_HOME: `${process.cwd()}/.openshell-separated`, OPENSHELL_COLOR: 'never' }
const c = { reset: '\x1b[0m', dim: '\x1b[90m', blue: '\x1b[94m', green: '\x1b[92m', red: '\x1b[91m', amber: '\x1b[93m', bold: '\x1b[1m' }
type State = {
  name: string; control: string; supervisor?: string; worker?: string
  phase: 'creating' | 'ready' | 'cutting' | 'frozen' | 'deleted'
  checks: string[]; rootFence?: boolean; frozenHeartbeat?: string; createdAt: string
}
const state = async () => JSON.parse(await readFile(file, 'utf8')) as State
const save = async (s: State) => {
  await writeFile(`${file}.tmp`, JSON.stringify(s, null, 2) + '\n')
  await rename(`${file}.tmp`, file)
}
const line = (message: string, color = c.green) => console.log(`${color}${message}${c.reset}`)
const pass = (s: State, message: string) => { s.checks.push(message); line(`  ✓ ${message}`) }
const os = async (args: string[], timeout = 30_000) => {
  const command = exec('.bin/openshell', args, { env, timeout, maxBuffer: 4 * 1024 * 1024 })
  command.child.stdin?.end()
  return (await command).stdout
}
const inside = (s: State, cmd: string) => os(['sandbox', 'exec', '-n', s.name, '--no-tty', '--', 'sh', '-c', cmd])
async function run(sbx: Sandbox, cmd: string) {
  try { return await sbx.commands.run(cmd, { user: 'root', timeoutMs: 15_000 }) }
  catch (error) { if (error instanceof CommandExitError) return error; throw error }
}
async function pair(s: State) {
  const pages = Sandbox.list({ query: { metadata: { 'openshell.ai/driver-owner': s.control, 'openshell.ai/sandbox-name': s.name } } })
  const items = []
  while (pages.hasNext) items.push(...await pages.nextItems())
  return items
}
const probe = "curl --noproxy '*' -sS --connect-timeout 3 --max-time 5 -o /dev/null -w '%{http_code}' https://1.1.1.1/cdn-cgi/trace"
const sample = 'cat /tmp/agent-heartbeat; ps -u 1500 -o stat=,comm='

async function create() {
  const previous = await state().catch(() => undefined)
  assert(!previous || previous.phase === 'deleted', 'A studio task already exists. Run studio cleanup first.')
  await os(['status'])
  const s: State = { name: `studio-${Date.now().toString(36)}`, control: (await readFile('.control-separated-id', 'utf8')).trim(), phase: 'creating', checks: [], createdAt: new Date().toISOString() }
  await save(s)
  await writeFile(`${dir}/supervisor-events.jsonl`, '')
  console.log('Creating two private E2B microVMs…')
  const control = await Sandbox.connect(s.control)
  assert.equal((await run(control, 'pgrep -x openshell-super || true')).stdout.trim(), '')
  pass(s, 'Shared control plane: gateway + driver only')
  const creator = spawn('.bin/openshell', ['sandbox', 'create', '--name', s.name, '--no-tty', '--', 'sh', '-c', 'n=0; while :; do n=$((n+1)); printf "%s\\n" "$n" > /tmp/agent-heartbeat; sleep 0.5; done'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let errors = ''
  creator.stderr.on('data', chunk => { errors += String(chunk) })
  try {
    let ready = false
    for (let i = 0; i < 90; i++) {
      const list = await os(['sandbox', 'list'])
      if (list.split('\n').some(row => row.startsWith(s.name + ' ') && /\bReady\b/.test(row))) { ready = true; break }
      assert(creator.exitCode === null || creator.exitCode === 0, `Create failed: ${errors}`)
      await sleep(1_000)
    }
    assert(ready, 'Pair did not become Ready')
    const items = await pair(s)
    assert.equal(items.length, 2)
    s.supervisor = items.find(item => item.metadata['openshell.ai/role'] === 'supervisor')?.sandboxId
    s.worker = items.find(item => item.metadata['openshell.ai/role'] === 'worker')?.sandboxId
    assert(s.supervisor && s.worker && new Set([s.control, s.supervisor, s.worker]).size === 3)
    pass(s, 'Supervisor A and worker B are distinct microVMs')
    const worker = await Sandbox.connect(s.worker)
    assert.equal((await run(worker, 'test ! -e /run/openshell-task/auth.json && test ! -e /opt/openshell/openshell-supervisor')).exitCode, 0)
    const identity = await inside(s, 'id -u; grep -E "^(CapEff|NoNewPrivs)" /proc/self/status')
    assert.match(identity, /^1500\n/); assert.match(identity, /CapEff:\s+0+/); assert.match(identity, /NoNewPrivs:\s+1/)
    pass(s, 'Worker: uid 1500, zero capabilities, no supervisor auth')
    s.phase = 'ready'
    await save(s)
    console.log(`\n  A / supervisor  ${s.supervisor}\n  B / worker      ${s.worker}`)
    console.log('\n  agent in B ── TLS channel ──► policy in A ──► internet')
    line('\nPAIR READY', c.blue)
  } finally { creator.kill() }
}

async function fence(s: State) {
  assert.equal(s.phase, 'ready')
  const denied = await inside(s, 'if curl -sS -m 5 https://api.github.com/zen >/dev/null 2>&1; then echo UNEXPECTED; else echo DEFAULT_DENY; fi')
  assert.match(denied, /DEFAULT_DENY/)
  pass(s, 'OpenShell blocks GitHub before policy is added')
  const [a, b] = await Promise.all([Sandbox.connect(s.supervisor!), Sandbox.connect(s.worker!)])
  const [allowed, blocked] = await Promise.all([run(a, probe), run(b, probe)])
  assert.equal(allowed.exitCode, 0); assert.equal(allowed.stdout, '200')
  assert.notEqual(blocked.exitCode, 0); assert.equal(blocked.stdout, '000')
  console.log('\n  Same direct HTTPS probe, as root, outside agent namespaces:')
  line('  A / supervisor   HTTP 200    upstream reachable')
  line('  B / worker       HTTP 000    E2B egress fence', c.red)
  pass(s, 'Worker root cannot bypass the external network fence')
  s.rootFence = true
  await save(s)
  line('\nFENCE VERIFIED', c.blue)
}

async function policy(s: State) {
  assert.equal(s.phase, 'ready')
  const worker = await Sandbox.connect(s.worker!)
  const before = Number((await run(worker, 'cat /tmp/agent-heartbeat')).stdout.trim())
  assert(Number.isFinite(before) && before > 0, 'Expected a running agent heartbeat')
  const base = await os(['policy', 'get', s.name, '--base'])
  const split = base.indexOf('\n---\n')
  assert(split >= 0)
  await writeFile(`${dir}/policy.yaml`, base.slice(split + 5) + '\nnetwork_policies:\n  github:\n    name: github-readonly\n    endpoints:\n      - host: api.github.com\n        port: 443\n        protocol: rest\n        enforcement: enforce\n        access: read-only\n    binaries:\n      - path: /usr/bin/curl\n')
  console.log('  program  /usr/bin/curl\n  host     api.github.com:443\n  access   read-only\n')
  console.log((await os(['policy', 'set', s.name, '--policy', `${dir}/policy.yaml`, '--wait'])).trim())
  await sleep(600)
  const after = Number((await run(worker, 'cat /tmp/agent-heartbeat')).stdout.trim())
  assert(after > before, 'Agent heartbeat must advance across the policy update')
  pass(s, 'Policy updated live; worker keeps running')
  await save(s)
  line('\nPOLICY ACTIVE', c.blue)
}

async function requests(s: State) {
  assert.equal(s.phase, 'ready')
  const get = (await inside(s, 'curl -sS -m 15 -o /dev/null -w "%{http_code}" https://api.github.com/zen')).trim()
  assert.equal(get, '200'); pass(s, 'curl GET  /zen    → HTTP 200')
  const post = (await inside(s, 'curl -sS -m 15 -o /dev/null -w "%{http_code}" -X POST -d "{}" https://api.github.com/gists')).trim()
  assert.equal(post, '403'); pass(s, 'curl POST /gists  → HTTP 403')
  const wget = await inside(s, 'command -v wget >/dev/null || exit 9; if wget -q -T 5 -t 1 -O /dev/null https://api.github.com/zen; then echo UNEXPECTED; else echo DENIED; fi')
  assert.match(wget, /DENIED/); pass(s, 'wget GET  /zen    → program denied')
  const audit = await os(['logs', s.name])
  assert.match(audit, /HTTP:GET .*ALLOWED/); assert.match(audit, /HTTP:POST .*DENIED/)
  pass(s, 'Allow / deny audit arrives from separate supervisor A')
  await save(s)
  line('\nREQUESTS VERIFIED', c.blue)
}

async function sever(s: State) {
  assert.equal(s.phase, 'ready')
  s.phase = 'cutting'; await save(s)
  line('Terminating supervisor sandbox A…', c.amber)
  await Sandbox.kill(s.supervisor!)
  const worker = await Sandbox.connect(s.worker!)
  let frozen = ''
  for (let i = 0; i < 30; i++) {
    const observation = await run(worker, sample)
    if (observation.stdout.split('\n').some(row => /^T\S*\s+(sh|sleep)$/.test(row.trim()))) { frozen = observation.stdout.split('\n')[0].trim(); break }
    await sleep(1_000)
  }
  assert(frozen, 'Expected stopped agent process in worker B')
  await sleep(1_200)
  assert.equal((await run(worker, 'cat /tmp/agent-heartbeat')).stdout.trim(), frozen, 'Agent heartbeat must stop')
  pass(s, `Worker is still alive; agent FROZEN at heartbeat ${frozen}`)
  s.frozenHeartbeat = frozen; s.phase = 'frozen'; await save(s)
  const blocked = await run(worker, probe)
  assert.notEqual(blocked.exitCode, 0); assert.equal(blocked.stdout, '000')
  pass(s, 'Root egress remains blocked after supervisor loss')
  await save(s)
  line('\nFAIL-CLOSED VERIFIED', c.red)
}

async function cleanup(s: State) {
  if (s.phase === 'deleted') return
  await os(['sandbox', 'delete', s.name]).catch(() => {})
  for (let i = 0; i < 15; i++) {
    const left = await pair(s)
    if (!left.length) break
    if (i === 10) for (const item of left) await Sandbox.kill(item.sandboxId)
    await sleep(1_000)
  }
  assert.equal((await pair(s)).length, 0, 'Both task VMs must be gone')
  pass(s, 'Both task microVMs removed')
  await os(['status']); pass(s, 'Shared control plane stays available')
  s.phase = 'deleted'; await save(s)
  line(`\nCLEANUP VERIFIED · ${s.checks.length} live assertions`, c.blue)
}

function auditLine(raw: string): string | undefined {
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '')
  if (/Policy reloaded successfully/.test(text)) return `${c.blue}POLICY UPDATED  ·  live, no restart`
  if (/Isolation boundary attached/.test(text)) return `${c.blue}TLS channel attached to worker B`
  if (/Isolation boundary enforcement confirmed/.test(text)) return `${c.green}Worker isolation confirmed`
  let match = text.match(/HTTP:(\w+) .*?(ALLOWED|DENIED).*?http:\/\/[^/]+(\/\S*)/)
  if (match) return `${match[2] === 'ALLOWED' ? c.green : c.red}${match[2].padEnd(7)} ${match[1].padEnd(5)} ${match[3]}`
  match = text.match(/NET:OPEN .*?(ALLOWED|DENIED) \/usr\/bin\/(\w+)\(\d+\) -> (\S+)/)
  if (match) return `${match[1] === 'ALLOWED' ? c.green : c.red}${match[1].padEnd(7)} ${match[2].padEnd(5)} ${match[3]}`
  return undefined
}

async function supervisorFeed() {
  line('Waiting for supervisor A…', c.dim)
  let current = ''; let handle: { kill(): Promise<boolean> } | undefined; let offline = false
  const stop = async () => { await handle?.kill().catch(() => {}); process.exit(0) }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  while (true) {
    const s = await state().catch(() => undefined)
    if (s?.supervisor && s.phase !== 'deleted' && current !== s.supervisor) {
      current = s.supervisor; offline = false
      console.log('\x1b[2J\x1b[H')
      line(`A / ${s.supervisor}`, c.blue)
      console.log('Separate guest kernel · policy + proxy\n')
      const a = await Sandbox.connect(s.supervisor)
      let partial = ''
      handle = await a.commands.run('exec tail -n +1 -F /run/openshell-task/supervisor.log', {
        user: 'root', background: true, timeoutMs: 0,
        onStdout: chunk => {
          const lines = (partial + chunk).split('\n'); partial = lines.pop() ?? ''
          for (const raw of lines) {
            const formatted = auditLine(raw)
            if (formatted) {
              console.log(formatted + c.reset)
              void appendFile(`${dir}/supervisor-events.jsonl`, JSON.stringify({ observedAt: new Date().toISOString(), raw: raw.replace(/\x1b\[[0-9;]*m/g, '') }) + '\n')
            }
          }
        },
      })
    }
    // Phase is set only after the SDK kill and kernel-state assertion succeed.
    if (s?.phase === 'frozen' && !offline) { offline = true; line('\n■ SUPERVISOR VM TERMINATED', c.red); console.log('Worker B remains isolated.'); }
    if (s?.phase === 'deleted' && current && !offline) { offline = true; line('\n■ SUPERVISOR VM REMOVED', c.dim) }
    await sleep(400)
  }
}

async function workerFeed() {
  let worker: Sandbox | undefined; let current = ''; let previous = ''; let last = ''
  while (true) {
    const s = await state().catch(() => undefined)
    let screen = `${c.blue}Waiting for worker B…${c.reset}`
    if (s?.worker) {
      if (current !== s.worker) { current = s.worker; worker = await Sandbox.connect(s.worker); previous = '' }
      if (s.phase === 'deleted') screen = `${c.blue}B / ${s.worker}${c.reset}\n\n${c.green}■ WORKER VM REMOVED\n\nTask pair cleaned up.${c.reset}`
      else {
        try {
          const result = await run(worker!, sample)
          assert.equal(result.exitCode, 0)
          const beat = result.stdout.split('\n')[0].trim()
          const stopped = result.stdout.split('\n').some(row => /^T\S*\s+(sh|sleep)$/.test(row.trim()))
          screen = `${c.blue}B / ${s.worker}${c.reset}\nSeparate guest kernel · runtime + agent\n\n${stopped ? c.red : c.green}${c.bold}${stopped ? '■ AGENT FROZEN' : '● AGENT RUNNING'}${c.reset}\n\nHeartbeat   ${beat.padStart(5, '0')}  ${stopped ? 'STOPPED' : beat !== previous ? '▂ ▄ ▆ █ ▆ ▄' : '▁ ▂ ▄ ▆ ▄ ▂'}\nKernel      ${stopped ? 'T = stopped by runtime' : 'agent process active'}\nIdentity    uid 1500 · zero caps\nRoot egress ${s.rootFence ? 'DENIED · verified HTTPS probe' : 'probe pending'}\n\n${c.dim}Heartbeat and process state read live from B.${c.reset}`
          previous = beat
        } catch { screen = `${c.amber}Worker observation unavailable; checking lifecycle…${c.reset}` }
      }
    }
    if (screen !== last) { process.stdout.write('\x1b[2J\x1b[H' + screen + '\n'); last = screen }
    await sleep(700)
  }
}

await mkdir(dir, { recursive: true })
const command = process.argv[2]
try {
  if (command === 'supervisor-feed') await supervisorFeed()
  else if (command === 'worker-feed') await workerFeed()
  else if (command === 'create') await create()
  else if (command === 'reset') {
    const s = await state().catch(() => undefined)
    assert(!s || s.phase === 'deleted', 'Run studio cleanup before reset')
    await rm(file, { force: true })
  }
  else {
    const actions = { fence, policy, requests, sever, cleanup }
    assert(command in actions, 'Usage: studio create|fence|policy|requests|sever|cleanup')
    await actions[command as keyof typeof actions](await state())
  }
} catch (error) { console.error(`STUDIO FAILED: ${(error as Error).message}`); process.exitCode = 1 }
