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
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommandExitError, Sandbox } from 'e2b'

type Agent = 'claude' | 'codex'
type Worker = { n: number; agent: Agent; issue: string; source: string; test: string }

const WORKERS: Worker[] = [
  { n: 1, agent: 'claude', issue: '1-slugify', source: 'src/slugify.js', test: 'test/slugify.test.js' },
  { n: 2, agent: 'claude', issue: '2-duration', source: 'src/duration.js', test: 'test/duration.test.js' },
  { n: 3, agent: 'codex', issue: '3-csv', source: 'src/csv.js', test: 'test/csv.test.js' },
]
const PROFILES: Record<Agent, { file: string; type: string; key: string; host: string; route: string }> = {
  claude: { file: 'providers/fleet-claude-code.yaml', type: 'fleet-claude-code', key: 'ANTHROPIC_API_KEY', host: 'api.anthropic.com', route: 'POST /v1/messages' },
  codex: { file: 'providers/fleet-codex.yaml', type: 'fleet-codex', key: 'OPENAI_API_KEY', host: 'api.openai.com', route: 'POST /v1/responses' },
}
const MAX_SOURCE_BYTES = 256 * 1024
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

// The fixture's test/ tree, in the same shape the worker reports it, to detect any test change.
function manifest(): string {
  const r = spawnSync('sh', ['-c', `cd ${FIXTURE} && find test -print0 | sort -z | xargs -0 stat -f '%HT %N' | sed 's/^Regular File/regular file/; s/^Directory/directory/' | head -c 65536; find test -type f -print0 | sort -z | xargs -0 shasum -a 256 | head -c 65536`], { encoding: 'utf8' })
  return r.stdout
}
const testManifest = manifest()

