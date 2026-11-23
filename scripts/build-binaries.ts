// Build every Linux binary the demo needs into dist/<tag>/, in an E2B builder VM:
//
//   openshell-sandbox      NVIDIA runtime                  (worker VM)
//   openshell-supervisor   NVIDIA supervisor               (supervisor VM)
//   openshell-driver-e2b   our driver, from ./driver       (control VM)
//
// The two NVIDIA binaries are either compiled from the release tag with
// patches/landlock-abi2.patch (OPENSHELL_LANDLOCK_ABI2, on by default) or
// downloaded unchanged from NVIDIA's release (OPENSHELL_LANDLOCK_ABI2=0).
//
// Usage: npm run build:binaries [-- --keep-builder] [-- --reuse --driver-only]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Sandbox } from 'e2b'
import { DIST, LANDLOCK_ABI2, OPENSHELL_TAG, TEMPLATES, verifiedRelease } from './openshell.ts'

const NVIDIA_BINS = ['openshell-sandbox', 'openshell-supervisor'] as const
// Release asset names for the stock path.
const RELEASE_ASSET: Record<(typeof NVIDIA_BINS)[number], string> = {
  'openshell-sandbox': 'openshell-sandbox-x86_64-unknown-linux-musl.tar.gz',
  'openshell-supervisor': 'openshell-supervisor-x86_64-unknown-linux-gnu.tar.gz',
}
const ID_FILE = '.builder-separated-id'
// Records what the builder's NVIDIA tree was made from, so --reuse cannot
// package binaries from another tag, variant or patch.
const STAMP = '/tmp/os/.openshell-e2b-inputs.json'
const log = (...a: unknown[]) => { console.log(new Date().toISOString().slice(11, 19), ...a) }
const stream = { onStdout: (d: string) => { process.stdout.write(d) }, onStderr: (d: string) => { process.stderr.write(d) } }

