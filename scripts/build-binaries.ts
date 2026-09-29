// Build every Linux binary the demo needs, in an E2B builder box, into dist/<tag>/:
//
//   openshell-sandbox      NVIDIA's runtime, with patches/landlock-abi2.patch  (agent boxes)
//   openshell-supervisor   NVIDIA's supervisor, same patch                      (control box)
//   openshell-driver-e2b   our driver, from ./driver                            (control box)
//
// Usage: npm run build:binaries
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Sandbox } from 'e2b'

const TAG = process.env.OPENSHELL_TAG ?? 'v0.1.2'
const NVIDIA_BINS = ['openshell-sandbox', 'openshell-supervisor']
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const stream = { onStdout: (d: string) => process.stdout.write(d), onStderr: (d: string) => process.stderr.write(d) }

async function main() {
  const sbx = await Sandbox.create('openshell-builder', { timeoutMs: 60 * 60_000, network: { allowPublicTraffic: false } })
  log('builder', sbx.sandboxId)
  try {
    // NVIDIA's code at the pinned tag, with the demo patch applied.
    await sbx.files.write('/tmp/landlock-abi2.patch', await readFile('patches/landlock-abi2.patch', 'utf8'))
    await sbx.commands.run(
      `git clone -q --depth 1 --branch ${TAG} https://github.com/NVIDIA/OpenShell.git /tmp/os && ` +
      'cd /tmp/os && git apply /tmp/landlock-abi2.patch && git diff --stat',
      { timeoutMs: 180_000, ...stream },
    )

    // Our driver source (committed files only, no target/ or secrets).
    const tar = execFileSync('git', ['archive', 'HEAD', 'driver'])
    await sbx.files.write('/tmp/driver.tar', tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength) as ArrayBuffer)
    await sbx.commands.run('mkdir -p /tmp/src && tar -xf /tmp/driver.tar -C /tmp/src', { timeoutMs: 60_000 })

    const t0 = Date.now()
    // Both builds in one command, in parallel; the box has 8 cores.
    await sbx.commands.run(
      `(cd /tmp/os && cargo build --release ${NVIDIA_BINS.map((b) => `--bin ${b}`).join(' ')}) > /tmp/os.log 2>&1 & ` +
      '(cd /tmp/src/driver && cargo build --release) > /tmp/driver.log 2>&1 & ' +
      'wait %1; a=$?; wait %2; b=$?; grep -hE "^error|Finished" /tmp/os.log /tmp/driver.log; exit $((a | b))',
      { timeoutMs: 50 * 60_000, ...stream },
    )
    log(`builds took ${Math.round((Date.now() - t0) / 1000)}s`)

    await mkdir(`dist/${TAG}`, { recursive: true })
    const outputs = [
      ...NVIDIA_BINS.map((b) => [`/tmp/os/target/release/${b}`, b]),
      ['/tmp/src/driver/target/release/openshell-driver-e2b', 'openshell-driver-e2b'],
    ]
    for (const [remote, name] of outputs) {
      const bytes = await sbx.files.read(remote, { format: 'bytes' })
      await writeFile(`dist/${TAG}/${name}`, bytes, { mode: 0o755 })
      log(`dist/${TAG}/${name}`, `${(bytes.length / 1e6).toFixed(1)} MB`)
    }
  } finally {
    await sbx.kill()
    log('builder killed')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
