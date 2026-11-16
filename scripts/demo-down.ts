// Delete only the task pairs owned by this demo control plane, then control.
import { readFile, rm } from 'node:fs/promises'
import { Sandbox } from 'e2b'
const file = '.control-separated-id'
const id = (await readFile(file, 'utf8')).trim()
const pages = Sandbox.list({ query: { metadata: { 'openshell.ai/driver-owner': id } } })
while (pages.hasNext) {
  for (const item of await pages.nextItems()) {
    await Sandbox.kill(item.sandboxId)
    console.log('Deleted', item.metadata['openshell.ai/role'], item.sandboxId)
  }
}
await Sandbox.kill(id)
await rm(file)
console.log('Deleted shared control plane', id)
