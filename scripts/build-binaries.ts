// Build the patched OpenShell workload + supervisor binaries in an E2B builder box.
//
// Clones NVIDIA/OpenShell at OPENSHELL_TAG, applies patches/landlock-abi2.patch,
// builds openshell-sandbox and openshell-supervisor in release mode, and
// downloads them to dist/<tag>/.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Sandbox } from 'e2b'

const TAG = process.env.OPENSHELL_TAG ?? 'v0.1.2'
const BINS = ['openshell-sandbox', 'openshell-supervisor']
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function main() {
  const sbx = await Sandbox.create('openshell-builder', { timeoutMs: 60 * 60_000, network: { allowPublicTraffic: false } })
  log('builder', sbx.sandboxId)
  try {
    await sbx.files.write('/tmp/landlock-abi2.patch', await readFile('patches/landlock-abi2.patch', 'utf8'))
    await sbx.commands.run(
      `git clone -q --depth 1 --branch ${TAG} https://github.com/NVIDIA/OpenShell.git /tmp/os && ` +
      `cd /tmp/os && git apply /tmp/landlock-abi2.patch && git diff --stat`,
      { timeoutMs: 180_000, onStdout: (d) => process.stdout.write(d) },
    )
    const t0 = Date.now()
    await sbx.commands.run(
      `cd /tmp/os && cargo build --release ${BINS.map((b) => `--bin ${b}`).join(' ')} 2>&1 | grep -E "^(error|warning: unused)|Finished|Compiling openshell"`,
      { timeoutMs: 50 * 60_000, onStdout: (d) => process.stdout.write(d) },
    )
    log(`build took ${Math.round((Date.now() - t0) / 1000)}s`)
    await mkdir(`dist/${TAG}`, { recursive: true })
    for (const b of BINS) {
      const bytes = await sbx.files.read(`/tmp/os/target/release/${b}`, { format: 'bytes' })
      await writeFile(`dist/${TAG}/${b}`, bytes, { mode: 0o755 })
      log(`dist/${TAG}/${b}`, `${(bytes.length / 1e6).toFixed(1)} MB`)
    }
  } finally {
    await sbx.kill()
    log('builder killed')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
