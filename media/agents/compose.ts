// Edits the agent fleet recording (dist/agents-video/raw.mp4) into media/agents-demo.mp4:
// the three waits sped up with a badge, a caption per phase, and an end card. The
// look matches media/openclaw/compose.ts. Overlays are HTML rendered by headless Chrome.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = 'dist/agents-video'
const RAW = join(OUT, 'raw.mp4')
const OV = join(OUT, 'overlays')
const FPS = 30
const NORM = `fps=${FPS},format=yuv420p,setsar=1`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SHOW_DELAY = 0.6 // the tape shows the screen 600 ms after the clip_start stamp

const ff = (...args: string[]) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' })
const duration = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }))

const CSS = `
html,body{margin:0;width:1920px;height:1080px;background:transparent;font-family:-apple-system,"SF Pro Display",system-ui,sans-serif}
.pill{position:absolute;left:50%;top:18px;transform:translateX(-50%);padding:13px 30px;border-radius:999px;background:rgba(22,22,30,.95);
  border:1px solid #3b4261;color:#c0caf5;font-size:29px;font-weight:500;letter-spacing:.2px;box-shadow:0 12px 40px rgba(0,0,0,.45);white-space:nowrap}
.pill b{color:#ff8800;font-weight:600}
.badge{position:absolute;right:108px;bottom:110px;padding:8px 18px;border-radius:12px;background:rgba(255,136,0,.16);
  border:1px solid #ff8800;color:#ff8800;font:600 24px "JetBrains Mono",Menlo,monospace}
.end{position:absolute;inset:0;background:#16161e;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px}
.end .title{font:700 100px -apple-system,"SF Pro Display",system-ui,sans-serif;color:#c0caf5;letter-spacing:-1px}
.end .title span{color:#ff8800}
.end .chip{font:500 32px "JetBrains Mono",Menlo,monospace;color:#c0caf5;padding:18px 32px;border-radius:14px;background:#1f2335;border:1px solid #3b4261}
.end .chip i{font-style:normal;color:#9ece6a}
.end .tag{font-size:32px;color:#a9b1d6}`

function render(name: string, html: string, opaque = false) {
  const page = resolve(OV, `${name}.html`)
  const png = resolve(OV, `${name}.png`)
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${CSS}</style>${html}`)
  // Headless Chrome on macOS sometimes exits non-zero after writing the file; retry, then trust the file.
  for (let attempt = 0; attempt < 3 && !existsSync(png); attempt++) {
    spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${resolve(OV, '.chrome', name)}`,
      `--default-background-color=${opaque ? 'ff16161e' : '00000000'}`, '--window-size=1920,1080', `--screenshot=${png}`, `file://${page}`], { stdio: 'ignore' })
  }
  if (!existsSync(png)) {
    throw new Error(`could not render overlay ${name}`)
  }
  return png
}

// --- timeline (seconds in the raw clip) --------------------------------------------

