// Upload a local file into a sandbox: tsx scripts/upload.ts <id> <local> <remote>
import { readFile } from 'node:fs/promises'
import { Sandbox } from 'e2b'
const [id, local, remote] = process.argv.slice(2)
const sbx = await Sandbox.connect(id)
const buf = await readFile(local)
await sbx.files.write(remote, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
console.log(`uploaded ${local} -> ${remote} (${buf.length} bytes)`)
