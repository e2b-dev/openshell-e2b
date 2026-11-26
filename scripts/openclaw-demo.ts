// openclaw-demo.ts: a personal agent (OpenClaw) on E2B, governed by OpenShell.
//
//   npm run openclaw -- setup              sandbox with OpenClaw + the Anthropic key provider
//   npm run openclaw -- ask "<message>"    one agent turn, then the new audit records
//   npm run openclaw -- web                OpenClaw's web chat on http://127.0.0.1:18789, via OpenShell
//   npm run openclaw -- allow <host>       allow <host> read-only for OpenClaw, live
//   npm run openclaw -- audit              what the agent reached and what was blocked
//   npm run openclaw -- check              assert the demo's three outcomes from the audit log
//   npm run openclaw -- cleanup            delete the sandbox and the provider
//   npm run openclaw -- run                the whole scripted demo, with checks
//
// Needs a gateway whose driver uses the OpenClaw worker template:
//   OPENSHELL_WORKLOAD_TEMPLATE=openshell-workload-openclaw npm run connect
// and ANTHROPIC_API_KEY in .env. The key goes into an OpenShell provider on the
// gateway; inside the sandbox OpenClaw only sees a placeholder.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const SANDBOX = 'claw'
const PROVIDER = 'anthropic'
const PROFILE = 'providers/openclaw-anthropic.yaml'
const NODE = '/usr/lib/openclaw/tools/node-v24.22.1/bin/node' // OpenClaw's bundled Node
const CONFIG = join(process.cwd(), '.openshell-separated')
const STATE = 'dist/openclaw-demo/state.json'

