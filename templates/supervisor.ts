// Per-task sandbox A: policy engine + proxy. No compute driver or E2B API key.
import { Template, defaultBuildLogger } from 'e2b'
const TAG = process.env.OPENSHELL_TAG ?? 'v0.1.2'
const WSTUNNEL = 'https://github.com/erebe/wstunnel/releases/download/v11.0.0/wstunnel_11.0.0_linux_amd64.tar.gz'
const template = Template({ fileContextPath: process.cwd() })
  .fromBaseImage()
  .aptInstall(['curl', 'ca-certificates', 'python3'])
  .copy(`dist/${TAG}/openshell-supervisor`, '/opt/openshell/openshell-supervisor', { mode: 0o755, user: 'root' })
  .copy('templates/launch-supervisor.py', '/opt/openshell/launch-supervisor.py', { mode: 0o755, user: 'root' })
  .runCmd(`curl -fsSL ${WSTUNNEL} | tar xz -C /opt/openshell wstunnel && chmod 755 /opt/openshell/wstunnel`, { user: 'root' })
await Template.build(template, 'openshell-supervisor-separated', {
  cpuCount: 1, memoryMB: 1024, onBuildLogs: defaultBuildLogger(),
})
