// Real E2B/OpenShell integration demo. Creates and removes a task pair.
import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Sandbox, CommandExitError } from 'e2b'

const exec = promisify(execFile)
const env = { ...process.env, XDG_CONFIG_HOME: join(process.cwd(), '.openshell-separated'), OPENSHELL_COLOR: 'never' }
const fault = process.argv.includes('--fault')
const keep = process.argv.includes('--keep')
assert(!(fault && keep), '--fault and --keep cannot be combined')
const name = `separated-${Date.now().toString(36)}`
const results: { check: string; passed: true }[] = []
const pass = (check: string) => { results.push({ check, passed: true }); console.log(`  ✓ ${check}`) }
const step = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m`)
const os = async (args: string[], timeout = 60_000) => {
  const command = exec('.bin/openshell', args, { env, timeout, maxBuffer: 4 * 1024 * 1024 })
  // OpenShell reads piped stdin before exec; terminate it for noninteractive calls.
  command.child.stdin?.end()
  return (await command).stdout
}
const inside = (cmd: string) => os(['sandbox', 'exec', '-n', name, '--no-tty', '--', 'sh', '-c', cmd], 30_000)
async function inventory(owner: string) {
  const pages = Sandbox.list({ query: { metadata: { 'openshell.ai/driver-owner': owner } } })
  const items = []
  while (pages.hasNext) items.push(...await pages.nextItems())
  return items
}
async function run(sbx: Sandbox, cmd: string) {
  try { return await sbx.commands.run(cmd, { user: 'root', timeoutMs: 20_000 }) }
  catch (e) { if (e instanceof CommandExitError) return e; throw e }
}
async function main() {
  let connector: ChildProcess | undefined
  let creator: ChildProcess | undefined
  let controlId = ''
  let ids: string[] = []
  let completed = false
  const dir = await mkdtemp(join(tmpdir(), 'openshell-separated-'))
  let connectLog = ''
  let createLog = ''
  try {
    step('1. Shared control plane — gateway + E2B compute driver')
    try { await os(['sandbox', 'list'], 5_000) }
    catch {
      connector = spawn(process.execPath, ['--import', 'tsx', '--env-file=.env', 'scripts/connect.ts'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      connector.stdout?.on('data', d => { connectLog += d.toString(); process.stdout.write(d) })
      connector.stderr?.on('data', d => { connectLog += d.toString() })
      let online = false
      for (let i = 0; i < 90; i++) {
        if (connector.exitCode !== null) throw new Error(`Control setup exited: ${connectLog}`)
        try { await os(['sandbox', 'list'], 2_000); online = true; break } catch { await sleep(1_000) }
      }
      assert(online, 'Control plane did not become ready')
    }
    controlId = (await readFile('.control-separated-id', 'utf8')).trim()
    console.log(`  Control: ${controlId} (shared; remains running after this task)`)
    const control = await Sandbox.connect(controlId)
    const controlProcesses = await run(control, 'pgrep -x openshell-super || true')
    assert.equal(controlProcesses.stdout.trim(), '', 'Supervisor must not run in the control VM')
    pass('No supervisor process in the control plane')

    step(`2. Create task ${name} — two independent E2B microVMs`)
    const started = Date.now()
    creator = spawn('.bin/openshell', ['sandbox', 'create', '--name', name, '--no-tty', '--', 'sleep', 'infinity'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    creator.stdout?.on('data', d => { createLog += d.toString() })
    creator.stderr?.on('data', d => { createLog += d.toString() })
    let ready = false
    for (let i = 0; i < 180; i++) {
      const list = await os(['sandbox', 'list'], 10_000)
      if (list.split('\n').some(l => l.startsWith(name + ' ') && /\bReady\b/.test(l))) { ready = true; break }
      if (creator.exitCode !== null && creator.exitCode !== 0) throw new Error(`Create failed: ${createLog}`)
      await sleep(1_000)
    }
    assert(ready, `Task did not become Ready: ${createLog}`)
    const pair = (await inventory(controlId)).filter(s => s.metadata['openshell.ai/sandbox-name'] === name)
    assert.equal(pair.length, 2, 'A task must own exactly two VMs')
    const a = pair.find(s => s.metadata['openshell.ai/role'] === 'supervisor')!
    const b = pair.find(s => s.metadata['openshell.ai/role'] === 'worker')!
    assert(a && b && a.sandboxId !== b.sandboxId && a.sandboxId !== controlId && b.sandboxId !== controlId)
    ids = [a.sandboxId, b.sandboxId]
    console.log(`  A · supervisor/proxy: ${a.sandboxId}\n  B · worker/agent:     ${b.sandboxId}`)
    console.log(`  Ready in ${((Date.now() - started) / 1000).toFixed(1)}s (create request → gateway Ready)`)
    pass('Gateway Ready with a distinct supervisor/worker pair')
    const supervisor = await Sandbox.connect(a.sandboxId)
    const worker = await Sandbox.connect(b.sandboxId)
    assert.equal((await run(supervisor, 'test -f /run/openshell-task/ready && kill -0 $(cat /run/openshell-task/supervisor.pid)')).exitCode, 0)
    assert.equal((await run(worker, 'test ! -e /opt/openshell/openshell-supervisor && test ! -e /run/openshell-task/auth.json')).exitCode, 0)
    for (const sbx of [supervisor, worker]) {
      assert.equal((await run(sbx, 'test -z "$E2B_API_KEY" && test ! -f /home/user/openshell/driver.env')).exitCode, 0)
    }
    pass('Supervisor and session credentials live in A; E2B management key stays in control')
    console.log((await inside('printf "  Agent uid="; id -u; grep -E "^(CapEff|NoNewPrivs)" /proc/self/status')).trim())

    step('3. Two enforcement layers — OpenShell policy + E2B worker egress fence')
    const denied = await inside('if curl -sS --max-time 5 https://api.github.com/zen >/dev/null 2>&1; then echo UNEXPECTED; else echo DEFAULT_DENY; fi')
    assert.match(denied, /DEFAULT_DENY/)
    pass('Unlisted destination denied before any network policy is added')
    const probe = "curl --noproxy '*' -sS --connect-timeout 3 --max-time 5 -o /dev/null -w '%{http_code}' https://1.1.1.1/cdn-cgi/trace"
    const aProbe = await run(supervisor, probe)
    assert.equal(aProbe.exitCode, 0, 'External probe must be reachable from the supervisor')
    const bProbe = await run(worker, probe)
    assert.notEqual(bProbe.exitCode, 0, 'Worker root must not have direct egress')
    assert.equal(bProbe.stdout, '000')
    pass('Direct HTTPS works from A; blocked from B even as root outside the agent namespace')

    step('4. Apply an OpenShell policy live — GitHub read-only, curl only')
    const base = await os(['policy', 'get', name, '--base'])
    const split = base.indexOf('\n---\n')
    assert(split >= 0, 'Expected policy YAML document')
    const policyPath = join(dir, 'policy.yaml')
    await writeFile(policyPath, base.slice(split + 5) + `
