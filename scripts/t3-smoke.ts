// t3-smoke.ts: run T3 Code's own OpenShell fleet smoke against this E2B gateway.
//
//   npm run t3:smoke [-- --runs 3]
//
// T3 Code's OpenShell fleet PR (pingdotgg/t3code#32158) ships
// scripts/openshell-smoke.ts: connect, health, list templates, spawn a worker
// from a template, wait Ready, find it by fleet labels, delete it, check the
// fleet index is clean, with timings per phase. Pointed at a gateway that runs
// our driver, every worker lands in its own E2B supervisor + worker VM pair.
//
//   1. T3 checkout   .cache/t3code at T3_COMMIT, its smoke's dependencies,
//                    @nvidia/openshell-sdk from GitHub Packages, and
//                    patches/t3code-sdk-compat.patch (T3 vs. the real SDK,
//                    plus mTLS login)
//   2. Gateway       the normal `npm run connect` (started here if needed);
//                    the smoke logs in with the CLI's mTLS client certificate
//   3. Template      the gateway template the smoke spawns, via the CLI
//   4. Smoke         node scripts/openshell-smoke.ts, unchanged, N times;
//                    after each run, no E2B VM of the smoke may remain
//
// Needs: E2B_API_KEY in .env, the templates built (README), gh logged in with
// read:packages, pnpm.
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sandbox } from 'e2b'
import { TEMPLATES } from './openshell.ts'

// T3 Code PR #32158 head, pinned so the smoke under test does not move.
const T3_REPO = 'https://github.com/pingdotgg/t3code.git'
const T3_COMMIT = 'fe9a70dc956da55100840a0e98b5d7c9290a4aca'
const SDK_VERSION = '0.1.9' // match the gateway release
const T3 = join(process.cwd(), '.cache/t3code')
const CONFIG = join(process.cwd(), '.openshell-separated')
// Written by `npm run connect`: the gateway CA and the CLI's client certificate.
const TLS_DIR = join(CONFIG, 'openshell/gateways/e2b-separated/mtls')
const GATEWAY_URL = 'https://127.0.0.1:17691'
const GATEWAY_TEMPLATE = 'e2b-worker' // the gateway template the smoke spawns
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1] || 1) || 1

