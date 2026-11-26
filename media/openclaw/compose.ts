// Edits the clips from record.ts into media/openclaw-demo.mp4: waits sped up with a
// badge, a caption per scene, crossfades and an end card. Overlays are HTML rendered
// to transparent PNGs by headless Chrome (this ffmpeg has no drawtext).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MARKS, OUT, WINDOW } from './common.ts'

const FPS = 30
const NORM = `fps=${FPS},format=yuv420p,setsar=1`
const XF = 0.35 // crossfade
const SHOWN_WAIT = 1.1 // seconds a sped-up wait lasts on screen
const DEAD_AIR = 0.5 // seconds a frozen stretch keeps (no badge: nothing on screen changes)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OV = join(OUT, 'overlays')

type Scene = { name: string; kind: 'terminal' | 'browser'; caption: string }
const SCENES: Scene[] = [
  { name: 't1', kind: 'terminal', caption: 'OpenClaw gets its own <b>E2B microVM</b>, under NVIDIA OpenShell' },
  { name: 'b1', kind: 'browser', caption: 'Hacker News is not in the policy. <b>OpenShell blocks it.</b>' },
  { name: 't2', kind: 'terminal', caption: 'Allow it <b>live</b>: read-only, OpenClaw only, no restart' },
  { name: 'b2', kind: 'browser', caption: 'Same chat, same VM. <b>Now it works.</b>' },
  { name: 'b3', kind: 'browser', caption: 'A webhook nobody allowed: <b>blocked</b>' },
  { name: 't3', kind: 'terminal', caption: 'Every request is in the audit log. <b>The key never entered the VM.</b>' },
]

const ff = (...args: string[]) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'inherit' })
const duration = (file: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }))

// --- overlays -------------------------------------------------------------------

const CSS = `
html,body{margin:0;width:1920px;height:1080px;background:transparent;font-family:-apple-system,"SF Pro Display",system-ui,sans-serif}
.pill{position:absolute;left:50%;top:22px;transform:translateX(-50%);padding:14px 30px;border-radius:999px;background:rgba(22,22,30,.95);
  border:1px solid #3b4261;color:#c0caf5;font-size:30px;font-weight:500;letter-spacing:.2px;box-shadow:0 12px 40px rgba(0,0,0,.45);white-space:nowrap}
.pill b{color:#ff8800;font-weight:600}
.badge{position:absolute;right:${WINDOW.x + 28}px;top:${WINDOW.y + WINDOW.height - 72}px;padding:8px 18px;border-radius:12px;background:rgba(255,136,0,.16);
  border:1px solid #ff8800;color:#ff8800;font:600 24px "JetBrains Mono",Menlo,monospace}
.window{position:absolute;inset:0}
.end{position:absolute;inset:0;background:#16161e;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px}
.end .title{font:700 104px -apple-system,"SF Pro Display",system-ui,sans-serif;color:#c0caf5;letter-spacing:-1px}
.end .title span{color:#ff8800}
.end .chip{font:500 32px "JetBrains Mono",Menlo,monospace;color:#c0caf5;padding:18px 32px;border-radius:14px;background:#1f2335;border:1px solid #3b4261}
.end .chip i{font-style:normal;color:#9ece6a}
.end .tag{font-size:32px;color:#a9b1d6}`

// The browser scenes get the same window as VHS draws for the terminal: rounded,
// colorful title bar, and the page in the hole underneath.
const { x, y, width, height, bar } = WINDOW
const WINDOW_SVG = `<svg class="window" width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
  <defs><mask id="hole"><rect width="1920" height="1080" fill="white"/><rect x="${x}" y="${y + bar}" width="${width}" height="${height - bar}" fill="black"/></mask>
  <clipPath id="win"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14"/></clipPath></defs>
  <rect width="1920" height="1080" fill="#16161e" mask="url(#hole)"/>
  <g clip-path="url(#win)"><rect x="${x}" y="${y}" width="${width}" height="${bar}" fill="#1a1b26"/></g>
  <circle cx="${x + 26}" cy="${y + bar / 2}" r="8" fill="#ff5f58"/><circle cx="${x + 52}" cy="${y + bar / 2}" r="8" fill="#ffbd2e"/><circle cx="${x + 78}" cy="${y + bar / 2}" r="8" fill="#18c132"/>
  <text x="960" y="${y + bar / 2 + 7}" text-anchor="middle" font-family="-apple-system,system-ui" font-size="19" fill="#787c99">127.0.0.1:18789 · OpenClaw web chat · tunneled by OpenShell</text>
  <path d="M${x} ${y + height - 14} V${y + height} H${x + 14} A14 14 0 0 1 ${x} ${y + height - 14}Z M${x + width} ${y + height - 14} V${y + height} H${x + width - 14} A14 14 0 0 0 ${x + width} ${y + height - 14}Z" fill="#16161e"/>
</svg>`

