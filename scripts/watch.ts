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
  /E2B box created|supervisor started|deleted|create failed|starting E2B compute driver/, // driver
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

function paint(source: string, line: string): string {
  const tag = source.padEnd(10)
  const c = /DENIED/.test(line) ? color.denied : /ALLOWED/.test(line) ? color.allowed : color[source as keyof typeof color] ?? ''
  return `${color.dim}${tag}${color.reset} ${c}${line}${color.reset}`
}

async function main() {
  const id = (await readFile('.control-id', 'utf8')).trim()
  const sbx = await Sandbox.connect(id)
  console.log(`${color.dim}watching control box ${id} (Ctrl-C to stop)${color.reset}\n`)
  // Each log gets its own labelled stream ("source|line"). Supervisor logs are
  // picked up as sandboxes appear; ones that already existed start from now,
  // new ones from their first line.
  const script = [
    `cd ${STATE} && : > /tmp/watched`,
    `(tail -n 0 -F gateway.log | sed -u 's/^/gateway|/') &`,
    `(tail -n 0 -F driver.log | sed -u 's/^/driver|/') &`,
    'from=0',
    'while true; do',
    '  for f in sandboxes/*/supervisor.err.log; do',
    '    [ -e "$f" ] || continue; grep -qxF "$f" /tmp/watched && continue; echo "$f" >> /tmp/watched',
    '    if [ "$from" = 0 ]; then n=0; else n=+1; fi',
    `    (tail -n $n -F "$f" | sed -u 's/^/supervisor|/') &`,
    '  done; from=1; sleep 2',
    'done',
  ].join('\n')
  let partial = ''
  await sbx.commands.run(script, {
    timeoutMs: 0,
    onStdout: (chunk) => {
      const lines = (partial + chunk).split('\n')
      partial = lines.pop() ?? '' // keep an incomplete last line for the next chunk
      for (const raw of lines) {
        const bar = raw.indexOf('|')
        const source = raw.slice(0, bar)
        const line = raw.slice(bar + 1)
        if (INTERESTING.some((re) => re.test(line))) console.log(paint(source, tidy(line)))
      }
    },
  })
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1) })
