// fleet.ts: a small coding-agent fleet on E2B, governed by OpenShell.
//
//   npm run fleet            3 workers in parallel (2 Claude Code, 1 Codex), one issue each
//   npm run fleet -- --keep  leave the sandboxes running for inspection
//
// Each worker is an OpenShell sandbox: an agent VM with no egress of its own and a
// supervisor VM that applies the policy. The only thing a worker may reach is its own
// model API, through a provider: the agent sees a placeholder, and the supervisor adds
// the real key for that agent's binary only. The manager (this script) uploads the
// repo, runs the agent on its issue, reruns the test itself and reads the audit log.
//
// Needs a gateway whose driver uses the two-agent worker template:
//   OPENSHELL_WORKLOAD_TEMPLATE=openshell-workload-agents npm run connect
// and ANTHROPIC_API_KEY (plus OPENAI_API_KEY for the Codex worker) in .env.
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Agent = 'claude' | 'codex'
type Worker = { n: number; agent: Agent; issue: string; test: string }

const WORKERS: Worker[] = [
  { n: 1, agent: 'claude', issue: '1-slugify', test: 'slugify' },
  { n: 2, agent: 'claude', issue: '2-duration', test: 'duration' },
  { n: 3, agent: 'codex', issue: '3-csv', test: 'csv' },
]
const PROVIDERS: Record<Agent, { profile: string; type: string; key: string; name: string }> = {
  claude: { profile: 'providers/fleet-claude-code.yaml', type: 'fleet-claude-code', key: 'ANTHROPIC_API_KEY', name: 'fleet-anthropic' },
  codex: { profile: 'providers/fleet-codex.yaml', type: 'fleet-codex', key: 'OPENAI_API_KEY', name: 'fleet-openai' },
}
const CLAUDE_MODEL = process.env.FLEET_CLAUDE_MODEL ?? 'claude-haiku-4-5'
const OUT = 'dist/fleet'
// `sandbox upload` puts a folder inside DEST under its own name.
const REPO = '/sandbox/fleet-repo'
const run = Date.now().toString(36).slice(-4)
const keep = process.argv.includes('--keep')

const c = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', reset: '\x1b[0m' }
const env = { ...process.env, XDG_CONFIG_HOME: join(process.cwd(), '.openshell-separated'), OPENSHELL_COLOR: 'never' }

function os(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('.bin/openshell', args, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out)
      } else {
        reject(new Error(`openshell ${args.slice(0, 2).join(' ')}: ${(err || out).trim().slice(0, 400)}`))
      }
    })
  })
}
const sh = (sandbox: string, cmd: string) => os(['sandbox', 'exec', '-n', sandbox, '--no-tty', '--', 'sh', '-c', cmd])
const name = (w: Worker) => `fleet-${run}-${w.n}`
const tag = (w: Worker) => `${c.dim}[${w.n}]${c.reset} ${w.agent === 'claude' ? c.yellow : c.blue}${w.agent.padEnd(6)}${c.reset}`
const log = (w: Worker, text: string) => console.log(`${tag(w)} ${text}`)

// --- audit -------------------------------------------------------------------------

type Decision = { time: number; allowed: boolean; who: string; target: string }

function parseAudit(text: string): Decision[] {
  const decisions: Decision[] = []
  for (const line of text.split('\n')) {
    const time = Number(/^\[(\d+(?:\.\d+)?)\]/.exec(line)?.[1] ?? 0)
    const http = /HTTP:\w+ \[\w+\] (ALLOWED|DENIED) (\w+) (\S+)/.exec(line)
    const net = /NET:OPEN \[\w+\] (DENIED) (\S+?)\(\d+\) -> (\S+)/.exec(line)
    if (http) {
      decisions.push({ time, allowed: http[1] === 'ALLOWED', who: http[2], target: http[3] })
    } else if (net) {
      decisions.push({ time, allowed: false, who: net[2].split('/').pop() ?? net[2], target: net[3] })
    }
  }
  return decisions
}

// --- one worker -------------------------------------------------------------------

type Result = Worker & {
  agentUsed: Agent
  sandbox: string
  seconds: number
  testsPass: boolean
  testsUntouched: boolean
  diff: string
  modelCalls: number
  denied: string[]
  error?: string
}

