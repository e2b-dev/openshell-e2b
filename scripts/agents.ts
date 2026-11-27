// agents.ts: a small coding-agent fleet on E2B, governed by OpenShell.
//
//   npm run agents            3 workers in parallel (2 Claude Code, 1 Codex), one issue each
//   npm run agents -- --keep  leave the worker sandboxes running for inspection
//
// Each worker is an OpenShell sandbox: an agent VM with no egress of its own and a
// supervisor VM that applies the policy. A worker may reach only its own model API,
// through a provider: the agent sees a placeholder, and the supervisor adds the real
// key for that agent's binary (and its child processes) only.
//
// The manager does not trust the worker. It copies out only the assigned source file
// and runs the original test against it in a fresh E2B grader sandbox with no internet
// and no keys.
//
// Needs a gateway whose driver uses the two-agent worker template:
//   OPENSHELL_WORKLOAD_TEMPLATE=openshell-workload-agents npm run connect
// and E2B_API_KEY, ANTHROPIC_API_KEY and OPENAI_API_KEY (for the Codex worker) in .env.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Sandbox } from 'e2b'

type Agent = 'claude' | 'codex'
type Worker = { n: number; agent: Agent; issue: string; source: string; test: string }

const WORKERS: Worker[] = [
  { n: 1, agent: 'claude', issue: '1-slugify', source: 'src/slugify.js', test: 'test/slugify.test.js' },
  { n: 2, agent: 'claude', issue: '2-duration', source: 'src/duration.js', test: 'test/duration.test.js' },
  { n: 3, agent: 'codex', issue: '3-csv', source: 'src/csv.js', test: 'test/csv.test.js' },
]
const PROFILES: Record<Agent, { file: string; type: string; key: string; host: string }> = {
  claude: { file: 'providers/fleet-claude-code.yaml', type: 'fleet-claude-code', key: 'ANTHROPIC_API_KEY', host: 'api.anthropic.com' },
  codex: { file: 'providers/fleet-codex.yaml', type: 'fleet-codex', key: 'OPENAI_API_KEY', host: 'api.openai.com' },
}
const FIXTURE = 'fixtures/fleet-repo'
const REPO = '/sandbox/fleet-repo' // `sandbox upload` puts a folder inside DEST under its own name
const OUT = 'dist/agents'
const AGENT_SECONDS = 600
const CLAUDE_MODEL = process.env.FLEET_CLAUDE_MODEL ?? 'claude-haiku-4-5'
if (!/^[\w.-]+$/.test(CLAUDE_MODEL)) {
  throw new Error(`FLEET_CLAUDE_MODEL is not a model id: ${CLAUDE_MODEL}`)
}
const id = randomBytes(3).toString('hex') // names: agents-<id>-<n> (17 chars, limit 19)
const keep = process.argv.includes('--keep')

const c = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', reset: '\x1b[0m' }
const env = { ...process.env, XDG_CONFIG_HOME: join(process.cwd(), '.openshell-separated'), OPENSHELL_COLOR: 'never' }

// Resources this run created, so cleanup deletes those and nothing else.
const owned = { sandboxes: new Set<string>(), providers: new Set<string>(), graders: new Set<Sandbox>() }

function os(args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('.bin/openshell', args, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(out)
      } else {
        reject(new Error(`openshell ${args.slice(0, 2).join(' ')}: ${signal ? `killed (${signal})` : (err || out).trim().slice(0, 400)}`))
      }
    })
  })
}
const sh = (sandbox: string, cmd: string, timeoutMs?: number) => os(['sandbox', 'exec', '-n', sandbox, '--no-tty', '--', 'sh', '-c', cmd], {}, timeoutMs)
const tag = (w: Worker) => `${c.dim}[${w.n}]${c.reset} ${w.agent === 'claude' ? c.yellow : c.blue}${w.agent.padEnd(6)}${c.reset}`
const log = (w: Worker, text: string) => console.log(`${tag(w)} ${text}`)
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// --- audit -------------------------------------------------------------------------

type Decision = { allowed: boolean; kind: 'http' | 'connect'; who: string; target: string }

function parseAudit(text: string): Decision[] {
  const decisions: Decision[] = []
  for (const line of text.split('\n')) {
    // HTTP records may name the process before the method; take the method right before the URL.
    const http = /HTTP:\w+ \[\w+\] (ALLOWED|DENIED) .*?\b([A-Z]+) (https?:\/\/\S+)/.exec(line)
    const net = /NET:OPEN \[\w+\] (ALLOWED|DENIED) (\S+?)\(\d+\) -> (\S+)/.exec(line)
    if (http) {
      decisions.push({ allowed: http[1] === 'ALLOWED', kind: 'http', who: http[2], target: http[3] })
    } else if (net) {
      decisions.push({ allowed: net[1] === 'ALLOWED', kind: 'connect', who: net[2].split('/').pop() ?? net[2], target: net[3] })
    }
  }
  return decisions
}
const hostOf = (d: Decision) => (d.kind === 'http' ? new URL(d.target).hostname : d.target.replace(/:\d+$/, ''))

