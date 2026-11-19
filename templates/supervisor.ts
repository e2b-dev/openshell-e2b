// Per-task supervisor VM (A): OpenShell supervisor + policy proxy + two tunnel
// clients. No compute driver and no E2B API key.
import { Template, defaultBuildLogger } from 'e2b'
import { DIST, TEMPLATES, WSTUNNEL_LINUX } from '../scripts/openshell.ts'

const template = Template({ fileContextPath: process.cwd() })
  .fromBaseImage()
  .aptInstall(['curl', 'ca-certificates', 'python3'])
  .copy(`${DIST}/openshell-supervisor`, '/opt/openshell/openshell-supervisor', { mode: 0o755, user: 'root' })
  .copy('templates/launch-supervisor.py', '/opt/openshell/launch-supervisor.py', { mode: 0o755, user: 'root' })
  .runCmd(`curl -fsSL ${WSTUNNEL_LINUX} | tar xz -C /opt/openshell wstunnel && chmod 755 /opt/openshell/wstunnel`, { user: 'root' })

await Template.build(template, TEMPLATES.supervisor, {
  cpuCount: 1,
  memoryMB: 1024,
  onBuildLogs: defaultBuildLogger(),
})
