// openshell-workload: the E2B template every agent sandbox boots from.
//
// Baked in, so creating a sandbox needs no uploads of large files:
//   /opt/openshell/openshell-sandbox   patched OpenShell runtime (Landlock v2 demo patch)
//   /opt/openshell/wstunnel            tunnel server (supervisor → this box)
//   /opt/openshell/launch-sandbox.sh   builds the network fence and starts the runtime
//   user "sandbox" uid/gid 1500        the identity the agent runs as
//   /.openshell/channel/sandbox        where the driver writes this session's papers
//
// Build after scripts/build-binaries.ts:  npx tsx templates/workload.ts
import 'dotenv/config'
import { Template, defaultBuildLogger } from 'e2b'

const TAG = process.env.OPENSHELL_TAG ?? 'v0.1.2'
const WSTUNNEL = 'https://github.com/erebe/wstunnel/releases/download/v11.0.0/wstunnel_11.0.0_linux_amd64.tar.gz'

// Paths in .copy() are relative to the project root (where you run the build).
export const template = Template({ fileContextPath: process.cwd() })
  .fromBaseImage()
  .aptInstall(['socat', 'iproute2', 'util-linux', 'curl', 'ca-certificates'])
  .copy(`dist/${TAG}/openshell-sandbox`, '/opt/openshell/openshell-sandbox', { mode: 0o755, user: 'root' })
  .copy('templates/launch-sandbox.sh', '/opt/openshell/launch-sandbox.sh', { mode: 0o755, user: 'root' })
  .runCmd([
    `curl -fsSL ${WSTUNNEL} | tar xz -C /opt/openshell wstunnel && chmod 755 /opt/openshell/wstunnel`,
    'groupadd -g 1500 sandbox && useradd -u 1500 -g 1500 -M -d /sandbox -s /bin/bash sandbox',
    // Driver-owned directories: the capability-free runtime cannot create these itself.
    'install -d -m 0755 -o root -g root /.openshell /.openshell/channel',
    'install -d -m 0700 -o 1500 -g 1500 /.openshell/channel/sandbox /sandbox',
  ], { user: 'root' })

Template.build(template, 'openshell-workload', {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
})