const c = { dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', reset: '\x1b[0m' }
const env = { ...process.env, XDG_CONFIG_HOME: join(process.cwd(), '.openshell-separated'), OPENSHELL_COLOR: 'never' }

// Resources this run created, so cleanup deletes those and nothing else.
const owned = { sandboxes: new Set<string>(), providers: new Set<string>(), graders: new Set<Sandbox>() }

function os(args: string[], extraEnv: Record<string, string> = {}, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('.bin/openshell', args, { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => { outChunks.push(d) })
    child.stderr.on('data', (d: Buffer) => { errChunks.push(d) })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      // Decode once, so a multibyte character split across chunks stays intact.
      const out = Buffer.concat(outChunks).toString('utf8')
      const err = Buffer.concat(errChunks).toString('utf8')
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

// Live view: one log per worker (dist/agents/live/<n>.log), for `tail -f` in the video,
// and wall-clock marks (AGENTS_MARKS) so the editor knows where the waits are.
const LIVE = join(OUT, 'live')
const live = (w: Worker, text: string) => appendFileSync(join(LIVE, `${w.n}.log`), `${text}\n`)
const mark = (event: string) => {
  if (process.env.AGENTS_MARKS) {
    appendFileSync(process.env.AGENTS_MARKS, `${JSON.stringify({ event, t: Date.now() / 1000 })}\n`)
  }
}
const short = (text: string, max = 58) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// Claude Code's stream-json events and Codex's console output, reduced to one line per step.
function stepper(agent: Agent): (line: string) => string | undefined {
  if (agent === 'claude') {
    return (line) => {
      let event: { type?: string; message?: { content?: { type: string; name?: string; input?: Record<string, unknown>; text?: string }[] }; num_turns?: number }
      try {
        event = JSON.parse(line)
      } catch {
        return undefined
      }
      if (event.type === 'assistant') {
        const parts = (event.message?.content ?? []).map((part) => {
          if (part.type === 'tool_use') {
            const input = part.input ?? {}
            const arg = String(input.command ?? input.file_path ?? input.pattern ?? input.path ?? '').replace(/^\/sandbox\/fleet-repo\//, '')
            return `${c.yellow}▸ ${part.name}${c.reset} ${short(arg)}`
          }
          if (part.type === 'text' && part.text?.trim()) {
            return `${c.dim}${short(part.text.trim().split('\n')[0], 64)}${c.reset}`
          }
          return ''
        }).filter(Boolean)
        return parts.join('\n') || undefined
      }
      if (event.type === 'result') {
        return `${c.dim}done in ${event.num_turns ?? '?'} turns${c.reset}`
      }
      return undefined
    }
  }
  // Codex prints blocks: "codex" (a message), "exec" (a command, then its output),
  // "apply patch" (an edit). The prompt echo comes first, the final answer after "tokens used".
  let state: 'prompt' | 'message' | 'command' | 'patch' | 'output' | 'end' = 'prompt'
  return (raw) => {
    const line = raw.trimEnd()
    if (/^\d{4}-\d\d-\d\dT|^warning:/.test(line)) {
      return undefined
    }
    if (line === 'codex') {
      state = state === 'end' ? 'end' : 'message'
      return undefined
    }
    if (line === 'exec') {
      state = 'command'
      return undefined
    }
    if (line === 'apply patch') {
      state = 'patch'
      return undefined
    }
    if (line === 'tokens used') {
      state = 'end'
      return `${c.dim}done${c.reset}`
    }
    if (!line.trim()) {
      return undefined
    }
    if (state === 'message') {
      return `${c.dim}${short(line, 64)}${c.reset}`
    }
    if (state === 'command') {
      state = 'output'
      const cmd = line.replace(/^\/bin\/(bash|sh) -lc /, '').replace(/ in \/sandbox\/fleet-repo$/, '').replace(/^["']|["']$/g, '')
      return `${c.blue}▸ exec${c.reset} ${short(cmd)}`
    }
    if (state === 'patch' && line.startsWith('/sandbox/fleet-repo/')) {
      state = 'output'
      return `${c.blue}▸ edit${c.reset} ${line.replace('/sandbox/fleet-repo/', '')}`
    }
    return undefined
  }
}

// Like os(), but hands each stdout line to onLine as it arrives.
function osStream(args: string[], onLine: (line: string) => void, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('.bin/openshell', args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs })
    const chunks: Buffer[] = []
    let pending = Buffer.alloc(0)
    child.stdout.on('data', (d: Buffer) => {
      chunks.push(d)
      pending = Buffer.concat([pending, d])
      let nl = pending.indexOf(10)
      while (nl >= 0) {
        onLine(pending.subarray(0, nl).toString('utf8'))
        pending = pending.subarray(nl + 1)
        nl = pending.indexOf(10)
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf8'))
      } else {
        reject(new Error(`openshell sandbox exec: ${signal ? `killed (${signal})` : `exit ${code}`}`))
      }
    })
  })
}

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
  otherModelRoutes: string[] // allowed by the provider, on the model host, outside the inference route
  unexpectedAllowed: string[]
  denied: string[]
  auditLines: number
  error?: string
}

async function createSandbox(sandbox: string, provider: string) {
  try {
    await os(['sandbox', 'create', '--name', sandbox, '--provider', provider, '--detach', '--no-tty', '--', 'sleep', 'infinity'], {}, 300_000)
  } catch (error) {
    // A name conflict means the sandbox is someone else's; any other failure may have
    // left ours half-created, so it stays on the cleanup list.
    if (!/already exists/i.test((error as Error).message)) {
      owned.sandboxes.add(sandbox)
    }
    throw error
  }
  owned.sandboxes.add(sandbox)
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
    return `claude -p "${task}" --model ${CLAUDE_MODEL} --dangerously-skip-permissions --output-format stream-json --verbose`
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
    // A failing test is a result; a grader or transport failure is an error.
    const run = await grader.commands.run(`cd ${root} && timeout 60 node --test ${w.test} > /tmp/grade.txt 2>&1`, { timeoutMs: 90_000 })
      .catch((e: unknown) => {
        if (e instanceof CommandExitError) {
          return e
        }
        throw e
      })
    return run.exitCode === 0
  } finally {
    await grader.kill()
    owned.graders.delete(grader)
  }
}

async function work(w: Worker, provider: string): Promise<Result> {
  const sandbox = `agents-${id}-${w.n}`
  const started = Date.now()
  const result: Result = { ...w, sandbox, seconds: 0, agentExit: null, fixed: false, testsEdited: false, diff: '', modelRequests: 0, otherModelRoutes: [], unexpectedAllowed: [], denied: [], auditLines: 0 }
  try {
    log(w, `creating ${sandbox} (supervisor VM + agent VM)`)
    live(w, `${c.bold}${w.agent === 'claude' ? 'Claude Code' : 'Codex'}${c.reset} · issues/${w.issue}.md`)
    live(w, `${c.dim}creating a supervisor VM + agent VM…${c.reset}`)
    await createSandbox(sandbox, provider)
    await os(['sandbox', 'upload', sandbox, FIXTURE, '/sandbox'])
    // A baseline commit, so the agent can use git status and git diff as usual.
    await sh(sandbox, `cd ${REPO} && git init -q && git add -A && git -c user.email=fleet@fleet.example -c user.name=fleet commit -qm baseline`)
    const placeholder = (await sh(sandbox, `case "$${PROFILES[w.agent].key}" in openshell:resolve:*) echo yes;; *) echo no;; esac`)).trim() === 'yes'
    if (!placeholder) {
      throw new Error(`${PROFILES[w.agent].key} in the VM is not an OpenShell placeholder`)
    }
    log(w, `ready · ${PROFILES[w.agent].key} in the VM is a placeholder · working on ${c.bold}issues/${w.issue}.md${c.reset}`)
    live(w, `${c.green}●${c.reset} ready · ${PROFILES[w.agent].key} = ${c.dim}openshell:resolve:…${c.reset}`)
    mark(`ready_${w.n}`)
    const format = stepper(w.agent)
    const out = await osStream(['sandbox', 'exec', '-n', sandbox, '--no-tty', '--', 'sh', '-c',
      `cd ${REPO} && timeout ${AGENT_SECONDS} ${agentCommand(w.agent, w.issue)} 2>&1; echo "AGENT_EXIT=$?"`],
    (line) => {
      const text = format(line)
      if (text) {
        live(w, text)
      }
    }, (AGENT_SECONDS + 60) * 1000)
    mark(`done_${w.n}`)
    const exit = Number(/AGENT_EXIT=(\d+)/.exec(out)?.[1] ?? -1)
    result.agentExit = exit === 124 ? 'timeout' : exit
    writeFileSync(join(OUT, `${sandbox}-agent.txt`), out.slice(-200_000))

    // Collect only data; nothing the worker wrote runs on this machine.
    // A regular file only (no symlink), and bounded.
    const source = await sh(sandbox, `f=${REPO}/${w.source}; [ -f "$f" ] && [ ! -L "$f" ] && [ $(stat -c %s "$f") -le ${MAX_SOURCE_BYTES} ] && cat "$f"`)
    const tests = await sh(sandbox, `cd ${REPO} && find test -print0 | sort -z | xargs -0 stat -c '%F %n' | head -c 65536; find test -type f -print0 | sort -z | xargs -0 sha256sum | head -c 65536`)
    result.testsEdited = tests !== testManifest
    const before = readFileSync(join(FIXTURE, w.source), 'utf8').split('\n')
    const after = source.split('\n')
    result.diff = `${w.source}: ${before.length} → ${after.length} lines`
    result.fixed = source !== before.join('\n') && await grade(w, source)

    await new Promise((r) => setTimeout(r, 2000)) // the supervisor's records arrive shortly after
    const lines = await os(['logs', sandbox, '-n', '20000'])
    result.auditLines = lines.split('\n').length
    const decisions = parseAudit(lines)
    const model = PROFILES[w.agent].host
    const route = PROFILES[w.agent].route
    const onModel = decisions.filter((d) => d.allowed && d.kind === 'http' && hostOf(d) === model)
    const isRoute = (d: Decision) => `${d.who} ${new URL(d.target).pathname}`.startsWith(route)
    result.modelRequests = onModel.filter(isRoute).length
    result.otherModelRoutes = [...new Set(onModel.filter((d) => !isRoute(d)).map((d) => `${d.who} ${new URL(d.target).pathname}`))]
    if (result.modelRequests === 0) {
      throw new Error(`audit inconclusive: no ${route} request recorded for ${model}`)
    }
    result.unexpectedAllowed = [...new Set(decisions.filter((d) => d.allowed && hostOf(d) !== model).map((d) => `${d.who} ${d.target}`))]
    result.denied = [...new Set(decisions.filter((d) => !d.allowed).map((d) => `${d.who} ${hostOf(d)}`))]
    const status = result.fixed ? `${c.green}fixed${c.reset}` : `${c.red}not fixed${c.reset}`
    live(w, result.fixed ? `${c.green}✓ fixed${c.reset} ${c.dim}(original test, offline grader)${c.reset}` : `${c.red}✗ not fixed${c.reset}`)
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
  rmSync(LIVE, { recursive: true, force: true })
  mkdirSync(LIVE, { recursive: true })
  for (const w of WORKERS) {
    writeFileSync(join(LIVE, `${w.n}.log`), '')
  }
  mark('run_start')
  for (const key of ['E2B_API_KEY', 'ANTHROPIC_API_KEY']) {
    if (!process.env[key]) {
      throw new Error(`${key} is missing from .env`)
    }
  }
  const workers = WORKERS.map((w) => {
    if (w.agent === 'codex' && !process.env.OPENAI_API_KEY) {
      console.log(`${c.dim}No OPENAI_API_KEY in .env: worker ${w.n} runs Claude Code instead of Codex.${c.reset}`)
      return { ...w, agent: 'claude' as Agent }
    }
    return w
  })
  const providers = {} as Record<Agent, string>
  for (const agent of [...new Set(workers.map((w) => w.agent))]) {
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

  console.log(`${c.bold}Agent fleet ${id}: ${workers.length} workers, one issue each${c.reset}\n`)
  const started = Date.now()
  const results = await Promise.all(workers.map((w) => work(w, providers[w.agent])))
  const total = Math.round((Date.now() - started) / 1000)
  mark('results')

  console.log(`\n${c.bold}Results${c.reset} ${c.dim}(${total}s wall clock; graded in a fresh offline sandbox)${c.reset}`)
  for (const r of results) {
    const mark = r.fixed && r.agentExit === 0 && !r.error ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`
    console.log(`  ${mark} [${r.n}] ${r.agent.padEnd(6)} ${r.issue.padEnd(11)} ${String(r.seconds).padStart(3)}s  ${r.diff}${r.testsEdited ? `  ${c.red}(edited the tests; graded with the originals)${c.reset}` : ''}`)
  }
  console.log(`\n${c.magenta}${c.bold}OpenShell${c.reset}`)
  for (const r of results) {
    // Full list in the JSON report; for Claude Code these are settings, metrics and event logging.
    const routes = r.otherModelRoutes.length ? ` ${c.dim}+ ${r.otherModelRoutes.length} other API routes with the key${c.reset}` : ''
    const extra = r.unexpectedAllowed.length ? ` · ${c.red}also allowed: ${r.unexpectedAllowed.join(', ')}${c.reset}` : ''
    const denied = r.denied.length ? r.denied.join(', ') : 'none'
    console.log(`  [${r.n}] ${r.agent.padEnd(6)} ${r.modelRequests} requests to ${PROFILES[r.agent].host}, key added outside the VM${routes}${extra} · ${c.dim}denied: ${denied}${c.reset}`)
  }
  writeFileSync(join(OUT, `agents-${id}.json`), `${JSON.stringify({ id, total, results }, null, 2)}\n`)
  console.log(`\nReport: ${OUT}/agents-${id}.json`)
  if (!results.every((r) => r.fixed && r.agentExit === 0 && !r.error && r.unexpectedAllowed.length === 0)) {
    process.exitCode = 1
  }
}

// One idempotent cleanup path for normal exit, errors and signals.
let cleaning: Promise<void> | undefined
function cleanup(): Promise<void> {
  cleaning ??= (async () => {
    const left: string[] = []
    await Promise.all([...owned.graders].map((g) => g.kill().then(() => owned.graders.delete(g)).catch(() => left.push(`grader ${g.sandboxId}`))))
    if (keep) {
      console.log(`Kept: ${[...owned.sandboxes].join(', ')}`)
      return
    }
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
    mark('cleaned')
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
