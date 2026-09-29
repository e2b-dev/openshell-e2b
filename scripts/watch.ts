// watch.ts: live, color-coded view of what happens inside the control box.
//
//   npm run watch          (while `npm run connect` is running in another terminal)
//
// Streams the gateway, driver and every supervisor log from the control box
// and keeps only the lines that tell the story: sandbox lifecycle, supervisor
// sessions, policy loads, and every ALLOWED / DENIED network decision.
import { readFile } from 'node:fs/promises'
import { Sandbox } from 'e2b'

const STATE = '/home/user/openshell'
const color = { gateway: '\x1b[35m', driver: '\x1b[33m', supervisor: '\x1b[36m', allowed: '\x1b[32m', denied: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' }

// Lines worth showing, and how to shorten them.
const INTERESTING = [
  /E2B box created|health:|supervisor started|deleted|create failed|starting E2B compute driver/, // driver
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
  [/E2B box created .*e2b=(\w+)/, (k) => `${y}driver   ${x}▸ E2B microVM created ${d}${short(k[1])}${x}`],
  [/fence check/, () => `${y}driver   ${x}▸ fence verified: loopback only`],
  [/supervisor started/, () => `${y}driver   ${x}▸ tunnel 2 up, supervisor started`],
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
  [/lifecycle: deleted/, () => `${y}driver   ${x}▸ E2B microVM deleted`],
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
  const id = (await readFile('.control-id', 'utf8')).trim()
  const sbx = await Sandbox.connect(id)
  console.log(`${color.dim}watching control box ${id.slice(0, 10)}… (Ctrl-C to stop)${color.reset}\n`)
  // Each log gets its own labelled stream ("source|line"). Supervisor logs are
  // picked up as sandboxes appear; ones that already existed start from now,
  // new ones from their first line.
  // A per-run marker file, so a watcher left over from an earlier run can't
  // claim this run's logs; `trap` stops this run's tails when the loop ends.
  const run = `/tmp/watch-${process.pid}-${Date.now()}`
  const script = [
    `cd ${STATE} && : > ${run} && trap 'kill 0' EXIT`,
    `(tail -n 0 -F gateway.log | sed -u 's/^/gateway|/') &`,
    `(tail -n 0 -F driver.log | sed -u 's/^/driver|/') &`,
    'from=0',
    'while true; do',
    '  for f in sandboxes/*/supervisor.err.log; do',
    `    [ -e "$f" ] || continue; grep -qxF "$f" ${run} && continue; echo "$f" >> ${run}`,
    '    if [ "$from" = 0 ]; then n=0; else n=+1; fi',
    `    (tail -n $n -F "$f" | sed -u 's/^/supervisor|/') &`,
    '  done; from=1; sleep 2',
    'done',
  ].join('\n')
  let partial = ''
  const handle = await sbx.commands.run(script, {
    background: true,
    timeoutMs: 0,
    onStdout: (chunk) => {
      const lines = (partial + chunk).split('\n')
      partial = lines.pop() ?? '' // keep an incomplete last line for the next chunk
      for (const raw of lines) {
        const bar = raw.indexOf('|')
        const source = raw.slice(0, bar)
        const line = raw.slice(bar + 1)
        if (COMPACT) {
          const out = compact(line)
          if (out) console.log(out)
        } else if (INTERESTING.some((re) => re.test(line))) {
          console.log(paint(source, tidy(line)))
        }
      }
    },
  })
  // Stop the remote loop when we stop, instead of leaving it running in the box.
  const stop = async () => { await handle.kill().catch(() => {}); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  await handle.wait()
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