const log = (...a: unknown[]) => { console.log(new Date().toISOString().slice(11, 19), ...a) }
const sh = (cmd: string, args: string[], cwd = T3, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const cli = (args: string[]) =>
  execFileSync('.bin/openshell', args, {
    env: { ...process.env, XDG_CONFIG_HOME: CONFIG }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  })

// T3's PR was only tested against fakes. patches/t3code-sdk-compat.patch fixes
// four mismatches with the real SDK and adds mTLS login, in this local
// checkout only. Reset and re-apply, so an older version of it never lingers.
const COMPAT_PATCH = join(process.cwd(), 'patches/t3code-sdk-compat.patch')

function applyCompatPatch() {
  sh('git', ['checkout', '-q', '--', 'packages/openshell/src/gatewayClient.ts'])
  sh('git', ['apply', COMPAT_PATCH])
  log('T3: applied patches/t3code-sdk-compat.patch (local only; see the patch header)')
}

async function t3Checkout() {
  const head = existsSync(join(T3, '.git')) ? sh('git', ['rev-parse', 'HEAD']).trim() : ''
  if (head !== T3_COMMIT) {
    log('T3 checkout', T3_COMMIT.slice(0, 8))
    await rm(T3, { recursive: true, force: true })
    await mkdir(T3, { recursive: true })
    sh('git', ['init', '-q'])
    sh('git', ['fetch', '-q', '--depth', '1', T3_REPO, T3_COMMIT])
    sh('git', ['checkout', '-q', 'FETCH_HEAD'])
  }
  const sdk = join(T3, 'packages/openshell/node_modules/@nvidia/openshell-sdk/package.json')
  const installed = existsSync(sdk) && JSON.parse(await readFile(sdk, 'utf8')).version === SDK_VERSION
  if (!installed) {
    log('T3 dependencies (smoke only) + @nvidia/openshell-sdk', SDK_VERSION)
    const pnpm = ['--config.engine-strict=false', '--ignore-scripts']
    sh('pnpm', ['install', '--filter', '@t3tools/scripts...', ...pnpm])
    // GitHub Packages needs a token. It lives in a temporary .npmrc for this
    // one install and is removed right after, whatever happens.
    const npmrc = join(T3, '.npmrc')
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
    await writeFile(npmrc, `@nvidia:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${token}\n`, { mode: 0o600 })
    try {
      sh('pnpm', ['--filter', '@t3tools/openshell', 'add', `@nvidia/openshell-sdk@${SDK_VERSION}`, ...pnpm])
    } finally {
      await rm(npmrc, { force: true })
    }
  }
  applyCompatPatch()
}

function reachable() {
  try {
    return /Status: Connected/.test(cli(['status']))
  } catch {
    return false
  }
}

/** Use the running `npm run connect`, or start one for this run. */
async function gateway(): Promise<ChildProcess | undefined> {
  if (existsSync(join(TLS_DIR, 'tls.key')) && reachable()) return undefined
  log('gateway: npm run connect')
  const connector = spawn(process.execPath, ['--import', 'tsx', '--env-file=.env', 'scripts/connect.ts'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let output = ''
  connector.stdout?.on('data', (d) => { output += d.toString() })
  for (let i = 0; i < 120; i++) {
    if (connector.exitCode !== null) throw new Error(`connect exited: ${output}`)
    if (output.includes('ready:')) return connector
    await sleep(1000)
  }
  connector.kill()
  throw new Error(`gateway did not come up: ${output}`)
}

/** The gateway template the smoke spawns: our worker template, role worker. */
function ensureTemplate() {
  try {
    cli(['sandbox', 'template', 'get', GATEWAY_TEMPLATE])
  } catch {
    cli(['sandbox', 'template', 'create', GATEWAY_TEMPLATE, '--image', TEMPLATES.workload, '--label', 't3-template-role=worker'])
    log(`gateway template '${GATEWAY_TEMPLATE}' created`)
  }
}

async function main() {
  await t3Checkout()
  const connector = await gateway()
  try {
    ensureTemplate()
    const controlId = (await readFile('.control-separated-id', 'utf8')).trim()
    const smokeVms = async () => {
      const pages = Sandbox.list({ query: { metadata: { 'openshell.ai/driver-owner': controlId } } })
      const items = []
      while (pages.hasNext) items.push(...await pages.nextItems())
      return items.filter((s) => s.metadata['openshell.ai/sandbox-name']?.startsWith('t3-smoke-'))
    }
    const reports: string[] = []
    for (let run = 1; run <= runs; run++) {
      log(`T3 smoke run ${run}/${runs}`)
      const output = sh('node', ['scripts/openshell-smoke.ts'], T3, {
        ...process.env,
        OPENSHELL_TLS_DIR: TLS_DIR, // the compat patch logs in with this certificate
        OPENSHELL_SMOKE_GATEWAY_URL: GATEWAY_URL,
        // The smoke requires a credential to run; with mTLS it is not sent.
        OPENSHELL_SMOKE_GATEWAY_CREDENTIAL: 'mtls',
        OPENSHELL_SMOKE_TEMPLATE: GATEWAY_TEMPLATE,
      })
      console.log(output.trim())
      assert.match(output, /total/, 'smoke did not report its phases')
      let left = await smokeVms()
      for (let i = 0; i < 30 && left.length; i++) { await sleep(1000); left = await smokeVms() }
      assert.equal(left.length, 0, `E2B VMs of the smoke remain: ${left.map((s) => s.sandboxId).join(', ')}`)
      log('no E2B VMs of the smoke remain')
      reports.push(`run ${run}\n${output.trim()}`)
    }
    await mkdir('dist', { recursive: true })
    await writeFile('dist/t3-smoke.txt', `${new Date().toISOString()} T3 ${T3_COMMIT}\n\n${reports.join('\n\n')}\n`)
    log(`PASS: ${runs} T3 smoke run(s). Report: dist/t3-smoke.txt`)
  } finally {
    connector?.kill()
  }
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