async function createSandbox(sandbox: string, provider: string) {
  const out = openSync(join(OUT, `${sandbox}-create.log`), 'w')
  spawn('.bin/openshell', ['sandbox', 'create', '--name', sandbox, '--provider', provider, '--no-tty', '--', 'sleep', 'infinity'],
    { env, detached: true, stdio: ['ignore', out, out] }).unref()
  for (let i = 0; i < 180; i++) {
    if ((await os(['sandbox', 'list'])).split('\n').some((l) => l.startsWith(`${sandbox} `) && /\bReady\b/.test(l))) {
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`${sandbox} did not become Ready; see ${OUT}/${sandbox}-create.log`)
}

function agentCommand(agent: Agent, issue: string) {
  const task = `Fix the issue below in src/. Run its test to check your fix. Do not change the tests.\n\n$(cat issues/${issue}.md)`
  if (agent === 'claude') {
    return `claude -p "${task}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions --output-format text`
  }
  // OpenShell is the sandbox here, so Codex's own sandbox and approvals are off.
  return `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "${task}"`
}

async function work(w: Worker, agent: Agent): Promise<Result> {
  const sandbox = name(w)
  const started = Date.now()
  const result: Result = { ...w, agentUsed: agent, sandbox, seconds: 0, testsPass: false, testsUntouched: false, diff: '', modelCalls: 0, denied: [] }
  try {
    log(w, `creating ${sandbox} (supervisor VM + agent VM)`)
    await createSandbox(sandbox, PROVIDERS[agent].name)
    await os(['sandbox', 'upload', sandbox, 'fixtures/fleet-repo', '/sandbox'])
    await sh(sandbox, `cd ${REPO} && git init -q && git add -A && git -c user.email=fleet@fleet.example -c user.name=fleet commit -qm baseline`)
    const key = (await sh(sandbox, `printf %s "$${PROVIDERS[agent].key}" | cut -c1-18`)).trim()
    log(w, `ready; ${PROVIDERS[agent].key} in the VM: ${c.dim}${key}…${c.reset} · working on ${c.bold}issues/${w.issue}.md${c.reset}`)
    const reply = await sh(sandbox, `cd ${REPO} && timeout 600 ${agentCommand(agent, w.issue)} 2>&1 | tail -n 40`)
    writeFileSync(join(OUT, `${sandbox}-agent.txt`), reply)
    // The manager checks the work itself; the agent's own report is not evidence.
    result.testsPass = (await sh(sandbox, `cd ${REPO} && node --test test/${w.test}.test.js >/dev/null 2>&1; echo $?`)).trim() === '0'
    result.testsUntouched = (await sh(sandbox, `cd ${REPO} && git diff --quiet -- test/ && echo yes || echo no`)).trim() === 'yes'
    result.diff = (await sh(sandbox, `cd ${REPO} && git diff --stat -- src/ | tail -n 1`)).trim()
    await new Promise((r) => setTimeout(r, 2000)) // the supervisor's records arrive shortly after
    const decisions = parseAudit(await os(['logs', sandbox]))
    const model = agent === 'claude' ? 'api.anthropic.com' : 'api.openai.com'
    result.modelCalls = decisions.filter((d) => d.allowed && d.target.includes(model)).length
    result.denied = [...new Set(decisions.filter((d) => !d.allowed).map((d) => `${d.who} ${d.target}`))]
    log(w, `${result.testsPass ? `${c.green}tests pass${c.reset}` : `${c.red}tests fail${c.reset}`} · ${result.diff || 'no change'} · ${result.modelCalls} model calls${result.denied.length ? ` · ${c.red}${result.denied.length} denied${c.reset}` : ''}`)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    log(w, `${c.red}error${c.reset}: ${result.error}`)
  }
  result.seconds = Math.round((Date.now() - started) / 1000)
  return result
}

// --- the fleet --------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true })
  const plan = WORKERS.map((w) => {
    const agent: Agent = process.env[PROVIDERS[w.agent].key] ? w.agent : 'claude'
    if (agent !== w.agent) {
      console.log(`${c.dim}No ${PROVIDERS[w.agent].key} in .env: worker ${w.n} runs Claude Code instead of ${w.agent}.${c.reset}`)
    }
    return { w: { ...w, agent }, agent }
  })
  const agents = [...new Set(plan.map((p) => p.agent))]
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is missing from .env')
  }
  for (const agent of agents) {
    const p = PROVIDERS[agent]
    await os(['provider', 'profile', 'import', '-f', p.profile, '--global']).catch(() => {
      // Already imported into this gateway.
    })
    await os(['provider', 'delete', p.name]).catch(() => {
      // Not there yet.
    })
    // The key reaches the CLI through its environment, never its arguments.
    await os(['provider', 'create', '--name', p.name, '--type', p.type, '--from-existing'], { [p.key]: process.env[p.key] ?? '' })
  }

  console.log(`${c.bold}Fleet ${run}: ${plan.length} workers, one issue each${c.reset}\n`)
  const started = Date.now()
  const results = await Promise.all(plan.map(({ w, agent }) => work(w, agent)))
  const total = Math.round((Date.now() - started) / 1000)

  console.log(`\n${c.bold}Results${c.reset} ${c.dim}(${total}s wall clock)${c.reset}`)
  for (const r of results) {
    const ok = r.testsPass && r.testsUntouched && !r.error
    console.log(`  ${ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`} [${r.n}] ${r.agentUsed.padEnd(6)} ${r.issue.padEnd(11)} ${r.seconds}s  ${r.testsUntouched ? '' : `${c.red}tests edited${c.reset} `}${r.diff}`)
  }
  console.log(`\n${c.magenta}${c.bold}OpenShell${c.reset} ${c.dim}(each worker reached only its own model API)${c.reset}`)
  for (const r of results) {
    const denied = r.denied.length ? r.denied.join(', ') : 'nothing denied'
    console.log(`  [${r.n}] ${r.agentUsed.padEnd(6)} ${r.modelCalls} model calls, key added outside the VM · ${c.dim}denied: ${denied}${c.reset}`)
  }
  writeFileSync(join(OUT, `fleet-${run}.json`), `${JSON.stringify({ run, total, results }, null, 2)}\n`)
  console.log(`\nReport: ${OUT}/fleet-${run}.json`)
  if (!results.every((r) => r.testsPass && r.testsUntouched && !r.error)) {
    process.exitCode = 1
  }
}

async function cleanup() {
  if (keep) {
    console.log(`Kept: ${WORKERS.map(name).join(', ')}`)
    return
  }
  await Promise.all(WORKERS.map((w) => os(['sandbox', 'delete', name(w)]).catch(() => {})))
  for (const p of Object.values(PROVIDERS)) {
    await os(['provider', 'delete', p.name]).catch(() => {})
  }
  console.log(`${c.dim}Workers and providers deleted.${c.reset}`)
}

try {
  await main()
} catch (error) {
  console.error(`${c.red}FAIL${c.reset}: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await cleanup()
}
