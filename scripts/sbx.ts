// Tiny E2B helper using the project's key (.env).
//   tsx scripts/sbx.ts create [template] [minutes]   -> prints id (private sandbox)
//   tsx scripts/sbx.ts exec <id> <command...>         -> runs as user, streams output
//   tsx scripts/sbx.ts kill <id>
//   tsx scripts/sbx.ts ls
import { Sandbox, CommandExitError } from 'e2b'

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'create') {
  const [template = 'base', minutes = '60'] = rest
  const sbx = await Sandbox.create(template, { timeoutMs: Number(minutes) * 60_000, network: { allowPublicTraffic: false } })
  console.log(sbx.sandboxId)
} else if (cmd === 'exec') {
  const [id, ...command] = rest
  const sbx = await Sandbox.connect(id)
  try {
    await sbx.commands.run(command.join(' '), {
      timeoutMs: 0,
      onStdout: (d) => process.stdout.write(d),
      onStderr: (d) => process.stderr.write(d),
    })
  } catch (e) {
    if (e instanceof CommandExitError) process.exit(e.exitCode)
    throw e
  }
} else if (cmd === 'kill') {
  console.log(await Sandbox.kill(rest[0]) ? `killed ${rest[0]}` : `not found ${rest[0]}`)
} else if (cmd === 'ls') {
  const p = Sandbox.list()
  for (const s of await p.nextItems()) console.log(s.sandboxId, s.templateId, s.state, s.startedAt.toISOString())
} else {
  console.error('usage: sbx.ts create|exec|kill|ls'); process.exit(2)
}