function render(name: string, html: string, opaque = false) {
  const page = resolve(OV, `${name}.html`)
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>${CSS}</style>${html}`)
  const png = resolve(OV, `${name}.png`)
  rmSync(png, { force: true })
  // Headless Chrome on macOS sometimes exits non-zero after writing the file; retry, then trust the file.
  for (let attempt = 0; attempt < 3 && !existsSync(png); attempt++) {
    spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${resolve(OV, '.chrome', name)}`,
      `--default-background-color=${opaque ? 'ff16161e' : '00000000'}`, '--window-size=1920,1080', `--screenshot=${png}`, `file://${page}`], { stdio: 'ignore' })
  }
  if (!existsSync(png)) { throw new Error(`could not render overlay ${name}`) }
  return join(OV, `${name}.png`)
}

const badge = (k: number) => {
  const file = join(OV, `fast${k}.png`)
  return existsSync(file) ? file : render(`fast${k}`, `<div class="badge">▶▶ ${k}×</div>`)
}

// --- timing -------------------------------------------------------------------------

type Mark = { event: string; t: number }
const marks: Mark[] = readFileSync(MARKS, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const at = (event: string) => {
  const mark = marks.find((m) => m.event === event)
  if (!mark) { throw new Error(`missing mark ${event}`) }
  return mark.t
}
const nice = (k: number) => [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50].reduce((a, b) => (Math.abs(b - k) < Math.abs(a - k) ? b : a))

// Sped-up windows in clip seconds. `zero` is the wall-clock time of the clip's first frame.
function fastWindows(start: number, end: number, zero: number, scale: number) {
  const waits: [number, number][] = []
  let open: number | undefined
  for (const m of marks.filter((m) => m.t >= start && m.t <= end)) {
    if (m.event === 'wait_start') { open = m.t }
    if (m.event === 'wait_end' && open !== undefined) { waits.push([open, m.t]); open = undefined }
  }
  return waits
    .map(([a, b]) => [(a - zero) * scale + 0.6, (b - zero) * scale - 0.5] as [number, number])
    .filter(([a, b]) => b - a > SHOWN_WAIT * 1.5)
    .map(([a, b]) => ({ a, b, k: nice((b - a) / SHOWN_WAIT) }))
}

// Frozen stretches longer than 1.2 s, except the closing hold, which is deliberate.
function freezes(clip: string, total: number) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-i', clip, '-vf', 'freezedetect=n=0.002:d=1.2', '-map', '0:v', '-f', 'null', '-'], { encoding: 'utf8' })
  const starts = [...r.stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]))
  const ends = [...r.stderr.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => Number(m[1]))
  return starts
    .map((a, i) => ({ a: a + 0.2, b: (ends[i] ?? total) - 0.1 }))
    .filter((f) => f.b < total - 0.5 && f.b - f.a > DEAD_AIR + 0.3)
}

// --- scenes ----------------------------------------------------------------------------

function browserClip(name: string) {
  const dir = join(OUT, name)
  const frames: { file: string; t: number }[] = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8'))
  const start = at(`${name}_start`)
  const end = at(`${name}_end`)
  const shown = frames.filter((f) => f.t <= end)
  const lines = ['ffconcat version 1.0']
  shown.forEach((f, i) => {
    const from = Math.max(f.t, start)
    const to = i + 1 < shown.length ? Math.max(shown[i + 1].t, start) : end
    if (to > from) { lines.push(`file ${f.file}`, `duration ${(to - from).toFixed(4)}`) }
  })
  lines.push(`file ${shown.at(-1)!.file}`)
  writeFileSync(join(dir, 'clip.ffconcat'), `${lines.join('\n')}\n`)
  const frame = render('window', WINDOW_SVG)
  const out = join(OUT, `${name}-raw.mp4`)
  ff('-f', 'lavfi', '-i', `color=c=#16161e:s=1920x1080:r=${FPS}:d=${(end - start).toFixed(3)}`,
    '-f', 'concat', '-safe', '0', '-i', join(dir, 'clip.ffconcat'), '-i', frame,
    '-filter_complex', `[1:v]fps=${FPS},scale=${width}:${height - bar}[page];[0:v][page]overlay=${x}:${y + bar}:shortest=1[bg];[bg][2:v]overlay=0:0,${NORM}`,
    '-t', (end - start).toFixed(3), '-c:v', 'libx264', '-crf', '14', out)
  return { clip: out, zero: start, scale: 1, start, end }
}

function terminalClip(name: string) {
  const clip = join(OUT, `${name}.mp4`)
  const start = at(`${name}_start`)
  const end = at(`${name}_end`)
  const zero = start + 0.6 // the tape shows the screen 600 ms after the start stamp
  // VHS can drift from wall-clock time; map marks onto the clip proportionally.
  const scale = duration(clip) / (end - zero)
  console.log(`${name}: clip ${duration(clip).toFixed(1)}s, wall ${(end - zero).toFixed(1)}s, scale ${scale.toFixed(3)}`)
  return { clip, zero, scale, start, end }
}