network_policies:
  github:
    name: github-readonly
    endpoints:
      - host: api.github.com
        port: 443
        protocol: rest
        enforcement: enforce
        access: read-only
    binaries:
      - path: /usr/bin/curl
`)
    console.log((await os(['policy', 'set', name, '--policy', policyPath, '--wait'])).trim())
    const get = (await inside('curl -sS -m 15 -o /dev/null -w "%{http_code}" https://api.github.com/zen')).trim()
    assert.equal(get, '200'); pass('curl GET api.github.com/zen → HTTP 200')
    const post = (await inside('curl -sS -m 15 -o /dev/null -w "%{http_code}" -X POST -d "{}" https://api.github.com/gists')).trim()
    assert.equal(post, '403'); pass('curl POST api.github.com/gists → HTTP 403 (blocked by OpenShell)')
    const wget = await inside('command -v wget >/dev/null || exit 9; if wget -q -T 5 -t 1 -O /dev/null https://api.github.com/zen; then echo UNEXPECTED; else echo PROGRAM_DENIED; fi')
    assert.match(wget, /PROGRAM_DENIED/); pass('wget denied for the same host: program identity enforced')
    const audit = await os(['logs', name])
    const auditLines = audit.split('\n').filter(l => /HTTP:|NET:OPEN/.test(l))
    assert(auditLines.some(l => /DENIED/.test(l)), 'Expected deny audit record')
    console.log(auditLines.slice(-4).map(l => '  ' + l.slice(0, 180)).join('\n'))
    pass('OpenShell audit records retained across the separate supervisor channel')

    if (fault) {
      step('5. Failure drill — stop A; B must not gain direct access')
      await supervisor.kill()
      // The runtime owns fail-closed agent suspension. Check its kernel-visible
      // process state from envd, outside the agent PID/network namespace.
      let frozen = false
      for (let i = 0; i < 30; i++) {
        const states = await run(worker, "ps -u 1500 -o stat=,comm=")
        if (states.stdout.split('\n').some(l => /^T/.test(l.trim()) && /sleep/.test(l))) { frozen = true; break }
        await sleep(1_000)
      }
      assert(frozen, 'OpenShell must freeze the agent after supervisor channel loss')
      pass('Worker runtime suspended the agent when its supervisor disappeared')
      const after = await run(worker, probe)
      assert.notEqual(after.exitCode, 0); assert.equal(after.stdout, '000')
      pass('Worker root egress remains denied after supervisor loss')
    }
    if (keep) {
      console.log(`\nTask retained for inspection: ${name}\nDelete: XDG_CONFIG_HOME=$PWD/.openshell-separated .bin/openshell sandbox delete ${name}`)
    } else {
      step(`${fault ? '6' : '5'}. Delete task — both microVMs removed, control plane stays up`)
      await os(['sandbox', 'delete', name])
      let remaining: string[] = ids
      for (let i = 0; i < 20; i++) {
        const live = await inventory(controlId)
        remaining = ids.filter(id => live.some(s => s.sandboxId === id))
        if (!remaining.length) break
        await sleep(1_000)
      }
      assert.equal(remaining.length, 0, 'Task deletion must remove BOTH VMs')
      pass('Supervisor and worker deleted together')
      await os(['sandbox', 'list']); pass('Shared control plane still available')
    }
    completed = true
    await mkdir('dist', { recursive: true })
    const report = fault ? 'dist/separated-demo-fault-verification.json' : 'dist/separated-demo-verification.json'
    await writeFile(report, JSON.stringify({ verifiedAt: new Date().toISOString(), name, controlId, supervisorId: a.sandboxId, workerId: b.sandboxId, fault, kept: keep, checks: results }, null, 2) + '\n')
    console.log(`\nPASS — ${results.length} live checks. Report: ${report}`)
  } finally {
    if (!completed || !keep) {
      await os(['sandbox', 'delete', name], 30_000).catch(() => {})
      // On partial create, discover only this demo's pair for fallback cleanup.
      if (controlId) {
        const left = await inventory(controlId).catch(() => [])
        for (const s of left.filter(s => s.metadata['openshell.ai/sandbox-name'] === name)) await Sandbox.kill(s.sandboxId)
      }
    }
    creator?.kill()
    await rm(dir, { recursive: true, force: true })
    if (!keep || !completed) connector?.kill()
    else if (connector) console.log('Laptop tunnel remains open for inspection. Ctrl-C closes the tunnel; task expires in one hour.')
  }
}
main().catch(error => { console.error(`\nFAIL: ${error.message}`); process.exitCode = 1 })