const marks: { event: string; t: number }[] = readFileSync(join(OUT, 'marks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const raw = duration(RAW)
const zero = marks.find((m) => m.event === 'clip_start')!.t + SHOW_DELAY
const at = (event: string) => {
  const m = marks.find((x) => x.event === event)
  if (!m) {
    throw new Error(`missing mark ${event}`)
  }
  return m.t - zero
}
const all = (prefix: string) => marks.filter((m) => m.event.startsWith(prefix)).map((m) => m.t - zero)
const ready = Math.max(...all('ready_'))
const firstReady = Math.min(...all('ready_'))
const done = Math.max(...all('done_'))
const results = at('results')
const zoom = at('zoom')

// Sped-up windows, each shown for about `shown` seconds.
const windows = [
  { a: at('run_start') + 2.5, b: firstReady - 0.6, shown: 1.6 }, // VM pairs starting
  { a: ready + 2.5, b: done - 1.2, shown: 7.5 }, // the agents at work
  { a: done + 1.0, b: results - 0.8, shown: 1.0 }, // grading and audit
].filter((w) => w.b - w.a > w.shown * 1.5)
  .map((w) => ({ ...w, k: Math.max(2, Math.round((w.b - w.a) / w.shown)) }))

type Seg = { a: number; b: number; k: number }
const segs: Seg[] = []
let cursor = 0
for (const w of windows) {
  segs.push({ a: cursor, b: w.a, k: 1 }, { a: w.a, b: w.b, k: w.k })
  cursor = w.b
}
segs.push({ a: cursor, b: raw, k: 1 })
// Raw clip time → edited time.
const map = (t: number) => {
  let out = 0
  for (const s of segs) {
    if (t <= s.a) {
      break
    }
    out += (Math.min(t, s.b) - s.a) / s.k
  }
  return out
}
const length = map(raw)

// --- overlays ------------------------------------------------------------------------

rmSync(OV, { recursive: true, force: true })
mkdirSync(OV, { recursive: true })
const captions = [
  { from: 0, to: at('run_start') + 2, html: 'One manager, three coding agents, <b>one E2B VM pair each</b>' },
  { from: at('run_start') + 2, to: ready + 1, html: 'Two Claude Code, one Codex, all under <b>NVIDIA OpenShell</b>' },
  { from: ready + 1, to: done, html: 'The keys stay outside: each agent sees a <b>placeholder</b>' },
  { from: done, to: zoom - 0.3, html: 'Graded with the original tests, in a <b>fresh offline sandbox</b>' },
  { from: zoom - 0.3, to: raw, html: 'What each agent reached, and what OpenShell <b>denied</b>' },
]
const overlays = [
  ...captions.map((cap, i) => ({ png: render(`cap${i}`, `<div class="pill">${cap.html}</div>`), from: map(cap.from), to: map(cap.to) })),
  ...windows.map((w) => ({ png: render(`fast${w.k}`, `<div class="badge">▶▶ ${w.k}×</div>`), from: map(w.a), to: map(w.b) })),
].filter((o) => o.to - o.from > 0.3)

const filters = segs.filter((s) => s.b - s.a > 0.05).map((s, i) => `[0:v]trim=${s.a.toFixed(3)}:${s.b.toFixed(3)},setpts=(PTS-STARTPTS)/${s.k}[s${i}]`)
const n = filters.length
filters.push(`${Array.from({ length: n }, (_, i) => `[s${i}]`).join('')}concat=n=${n}:v=1:a=0,${NORM}[v0]`)
const inputs = ['-i', RAW]
overlays.forEach((o, j) => {
  inputs.push('-loop', '1', '-t', length.toFixed(3), '-i', o.png)
  filters.push(`[${j + 1}:v]format=rgba,fade=in:st=${o.from.toFixed(3)}:d=0.25:alpha=1,fade=out:st=${Math.max(o.from, o.to - 0.25).toFixed(3)}:d=0.25:alpha=1[o${j}]`)
  filters.push(`[v${j}][o${j}]overlay=0:0:shortest=1[v${j + 1}]`)
})
const body = join(OUT, 'body.mp4')
ff(...inputs, '-filter_complex', filters.join(';'), '-map', `[v${overlays.length}]`, '-c:v', 'libx264', '-crf', '14', body)

const END = 3.2
const endCard = render('end', `<div class="end"><div class="title">Coding agents <span>on</span> E2B</div>
  <div class="chip"><i>Claude Code</i> · <i>Codex</i> · NVIDIA OpenShell</div>
  <div class="tag">One policy for every agent. The keys never enter the VM.</div></div>`, true)
const end = join(OUT, 'end.mp4')
ff('-loop', '1', '-t', String(END), '-i', endCard, '-vf', NORM, '-c:v', 'libx264', '-crf', '14', end)
const bodyLength = duration(body)
ff('-i', body, '-i', end, '-filter_complex', `[0:v][1:v]xfade=transition=fadeblack:duration=0.35:offset=${(bodyLength - 0.35).toFixed(3)}[v]`,
  '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', 'media/agents-demo.mp4')
ff('-i', 'media/agents-demo.mp4', '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', 'media/agents-demo-720p.mp4')
console.log(`waits: ${windows.map((w) => `${w.k}×`).join(', ')} · media/agents-demo.mp4: ${duration('media/agents-demo.mp4').toFixed(1)}s (+ 720p copy)`)
