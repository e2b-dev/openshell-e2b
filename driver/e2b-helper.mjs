#!/usr/bin/env node
// e2b-helper.mjs: the driver's hands for E2B, using E2B's official JS SDK.
//
// The Rust driver runs:   node e2b-helper.mjs <op>   and writes one JSON request to stdin.
// This script answers with one JSON object on stdout ({"ok":true,...} or {"ok":false,"error":...}).
//
//   Rust driver (OpenShell logic)  ──JSON──►  e2b-helper.mjs  ──SDK──►  E2B API / envd
//
// Why a helper: E2B has no Rust SDK. The security-critical logic stays in Rust
// (with NVIDIA's crates); this file only does plain box operations.
//
// Ops:
//   create  {template, metadata, timeoutMs}         → {sandboxId, trafficAccessToken, host9000}
//   write   {sandboxId, path, base64, user, mode?}  → {}
//   run     {sandboxId, cmd, user, background?, timeoutMs?} → {exitCode, stdout, stderr} | {pid}
//   kill    {sandboxId}                             → {killed}
//   list    {metadata}                              → {sandboxes:[{sandboxId, metadata, state}]}
//   extend  {sandboxId, timeoutMs}                  → {}
//
// Every sandbox is created private (allowPublicTraffic: false): its URLs
// require the traffic access token, which only the driver holds.
import { Sandbox, CommandExitError } from 'e2b'

const TUNNEL_PORT = 9000

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

const ops = {
  async create({ template, metadata = {}, timeoutMs = 60 * 60_000 }) {
    const sbx = await Sandbox.create(template, {
      metadata,
      timeoutMs,
      network: { allowPublicTraffic: false },
    })
    return { sandboxId: sbx.sandboxId, trafficAccessToken: sbx.trafficAccessToken, host9000: sbx.getHost(TUNNEL_PORT) }
  },

  async write({ sandboxId, path, base64, user = 'root', mode }) {
    const sbx = await Sandbox.connect(sandboxId)
    const bytes = Buffer.from(base64, 'base64')
    await sbx.files.write(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { user })
    if (mode !== undefined) await sbx.commands.run(`chmod ${mode.toString(8)} '${path}'`, { user: 'root' })
    return {}
  },

  async run({ sandboxId, cmd, user = 'root', background = false, timeoutMs = 120_000 }) {
    const sbx = await Sandbox.connect(sandboxId)
    if (background) {
      const handle = await sbx.commands.run(cmd, { user, background: true, timeoutMs: 0 })
      // Stop streaming its output but leave it running. Without this the SDK
      // keeps a live connection and this helper process never exits.
      await handle.disconnect()
      return { pid: handle.pid }
    }
    try {
      const r = await sbx.commands.run(cmd, { user, timeoutMs })
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    } catch (e) {
      if (e instanceof CommandExitError) return { exitCode: e.exitCode, stdout: e.stdout, stderr: e.stderr }
      throw e
    }
  },

  async kill({ sandboxId }) {
    return { killed: await Sandbox.kill(sandboxId) }
  },

  async list({ metadata = {} }) {
    const paginator = Sandbox.list({ query: { metadata } })
    const sandboxes = []
    while (paginator.hasNext) {
      for (const s of await paginator.nextItems()) sandboxes.push({ sandboxId: s.sandboxId, metadata: s.metadata, state: s.state })
    }
    return { sandboxes }
  },

  async extend({ sandboxId, timeoutMs }) {
    await Sandbox.setTimeout(sandboxId, timeoutMs)
    return {}
  },
}

const op = process.argv[2]
try {
  if (!ops[op]) throw new Error(`unknown op '${op}'`)
  const result = await ops[op](await readStdin())
  process.stdout.write(JSON.stringify({ ok: true, ...result }))
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
  process.exitCode = 1
}
// Exit even if an SDK connection is still open: one request, one answer.
process.stdout.end(() => process.exit())