// --- one worker -------------------------------------------------------------------

type Result = Worker & {
  sandbox: string
  seconds: number
  agentExit: number | 'timeout' | null
  fixed: boolean // the original test passed against the collected source file, in the grader
  testsEdited: boolean // informational: the grader always uses the original tests
  diff: string
  modelRequests: number
  unexpectedAllowed: string[]
  denied: string[]
  auditLines: number
  error?: string
}

async function createSandbox(sandbox: string, provider: string) {
  owned.sandboxes.add(sandbox)
  await os(['sandbox', 'create', '--name', sandbox, '--provider', provider, '--detach', '--no-tty', '--', 'sleep', 'infinity'], {}, 300_000)
  for (let i = 0; i < 180; i++) {
    if ((await os(['sandbox', 'list'])).split('\n').some((l) => l.startsWith(`${sandbox} `) && /\bReady\b/.test(l))) {
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`${sandbox} did not become Ready`)
}

function agentCommand(agent: Agent, issue: string) {
  const task = `Fix the issue below in src/. Run its test to check your fix. Do not change the tests.\n\n$(cat issues/${issue}.md)`
  if (agent === 'claude') {
    return `claude -p "${task}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions --output-format text`
  }
  // OpenShell is the sandbox here, so Codex's own sandbox and approvals are off.
  // The provider reads the placeholder from OPENAI_API_KEY (no login) and uses plain
  // HTTPS: OpenShell's REST rule refuses the WebSocket upgrade Codex tries first.
  const provider = 'model_providers.openshell={name="OpenAI via OpenShell",base_url="https://api.openai.com/v1",env_key="OPENAI_API_KEY",wire_api="responses",supports_websockets=false}'
  return `codex exec -c model_provider=openshell -c ${quote(provider)} --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "${task}"`
}

// Runs the original test against the worker's source file in a fresh E2B sandbox
// with no internet access and no keys. Only that one file comes from the worker.
async function grade(w: Worker, source: string): Promise<boolean> {
  const grader = await Sandbox.create({ allowInternetAccess: false, timeoutMs: 300_000 })
  owned.graders.add(grader)
  try {
    const root = '/home/user/grade'
    for (const file of ['package.json', w.test]) {
      await grader.files.write(`${root}/${file}`, readFileSync(join(FIXTURE, file), 'utf8'))
    }
    await grader.files.write(`${root}/${w.source}`, source)
    const run = await grader.commands.run(`cd ${root} && node --test ${w.test}`, { timeoutMs: 60_000 }).catch((e: unknown) => e as { exitCode?: number })
    return run.exitCode === 0
  } finally {
    await grader.kill().catch(() => {})
    owned.graders.delete(grader)
  }
}

async function work(w: Worker, provider: string): Promise<Result> {
  const sandbox = `agents-${id}-${w.n}`
  const started = Date.now()
  const result: Result = { ...w, sandbox, seconds: 0, agentExit: null, fixed: false, testsEdited: false, diff: '', modelRequests: 0, unexpectedAllowed: [], denied: [], auditLines: 0 }
  try {
    log(w, `creating ${sandbox} (supervisor VM + agent VM)`)
    await createSandbox(sandbox, provider)
    await os(['sandbox', 'upload', sandbox, FIXTURE, '/sandbox'])
    const placeholder = (await sh(sandbox, `case "$${PROFILES[w.agent].key}" in openshell:resolve:*) echo yes;; *) echo no;; esac`)).trim() === 'yes'
    if (!placeholder) {
      throw new Error(`${PROFILES[w.agent].key} in the VM is not an OpenShell placeholder`)
    }
    log(w, `ready · ${PROFILES[w.agent].key} in the VM is a placeholder · working on ${c.bold}issues/${w.issue}.md${c.reset}`)
    const out = await sh(sandbox, `cd ${REPO} && timeout ${AGENT_SECONDS} ${agentCommand(w.agent, w.issue)} > /tmp/agent.txt 2>&1; echo "AGENT_EXIT=$?"; tail -n 40 /tmp/agent.txt`, (AGENT_SECONDS + 60) * 1000)
    const exit = Number(/AGENT_EXIT=(\d+)/.exec(out)?.[1] ?? -1)
    result.agentExit = exit === 124 ? 'timeout' : exit
    writeFileSync(join(OUT, `${sandbox}-agent.txt`), out)

    // Collect only data; nothing the worker wrote runs on this machine.
    const source = await sh(sandbox, `cat ${REPO}/${w.source}`)
    const test = await sh(sandbox, `cat ${REPO}/${w.test} 2>/dev/null || true`)
    result.testsEdited = test !== readFileSync(join(FIXTURE, w.test), 'utf8')
    const before = readFileSync(join(FIXTURE, w.source), 'utf8').split('\n')
    const after = source.split('\n')
    result.diff = `${w.source}: ${before.length} → ${after.length} lines`
    result.fixed = source !== before.join('\n') && await grade(w, source)

    await new Promise((r) => setTimeout(r, 2000)) // the supervisor's records arrive shortly after
    const lines = await os(['logs', sandbox, '-n', '20000'])
    result.auditLines = lines.split('\n').length
    const decisions = parseAudit(lines)
    const model = PROFILES[w.agent].host
    result.modelRequests = decisions.filter((d) => d.allowed && d.kind === 'http' && hostOf(d) === model).length
    result.unexpectedAllowed = [...new Set(decisions.filter((d) => d.allowed && hostOf(d) !== model).map((d) => `${d.who} ${d.target}`))]
    result.denied = [...new Set(decisions.filter((d) => !d.allowed).map((d) => `${d.who} ${hostOf(d)}`))]
    const status = result.fixed ? `${c.green}fixed${c.reset}` : `${c.red}not fixed${c.reset}`
    log(w, `${status} · agent exit ${result.agentExit} · ${result.modelRequests} model requests${result.denied.length ? ` · ${c.red}${result.denied.length} denied${c.reset}` : ''}`)
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
  for (const key of ['E2B_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    if (!process.env[key]) {
      throw new Error(`${key} is missing from .env`)
    }
  }
  const providers = {} as Record<Agent, string>
  for (const agent of Object.keys(PROFILES) as Agent[]) {
    const p = PROFILES[agent]
    await os(['provider', 'profile', 'import', '-f', p.file, '--global']).catch((e: Error) => {
      if (!/already exists/i.test(e.message)) {
        throw e
      }
    })
    const name = `agents-${id}-${agent === 'claude' ? 'a' : 'o'}`
    // The key reaches the CLI through its environment, never its arguments.
    await os(['provider', 'create', '--name', name, '--type', p.type, '--from-existing'], { [p.key]: process.env[p.key] ?? '' })
    owned.providers.add(name)
    providers[agent] = name
  }

  console.log(`${c.bold}Agent fleet ${id}: ${WORKERS.length} workers, one issue each${c.reset}\n`)
  const started = Date.now()
  const results = await Promise.all(WORKERS.map((w) => work(w, providers[w.agent])))
  const total = Math.round((Date.now() - started) / 1000)

  console.log(`\n${c.bold}Results${c.reset} ${c.dim}(${total}s wall clock; graded in a fresh offline sandbox)${c.reset}`)
  for (const r of results) {
    const mark = r.fixed && !r.error ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`
    console.log(`  ${mark} [${r.n}] ${r.agent.padEnd(6)} ${r.issue.padEnd(11)} ${String(r.seconds).padStart(3)}s  ${r.diff}${r.testsEdited ? `  ${c.red}(edited the tests; graded with the originals)${c.reset}` : ''}`)
  }
  console.log(`\n${c.magenta}${c.bold}OpenShell${c.reset}`)
  for (const r of results) {
    const extra = r.unexpectedAllowed.length ? ` · ${c.red}also allowed: ${r.unexpectedAllowed.join(', ')}${c.reset}` : ''
    const denied = r.denied.length ? r.denied.join(', ') : 'none'
    console.log(`  [${r.n}] ${r.agent.padEnd(6)} ${r.modelRequests} requests to ${PROFILES[r.agent].host}, key added outside the VM${extra} · ${c.dim}denied: ${denied}${c.reset}`)
  }
  writeFileSync(join(OUT, `agents-${id}.json`), `${JSON.stringify({ id, total, results }, null, 2)}\n`)
  console.log(`\nReport: ${OUT}/agents-${id}.json`)
  if (!results.every((r) => r.fixed && !r.error && r.unexpectedAllowed.length === 0)) {
    process.exitCode = 1
  }
}

// One idempotent cleanup path for normal exit, errors and signals.
let cleaning: Promise<void> | undefined
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    await Promise.all([...owned.graders].map((g) => g.kill().catch(() => {})))
    if (keep) {
      console.log(`Kept: ${[...owned.sandboxes].join(', ')}`)
      return
    }
    const left: string[] = []
    const remove = async (args: string[], label: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await os(args)
          return
        } catch (e) {
          if (/not found/i.test((e as Error).message)) {
            return
          }
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      left.push(label)
    }
    await Promise.all([...owned.sandboxes].map((s) => remove(['sandbox', 'delete', s], `sandbox ${s}`)))
    await Promise.all([...owned.providers].map((p) => remove(['provider', 'delete', p], `provider ${p}`)))
    if (left.length) {
      console.error(`${c.red}Not deleted:${c.reset} ${left.join(', ')}`)
      process.exitCode = 1
    } else {
      console.log(`${c.dim}Workers, graders and providers deleted.${c.reset}`)
    }
  })()
  return cleaning
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.error(`\n${signal}: cleaning up`)
    process.exitCode = 130
    void cleanup().finally(() => process.exit())
  })
}

try {
  await main()
} catch (error) {
  console.error(`${c.red}FAIL${c.reset}: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await cleanup()
}
