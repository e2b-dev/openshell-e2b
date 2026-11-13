// Live logs from the shared control plane and each separate supervisor VM.
//
//   npm run watch          (while `npm run connect` is running in another terminal)
//
// Streams gateway/driver logs from control and supervisor logs from sandbox A
// and keeps only the lines that tell the story: sandbox lifecycle, supervisor
// sessions, policy loads, and every ALLOWED / DENIED network decision.
import { readFile } from 'node:fs/promises'
import { Sandbox } from 'e2b'

const STATE = '/home/user/openshell'
const color = { gateway: '\x1b[35m', driver: '\x1b[33m', supervisor: '\x1b[36m', allowed: '\x1b[32m', denied: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' }

// Lines worth showing, and how to shorten them.
const INTERESTING = [
  /E2B task pair created|health:|supervisor started|deleted|create failed|starting E2B compute driver/, // driver
  /CreateSandbox|DeleteSandbox|supervisor session: accepted|Compute driver connected|relay opened/, // gateway
  /Isolation boundary (attached|enforcement confirmed|agent started)|Policy reloaded|initial policy|ALLOWED|DENIED/, // supervisor
]

function tidy(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^\S*T(\d\d:\d\d:\d\d)\.\d+Z?\s+/, '$1 ')
    .replace(/request\{[^}]*rpc\.method="(\w+)"[^}]*\}:?\s*/, '$1 ')
    .replace(/otel\.\w+=\S+\s*/g, '')
    .slice(0, 180)
}

// --compact: one short line per event, for narrow screens and the demo video.
const COMPACT = process.argv.includes('--compact')
const g = '\x1b[32m', r = '\x1b[31m', y = '\x1b[33m', m = '\x1b[35m', c = '\x1b[36m', d = '\x1b[2m', b = '\x1b[1m', x = '\x1b[0m'
const short = (id: string) => id.slice(0, 8)
const COMPACT_RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/E2B task pair created .*worker=(\w+) supervisor=(\w+)/, (k) => `${y}driver   ${x}▸ worker ${short(k[1])} + supervisor ${short(k[2])}`],
  [/create failed|fence check failed/, () => `${r}driver   ▸ create failed (see driver log)${x}`],
  [/supervisor started/, () => `${y}driver   ${x}▸ separate supervisor started`],
  [/CreateSandbox request completed/, () => `${m}gateway  ${x}▸ CreateSandbox done`],
  [/Isolation boundary attached/, () => `${c}superv.  ${x}▸ attached to fenced runtime ${d}(TLS 1.3)${x}`],
  [/Isolation boundary enforcement confirmed/, () => `${c}superv.  ${x}▸ isolation confirmed`],
  [/supervisor session: accepted/, () => `${m}gateway  ${x}▸ supervisor online ${b}→ Ready${x}`],
  [/Policy reloaded successfully/, () => `${c}superv.  ${x}▸ ${b}policy updated${x}`],
  [/NET:REFUSE .*DENIED (\S+) \[reason:policy_dns/, (k) => `${r}${b}DENY ${x}${r} dns   ${k[1]} ${d}(not in policy)${x}`],
  [/NET:OPEN .*ALLOWED \/usr\/bin\/(\w+)\(\d+\) -> (\S+)/, (k) => `${g}${b}ALLOW${x}${g} net   ${k[1]} → ${k[2]}${x}`],
  [/NET:OPEN .*DENIED \/usr\/bin\/(\w+)\(\d+\) -> (\S+)/, (k) => `${r}${b}DENY ${x}${r} net   ${k[1]} → ${k[2]}${x}`],
  [/HTTP:(\w+) .*ALLOWED \w+ http:\/\/[^/]+(\/\S*)/, (k) => `${g}${b}ALLOW${x}${g} http  ${k[1]} ${k[2]}${x}`],
  [/HTTP:(\w+) .*DENIED \w+ http:\/\/[^/]+(\/\S*)/, (k) => `${r}${b}DENY ${x}${r} http  ${k[1]} ${k[2]} ${d}(read-only rule)${x}`],
  [/task pair deleted/, () => `${y}driver   ${x}▸ supervisor + worker deleted`],
  [/health: sandbox not ready .*reason="?(\w+)/, (k) => `${r}health   ▸ not ready: ${k[1]}${x}`],
]

function compact(line: string): string | undefined {
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '')
  const time = clean.match(/T(\d\d:\d\d:\d\d)/)?.[1] ?? ''
  for (const [re, fmt] of COMPACT_RULES) {
    const k = clean.match(re)
    if (k) return `${d}${time}${x} ${fmt(k)}`
  }
  return undefined
}

function paint(source: string, line: string): string {
  const tag = source.padEnd(10)
  const c = /DENIED/.test(line) ? color.denied : /ALLOWED/.test(line) ? color.allowed : color[source as keyof typeof color] ?? ''
  return `${color.dim}${tag}${color.reset} ${c}${line}${color.reset}`
}

async function main() {
  const id = (await readFile('.control-separated-id', 'utf8')).trim()
  const control = await Sandbox.connect(id)
  console.log(`${color.dim}control ${id}; discovering per-task supervisor VMs…${color.reset}\n`)
  const handles = new Map<string, { kill(): Promise<boolean> }>()
  let stopped = false
  const follow = async (sbx: Sandbox, source: string, path: string, key: string) => {
    let partial = ''
    const handle = await sbx.commands.run(`exec tail -n ${source === 'supervisor' ? '+1' : '0'} -F ${path}`, {
      user: 'root', background: true, timeoutMs: 0,
      onStdout: chunk => {
        const lines = (partial + chunk).split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) {
          if (COMPACT) {
            const out = compact(line)
            if (out) console.log(out)
          } else if (INTERESTING.some(re => re.test(line))) {
            console.log(paint(source, tidy(line)))
          }
        }
      },
    })
    if (stopped) { await handle.kill().catch(() => {}); return }
    handles.set(key, handle)
  }
  await follow(control, 'gateway', `${STATE}/gateway.log`, 'gateway')
  await follow(control, 'driver', `${STATE}/driver.log`, 'driver')
  const seen = new Set<string>()
  const stop = async () => {
    stopped = true
    await Promise.allSettled([...handles.values()].map(h => h.kill()))
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  while (!stopped) {
    const pages = Sandbox.list({ query: { metadata: {
      'openshell.ai/driver-owner': id, 'openshell.ai/role': 'supervisor',
    } } })
    try {
      while (pages.hasNext) {
        for (const item of await pages.nextItems()) {
          if (seen.has(item.sandboxId)) continue
          const sbx = await Sandbox.connect(item.sandboxId)
          console.log(`${color.supervisor}supervisor A ${item.sandboxId} · ${item.metadata['openshell.ai/sandbox-name']}${color.reset}`)
          await follow(sbx, 'supervisor', '/run/openshell-task/supervisor.log', item.sandboxId)
          seen.add(item.sandboxId)
        }
      }
    } catch (error) { if (!stopped) console.error('Log discovery:', (error as Error).message) }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
