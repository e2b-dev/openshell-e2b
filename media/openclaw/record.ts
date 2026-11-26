// Records the OpenClaw demo: terminal scenes with VHS, web-chat scenes as Chrome
// screencast frames, all with wall-clock marks so compose.ts can find the waits.
// Run via `npm run demo:record:openclaw` (scripts/openclaw-record.sh), which connects,
// checks the audit afterwards and always cleans up.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { PROMPTS } from '../../scripts/openclaw-demo.ts'
import { MARKS, OUT, WINDOW } from './common.ts'

const stamp = (event: string) => appendFileSync(MARKS, `${JSON.stringify({ event, t: Date.now() / 1000 })}\n`)

// --- terminal scenes (VHS) ----------------------------------------------------

const header = (name: string) => `Output ${OUT}/${name}.mp4
Set Shell "bash"
Set FontSize 26
Set LineHeight 1.3
Set Width 1920
Set Height 1080
Set Padding 36
Set Margin ${WINDOW.x}
Set MarginFill "#16161e"
Set WindowBar Colorful
Set WindowBarSize ${WINDOW.bar}
Set BorderRadius 14
Set Theme "TokyoNight"
Set TypingSpeed 28ms
Set WaitTimeout 300s
Set Framerate 30

Hide
Type@1ms "source media/openclaw/shell.bashrc; clear; stamp ${name}_start"
Enter
Sleep 600ms
Show
Sleep 700ms
`
// The prompt ends with ❯; a step is done when the last line is a bare prompt again.
const run = (cmd: string, hold: string) => `Type "${cmd.replace(/"/g, '\\"')}"
Sleep 350ms
Enter
Wait+Line /❯ *$/
Sleep ${hold}
`

function terminal(name: string, body: string) {
  const tape = join(OUT, 'tapes', `${name}.tape`)
  writeFileSync(tape, `${header(name)}${body}Hide\nType@1ms "stamp ${name}_end"\nEnter\n`)
  execFileSync('vhs', [tape], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CLAW_MARKS: MARKS } })
}

// --- web-chat scenes (Chrome screencast) -----------------------------------------

// Screenshots in a loop while `act` runs (Chrome's screencast crops tall headless viewports).
async function browser(page: Page, name: string, act: () => Promise<void>) {
  const dir = join(OUT, name)
  mkdirSync(dir, { recursive: true })
  const frames: { file: string; t: number }[] = []
  let recording = true
  const loop = (async () => {
    while (recording) {
      const t = Date.now() / 1000
      const file = `f${String(frames.length).padStart(5, '0')}.jpg`
      await page.screenshot({ path: join(dir, file), type: 'jpeg', quality: 92 })
      frames.push({ file, t })
    }
  })()
  await page.waitForTimeout(400)
  stamp(`${name}_start`)
  try {
    await act()
    stamp(`${name}_end`)
  } finally {
    recording = false
    await loop.catch(() => {})
  }
  writeFileSync(join(dir, 'frames.json'), JSON.stringify(frames))
  const fps = frames.length / (frames.at(-1)!.t - frames[0].t)
  console.log(`  ${frames.length} frames, ${fps.toFixed(1)} fps`)
}

// Types like a person, sends, and waits for OpenClaw's "Done in …" footer below that message.
async function say(page: Page, text: string, hold = 2200) {
  const box = page.getByPlaceholder(/Message/)
  await box.click()
  await page.keyboard.type(text, { delay: 18 })
  await page.waitForTimeout(350)
  await page.keyboard.press('Enter')
  stamp('wait_start')
  // True once a "Done in …" footer follows the text we sent, in document order.
  const answered = (sent: string) => {
    const walker = document.createTreeWalker(document.querySelector('main') ?? document.body, NodeFilter.SHOW_TEXT)
    let asked: Node | undefined
    let done: Node | undefined
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? ''
      if (text.includes(sent.slice(0, 16))) { asked = n; done = undefined }
      if (asked && /^\s*Done in \d+/.test(text)) { done = n }
    }
    return Boolean(done)
  }
  for (let i = 0; !(await page.evaluate(answered, text)); i++) {
    if (i > 1200) { throw new Error('OpenClaw did not finish its reply within 5 minutes') }
    await page.waitForTimeout(250)
  }
  stamp('wait_end')
  await page.waitForTimeout(hold)
}

// --- the film ---------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'tapes'), { recursive: true })

console.log('t1: setup + web chat')
terminal('t1', run('claw setup', '1.5s') + run('claw web', '2s'))

const { url } = JSON.parse(readFileSync('dist/openclaw-demo/web.json', 'utf8')) as { url: string }
const chrome = await chromium.launch({ channel: 'chrome' })
// 125% zoom so the chat reads at 1080p; screenshots still come out at the window's pixel size.
const ZOOM = 1.25
const page = await chrome.newPage({ viewport: { width: Math.round(WINDOW.width / ZOOM), height: Math.round((WINDOW.height - WINDOW.bar) / ZOOM) }, deviceScaleFactor: ZOOM, colorScheme: 'dark' })
await page.goto(url)
await page.getByPlaceholder(/Message/).waitFor()
await page.waitForTimeout(1500)

try {
  console.log('b1: ask, denied')
  await browser(page, 'b1', () => say(page, PROMPTS.question))
  console.log('t2: allow live')
  terminal('t2', run('claw allow news.ycombinator.com', '2.2s'))
  console.log('b2: ask again, allowed')
  await browser(page, 'b2', () => say(page, PROMPTS.retry, 2600))
  console.log('b3: webhook, denied')
  await browser(page, 'b3', async () => {
    await say(page, PROMPTS.webhook, 900)
    // OpenClaw sometimes asks before sending anything out; answer like the user would.
    const last = await page.locator('main').innerText()
    if (/approve|confirm|go ahead|should I/i.test(last.slice(last.lastIndexOf('with curl.')))) {
      await say(page, 'Yes, go ahead.', 2800)
    } else {
      await page.waitForTimeout(1900)
    }
  })
} finally {
  await chrome.close()
}
console.log('t3: audit')
terminal('t3', run('claw audit', '4.5s'))
console.log(`clips and marks in ${OUT}`)