async function checkCrateTags() {
  const cargo = await readFile('driver/Cargo.toml', 'utf8')
  const tags = [...cargo.matchAll(/github\.com\/NVIDIA\/OpenShell", tag = "([^"]+)"/g)].map((m) => m[1])
  if (tags.length === 0 || tags.some((t) => t !== OPENSHELL_TAG)) {
    throw new Error(`driver/Cargo.toml pins ${tags.join(', ')} but OPENSHELL_VERSION is ${OPENSHELL_TAG}`)
  }
}

async function main() {
  await checkCrateTags()
  const reuse = process.argv.includes('--reuse')
  const driverOnly = process.argv.includes('--driver-only')
  const sbx = reuse
    ? await Sandbox.connect((await readFile(ID_FILE, 'utf8')).trim(), { timeoutMs: 60 * 60_000 })
    : await Sandbox.create(TEMPLATES.builder, { timeoutMs: 60 * 60_000, network: { allowPublicTraffic: false } })
  await writeFile(ID_FILE, sbx.sandboxId)
  let succeeded = false
  log('builder', sbx.sandboxId, `OpenShell ${OPENSHELL_TAG}`, LANDLOCK_ABI2 ? '(Landlock ABI v2 demo patch)' : '(stock NVIDIA binaries)')
  try {
    // NVIDIA binaries: stock download, or patched source build.
    const patch = await readFile('patches/landlock-abi2.patch', 'utf8')
    const inputs = JSON.stringify({
      openshell: OPENSHELL_TAG,
      landlockAbi2Patch: LANDLOCK_ABI2,
      patchSha256: LANDLOCK_ABI2 ? createHash('sha256').update(patch).digest('hex') : null,
    })
    let nvidiaBuild = 'true'
    if (!driverOnly && reuse) {
      const found = await sbx.files.read(STAMP).catch(() => '(none)')
      if (found.trim() !== inputs) {
        throw new Error(`reused builder holds ${found.trim()}, this checkout needs ${inputs}; run without --reuse`)
      }
    } else if (!driverOnly && LANDLOCK_ABI2) {
      await sbx.files.write('/tmp/landlock-abi2.patch', patch)
      await sbx.commands.run(
        `git clone -q --depth 1 --branch ${OPENSHELL_TAG} https://github.com/NVIDIA/OpenShell.git /tmp/os && ` +
        'cd /tmp/os && git apply /tmp/landlock-abi2.patch && git diff --stat',
        { timeoutMs: 180_000, ...stream },
      )
    } else if (!driverOnly) {
      await sbx.commands.run(
        'mkdir -p /tmp/os/target/release && cd /tmp/os/target/release && ' +
        NVIDIA_BINS.map((b) => verifiedRelease(RELEASE_ASSET[b], `${b}-checksums-sha256.txt`, '/tmp/os/target/release', b)).join(' && '),
        { timeoutMs: 180_000, ...stream },
      )
    }
    if (!driverOnly) {
      await sbx.files.write(STAMP, inputs)
      if (LANDLOCK_ABI2) {
        nvidiaBuild = `cd /tmp/os && cargo build --release ${NVIDIA_BINS.map((b) => `--bin ${b}`).join(' ')}`
      }
    }

    // Our driver, from the working tree (including uncommitted edits). Explicit
    // paths keep credentials, recordings and build outputs out of the builder.
    const tar = execFileSync('tar', ['-cf', '-', 'driver/Cargo.toml', 'driver/Cargo.lock', 'driver/src'])
    // A fresh name per run: a reused builder may hold an older upload.
    const upload = `/tmp/driver-${Date.now()}.tar`
    await sbx.files.write(upload, tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength) as ArrayBuffer)
    await sbx.commands.run(`rm -rf /tmp/src/driver/src && mkdir -p /tmp/src && tar -xf ${upload} -C /tmp/src`, { timeoutMs: 60_000 })

    const t0 = Date.now()
    // Both builds in parallel; the builder has 8 cores. Wait by PID: job specs
    // like %1 need job control, which non-interactive shells lack.
    await sbx.commands.run(
      `(${nvidiaBuild}) > /tmp/os.log 2>&1 & p1=$!; ` +
      '(cd /tmp/src/driver && cargo test --release && cargo build --release) > /tmp/driver.log 2>&1 & p2=$!; ' +
      'wait $p1; a=$?; wait $p2; b=$?; grep -hE "^error|Finished|test result" /tmp/os.log /tmp/driver.log; ' +
      '[ $a -eq 0 ] || tail -40 /tmp/os.log; [ $b -eq 0 ] || tail -40 /tmp/driver.log; exit $((a | b))',
      { timeoutMs: 50 * 60_000, ...stream },
    )
    log(`builds took ${Math.round((Date.now() - t0) / 1000)}s`)

    await mkdir(DIST, { recursive: true })
    const outputs = [
      ...(driverOnly ? [] : NVIDIA_BINS).map((b) => [`/tmp/os/target/release/${b}`, b]),
      ['/tmp/src/driver/target/release/openshell-driver-e2b', 'openshell-driver-e2b'],
    ]
    for (const [remote, name] of outputs) {
      const bytes = await sbx.files.read(remote, { format: 'bytes' })
      await writeFile(`${DIST}/${name}`, bytes, { mode: 0o755 })
      log(`${DIST}/${name}`, `${(bytes.length / 1e6).toFixed(1)} MB`)
    }
    if (!driverOnly) {
      // Provenance from the verified inputs above.
      await writeFile(`${DIST}/BUILD.json`, JSON.stringify(JSON.parse(inputs), null, 2) + '\n')
    }
    succeeded = true
  } finally {
    if (succeeded && !process.argv.includes('--keep-builder')) {
      await sbx.kill()
      log('builder killed')
    } else {
      log('builder retained for diagnosis/rebuild:', sbx.sandboxId, '(1-hour TTL)')
    }
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1) })