const c = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m', blue: '\x1b[34m', magenta: '\x1b[35m', yellow: '\x1b[33m', reset: '\x1b[0m' }

// Wall-clock marks for the video editor (media/openclaw/compose.ts): where the waits are.
function markEvent(event: string) {
  if (process.env.CLAW_MARKS) { appendFileSync(process.env.CLAW_MARKS, `${JSON.stringify({ event, t: Date.now() / 1000 })}\n`) }
}

// Runs `task` while a one-line spinner shows the real elapsed time.
async function spin<T>(label: string, task: () => Promise<T>): Promise<T> {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  const started = Date.now()
  const tty = process.stdout.isTTY
  let i = 0
  const tick = () => { if (tty) { process.stdout.write(`\r${c.yellow}${frames[i++ % frames.length]}${c.reset} ${c.dim}${label} · ${Math.floor((Date.now() - started) / 1000)}s${c.reset}\x1b[K`) } }
  tick()
  const timer = setInterval(tick, 100)
  markEvent('wait_start')
  try {
    return await task()
  } finally {
    markEvent('wait_end')
    clearInterval(timer)
    if (tty) { process.stdout.write('\r\x1b[K') }
  }
}

function osAsync(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('.bin/openshell', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => { code === 0 ? resolve(out) : reject(new Error(`openshell ${args.join(' ')}: ${(err || out).trim()}`)) })
  })
}
const working = (label: string, args: string[]) => spin(label, () => osAsync(args))
const workingInside = (label: string, cmd: string) => working(label, ['sandbox', 'exec', '-n', SANDBOX, '--no-tty', '--', 'sh', '-c', cmd])
const env = { ...process.env, XDG_CONFIG_HOME: CONFIG, OPENSHELL_COLOR: 'never' }

function os(args: string[], input?: string): string {
  const r = spawnSync('.bin/openshell', args, { env, encoding: 'utf8', input: input ?? '', timeout: 600_000 })
  if (r.status !== 0) throw new Error(`openshell ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout
}
const inside = (cmd: string) => os(['sandbox', 'exec', '-n', SANDBOX, '--no-tty', '--', 'sh', '-c', cmd])

// --- audit: the sandbox's OpenShell log, reduced to network decisions ---------

type Record = { t: number; allowed: boolean; line: string }

function audit(): Record[] {
  const records: Record[] = []
  for (const raw of os(['logs', SANDBOX]).split('\n')) {
    const t = Number(/^\[(\d+\.\d+)\]/.exec(raw)?.[1] ?? 0)
    const http = /HTTP:\w+ \[\w+\] (ALLOWED|DENIED) (\w+) (\S+)/.exec(raw)
    const net = /NET:OPEN \[\w+\] (ALLOWED|DENIED) (\S+?)\(\d+\) -> (\S+)/.exec(raw)
    if (http && !http[3].includes('api.anthropic.com')) {
      records.push({ t, allowed: http[1] === 'ALLOWED', line: `${http[2].padEnd(5)} ${http[3]}` })
    } else if (http) {
      records.push({ t, allowed: true, line: 'model call  api.anthropic.com  (key added by the supervisor)' })
    } else if (net && net[1] === 'DENIED') {
      records.push({ t, allowed: false, line: `${net[2].split('/').pop()?.padEnd(5)} ${net[3]}` })
    }
  }
  return records
}

function show(records: Record[]) {
  let model = 0
  console.log(`  ${c.magenta}${c.bold}OpenShell${c.reset}`)
  for (const r of records) {
    if (r.line.startsWith('model call')) { model++; continue }
    console.log(r.allowed ? `    ${c.green}✓ ALLOWED${c.reset}  ${r.line}` : `    ${c.red}✗ DENIED ${c.reset}  ${r.line}`)
  }
  if (model) { console.log(`    ${c.dim}✓ ${model} model call${model > 1 ? 's' : ''} to api.anthropic.com, key added outside the VM${c.reset}`) }
}

const since = (): number => { try { return JSON.parse(readFileSync(STATE, 'utf8')).seen ?? 0 } catch { return 0 } }
const mark = (seen: number) => { mkdirSync('dist/openclaw-demo', { recursive: true }); writeFileSync(STATE, JSON.stringify({ seen })) }

// --- steps --------------------------------------------------------------------

async function setup() {
  const key = /^ANTHROPIC_API_KEY=(.+)$/m.exec(readFileSync('.env', 'utf8'))?.[1]?.trim()
  assert(key, 'ANTHROPIC_API_KEY is missing from .env')
  const { version, placeholder } = await spin('creating the sandbox: supervisor VM + agent VM', async () => {
    try { os(['provider', 'profile', 'import', '-f', PROFILE, '--global']) } catch { /* already imported */ }
    try { os(['provider', 'get', PROVIDER]) } catch {
      // The key reaches the CLI through its environment, never its arguments.
      const r = spawnSync('.bin/openshell', ['provider', 'create', '--name', PROVIDER, '--type', 'openclaw-anthropic', '--from-existing'],
        { env: { ...env, ANTHROPIC_API_KEY: key }, encoding: 'utf8', input: '' })
      if (r.status !== 0) { throw new Error(`provider create: ${r.stderr.trim()}`) }
    }
    // `create` stays attached to the sandbox's command, so it runs detached; readiness is polled.
    mkdirSync('dist/openclaw-demo', { recursive: true })
    const log = openSync('dist/openclaw-demo/create.log', 'w')
    spawn('.bin/openshell', ['sandbox', 'create', '--name', SANDBOX, '--provider', PROVIDER, '--no-tty', '--', 'sleep', 'infinity'],
      { env, detached: true, stdio: ['ignore', log, log] }).unref()
    let ready = false
    for (let i = 0; i < 180 && !ready; i++) {
      ready = (await osAsync(['sandbox', 'list'])).split('\n').some((l) => l.startsWith(`${SANDBOX} `) && /\bReady\b/.test(l))
      if (!ready) { await new Promise((r) => setTimeout(r, 1000)) }
    }
    if (!ready) { throw new Error(`sandbox did not become Ready: ${readFileSync('dist/openclaw-demo/create.log', 'utf8')}`) }
    const run = async (cmd: string) => (await osAsync(['sandbox', 'exec', '-n', SANDBOX, '--no-tty', '--', 'sh', '-c', cmd])).trim()
    return {
      version: await run('openclaw --version | head -1'),
      placeholder: await run('v="$ANTHROPIC_API_KEY"; echo "${v%"${v#????????????????????}"}…"'),
    }
  })
  console.log(`${c.green}●${c.reset} ${c.bold}AGENT READY${c.reset}  ${version.replace(/ \(.*\)/, '')} in its own E2B microVM`)
  console.log(`  ${c.dim}API key inside the VM:${c.reset} ${c.cyan}${placeholder}${c.reset}  ${c.dim}placeholder; OpenShell adds the real key outside${c.reset}`)
  mark(Date.now() / 1000)
}

async function ask(message: string) {
  console.log(`${c.blue}${c.bold}you${c.reset}       ${message}`)
  const out = await workingInside('openclaw is working in its microVM', `cd /sandbox && timeout 300 openclaw agent exec --cwd /sandbox ${JSON.stringify(message)} 2>/dev/null`)
  const lines = out.split('\n').filter((l) => l.trim() && !l.startsWith('[') && !l.startsWith('```') && !l.includes('EXTERNAL_UNTRUSTED_CONTENT'))
  const reply = lines.slice(0, 3).map((l, i) => (i ? '          ' : '') + l.trim()).join('\n')
  console.log(`${c.yellow}${c.bold}openclaw${c.reset}  ${reply}`)
  await new Promise((r) => setTimeout(r, 2000)) // let the supervisor's records arrive
  const records = audit().filter((r) => r.t > since())
  console.log('')
  show(records)
  console.log('')
  if (records.length) { mark(Math.max(...records.map((r) => r.t))) }
  return records
}

async function allow(host: string) {
  const base = os(['policy', 'get', SANDBOX, '--base'])
  const yaml = base.slice(base.indexOf('\n---\n') + 5)
  const current = os(['policy', 'get', SANDBOX])
  // Keep earlier grants: add this host to the demo's own rule list.
  const hosts = [...new Set([...(/# demo-hosts: (.*)/.exec(current)?.[1]?.split(',').filter(Boolean) ?? []), host])]
  const rules = hosts.map((h) => `  ${h.replace(/[^a-z0-9]/gi, '_')}:
    name: ${h} read-only
    endpoints:
      - host: ${h}
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-only
    binaries:
      - path: ${NODE}`).join('\n')
  const file = 'dist/openclaw-demo/policy.yaml'
  mkdirSync('dist/openclaw-demo', { recursive: true })
  writeFileSync(file, `${yaml.trimEnd()}\n# demo-hosts: ${hosts.join(',')}\nnetwork_policies:\n${rules}\n`)
  await working('updating the policy, live', ['policy', 'set', SANDBOX, '--policy', file, '--wait'])
  console.log(`${c.green}●${c.reset} ${c.bold}POLICY UPDATED${c.reset}  ${host}  ${c.dim}read-only (GET), OpenClaw only, no restart${c.reset}`)
}

function summary() {
  const records = audit()
  console.log(`${c.bold}Everything the agent reached, and everything that was blocked:${c.reset}\n`)
  show(records)
  return records
}

// OpenClaw's own web chat (Control UI). It listens on loopback inside the agent VM;
// `openshell forward service` carries it to the laptop over the gateway channel,
// so the VM needs no public port.
const WEB_PORT = 18789
const WEB_STATE = 'dist/openclaw-demo/web.json'

async function web() {
  const token = randomBytes(16).toString('hex')
  await spin('starting OpenClaw web chat in the microVM', async () => {
    await osAsync(['sandbox', 'exec', '-n', SANDBOX, '--no-tty', '--', 'sh', '-c',
      `cd /sandbox && OPENCLAW_STATE_DIR=/sandbox/.openclaw nohup setsid openclaw gateway --allow-unconfigured --bind loopback --port ${WEB_PORT} --auth token --token ${token} >/tmp/openclaw-gateway.log 2>&1 </dev/null &
       for i in $(seq 60); do ss -ltn | grep -q ':${WEB_PORT} ' && exit 0; sleep 1; done; tail -20 /tmp/openclaw-gateway.log; exit 1`])
    const log = openSync('dist/openclaw-demo/forward.log', 'w')
    const forward = spawn('.bin/openshell', ['forward', 'service', '--target-port', String(WEB_PORT), '--local', `127.0.0.1:${WEB_PORT}`, SANDBOX],
      { env, detached: true, stdio: ['ignore', log, log] })
    forward.unref()
    writeFileSync(WEB_STATE, JSON.stringify({ pid: forward.pid, url: `http://127.0.0.1:${WEB_PORT}/#token=${token}` }))
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(`http://127.0.0.1:${WEB_PORT}/`)).ok) { return } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`web chat did not come up: ${readFileSync('dist/openclaw-demo/forward.log', 'utf8')}`)
  })
  console.log(`${c.green}●${c.reset} ${c.bold}WEB CHAT${c.reset}  http://127.0.0.1:${WEB_PORT}  ${c.dim}OpenClaw's own UI, tunneled by OpenShell; no public port${c.reset}`)
}

function cleanup() {
  try { process.kill(JSON.parse(readFileSync(WEB_STATE, 'utf8')).pid) } catch { /* no forward running */ }
  for (const args of [['sandbox', 'delete', SANDBOX], ['provider', 'delete', PROVIDER]]) {
    try { os(args) } catch { /* already gone */ }
  }
  console.log('cleaned up')
}

// --- the scripted demo, with checks -----------------------------------------------

const HN = 'news.ycombinator.com'
const HOOK = 'hooks.team.example'
// Plain requests, as a person would type them. The same text goes into the web chat in the video.
export const PROMPTS = {
  question: "What's the top story on Hacker News right now? Just the title.",
  retry: 'Try again.',
  webhook: `Post "HN check done" to my team webhook at https://${HOOK}/notes with curl.`,
}

// The three facts the demo is about, checked against the full audit log.
function check() {
  const records = audit()
  assert(records.some((r) => !r.allowed && r.line.includes(HN)), 'expected a denied request to Hacker News before the grant')
  assert(records.some((r) => r.allowed && r.line.startsWith('GET') && r.line.includes(HN)), 'expected an allowed GET to Hacker News after the grant')
  assert(records.some((r) => !r.allowed && r.line.includes(HOOK)), 'expected the webhook upload to be denied')
  console.log(`${c.green}PASS${c.reset}  denied before the grant, allowed read-only after it, webhook upload denied`)
}

async function run() {
  await setup()
  await ask(PROMPTS.question)
  await allow(HN)
  await ask(PROMPTS.question)
  await ask(PROMPTS.webhook)
  summary()
  check()
}

async function main(command: string | undefined, rest: string[]) {
  if (command === 'setup') { await setup() }
  else if (command === 'ask' && rest[0] === 'webhook') { await ask(PROMPTS.webhook) }
  else if (command === 'ask') { await ask(rest.length ? rest.join(' ') : PROMPTS.question) }
  else if (command === 'web') { await web() }
  else if (command === 'allow') { await allow(rest[0] ?? HN) }
  else if (command === 'audit') { summary() }
  else if (command === 'check') { check() }
  else if (command === 'cleanup') { cleanup() }
  else if (command === 'run') { try { await run() } finally { cleanup() } }
  else { console.error('usage: openclaw-demo.ts setup | web | ask ["<message>" | webhook] | allow <host> | audit | check | cleanup | run'); process.exitCode = 2 }
}

const [command, ...rest] = process.argv.slice(2)
if (import.meta.url === `file://${process.argv[1]}`) {
  main(command, rest).catch((error: unknown) => {
    console.error(`${c.red}FAIL${c.reset}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