function edit(scene: Scene, index: number) {
  const src = scene.kind === 'browser' ? browserClip(scene.name) : terminalClip(scene.name)
  const total = duration(src.clip)
  const fast = fastWindows(src.start, src.end, src.zero, src.scale)
  const dead = freezes(src.clip, total)
    .filter((f) => !fast.some((w) => f.a < w.b && f.b > w.a))
    .map((f) => ({ ...f, k: (f.b - f.a) / DEAD_AIR, silent: true }))
  const windows = [...fast.map((w) => ({ ...w, silent: false })), ...dead].sort((p, q) => p.a - q.a)
  const segs: { a: number; b: number; k: number; silent?: boolean }[] = []
  let cursor = 0
  for (const w of windows) {
    segs.push({ a: cursor, b: w.a, k: 1 }, w)
    cursor = w.b
  }
  segs.push({ a: cursor, b: total, k: 1 })
  const parts = segs.filter((s) => s.b - s.a > 0.05)
  const filters = parts.map((s, i) => `[0:v]trim=${s.a.toFixed(3)}:${s.b.toFixed(3)},setpts=(PTS-STARTPTS)/${s.k.toFixed(4)}[s${i}]`)
  filters.push(`${parts.map((_, i) => `[s${i}]`).join('')}concat=n=${parts.length}:v=1:a=0,${NORM}[v0]`)
  const length = parts.reduce((sum, s) => sum + (s.b - s.a) / s.k, 0)
  const overlays: { png: string; from: number; to: number }[] = [
    { png: render(`cap-${scene.name}`, `<div class="pill">${scene.caption}</div>`), from: 0.15, to: length },
  ]
  let t = 0
  for (const s of parts) {
    const len = (s.b - s.a) / s.k
    if (s.k > 1 && !s.silent) { overlays.push({ png: badge(s.k), from: t, to: t + len }) }
    t += len
  }
  const inputs = ['-i', src.clip]
  overlays.forEach((o, j) => {
    inputs.push('-loop', '1', '-t', length.toFixed(3), '-i', o.png)
    filters.push(`[${j + 1}:v]format=rgba,fade=in:st=${o.from.toFixed(3)}:d=0.25:alpha=1,fade=out:st=${(o.to - 0.25).toFixed(3)}:d=0.25:alpha=1[o${j}]`)
    filters.push(`[v${j}][o${j}]overlay=0:0:shortest=1[v${j + 1}]`)
  })
  const out = join(OUT, `scene${index}.mp4`)
  ff(...inputs, '-filter_complex', filters.join(';'), '-map', `[v${overlays.length}]`, '-c:v', 'libx264', '-crf', '14', out)
  console.log(`${scene.name}: ${length.toFixed(1)}s${fast.length ? ` (waits at ${fast.map((w) => `${w.k}×`).join(', ')})` : ''}${dead.length ? `, ${dead.length} dead-air cut(s)` : ''}`)
  return { file: out, length }
}

rmSync(OV, { recursive: true, force: true })
mkdirSync(OV, { recursive: true })
const clips = SCENES.map(edit)
const END = 3.2
const endCard = render('end', `<div class="end"><div class="title">OpenClaw <span>on</span> E2B</div>
  <div class="chip"><i>NVIDIA OpenShell</i> policy · <i>E2B</i> microVMs</div>
  <div class="tag">Your agent never sees the key. It reaches only what you allow.</div></div>`, true)
ff('-loop', '1', '-t', String(END), '-i', endCard, '-vf', NORM, '-c:v', 'libx264', '-crf', '14', join(OUT, 'end.mp4'))
clips.push({ file: join(OUT, 'end.mp4'), length: END })

const inputs = clips.flatMap((c) => ['-i', c.file])
const filters: string[] = []
let offset = 0
let prev = '0:v'
for (let i = 1; i < clips.length; i++) {
  offset += clips[i - 1].length - XF
  const out = i === clips.length - 1 ? 'v' : `x${i}`
  filters.push(`[${prev}][${i}:v]xfade=transition=${i === clips.length - 1 ? 'fadeblack' : 'fade'}:duration=${XF}:offset=${offset.toFixed(3)}[${out}]`)
  prev = out
}
ff(...inputs, '-filter_complex', filters.join(';'), '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'media/openclaw-demo.mp4')
ff('-i', 'media/openclaw-demo.mp4', '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-movflags', '+faststart', 'media/openclaw-demo-720p.mp4')
console.log(`media/openclaw-demo.mp4: ${duration('media/openclaw-demo.mp4').toFixed(1)}s (+ 720p copy)`)
