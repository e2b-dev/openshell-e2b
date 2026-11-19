// Per-task worker VM (B): the agent runs here, under the OpenShell runtime.
//
// Baked in, so creating a sandbox uploads no large files:
//   /opt/openshell/openshell-sandbox   OpenShell runtime
//   /opt/openshell/wstunnel            reverse-tunnel server (supervisor → this VM)
//   /opt/openshell/launch-sandbox.sh   builds the network fence and starts the runtime
//   user "sandbox" uid/gid 1500        the identity the agent runs as
//   /.openshell/channel/sandbox        where the driver writes this session's files
//
// Build after `npm run build:binaries`:  npm run template:workload
import { Template, defaultBuildLogger } from 'e2b'
import { DIST, TEMPLATES, WSTUNNEL_LINUX } from '../scripts/openshell.ts'

// Paths in .copy() are relative to the project root (where you run the build).
export const template = Template({ fileContextPath: process.cwd() })
  .fromBaseImage()
  .aptInstall(['iproute2', 'util-linux', 'curl', 'wget', 'ca-certificates'])
  .copy(`${DIST}/openshell-sandbox`, '/opt/openshell/openshell-sandbox', { mode: 0o755, user: 'root' })
  .copy('templates/launch-sandbox.sh', '/opt/openshell/launch-sandbox.sh', { mode: 0o755, user: 'root' })
  .runCmd([
    `curl -fsSL ${WSTUNNEL_LINUX} | tar xz -C /opt/openshell wstunnel && chmod 755 /opt/openshell/wstunnel`,
    'groupadd -g 1500 sandbox && useradd -u 1500 -g 1500 -M -d /sandbox -s /bin/bash sandbox',
    // Driver-owned directories: the capability-free runtime cannot create these itself.
    'install -d -m 0755 -o root -g root /.openshell /.openshell/channel',
    'install -d -m 0700 -o 1500 -g 1500 /.openshell/channel/sandbox /sandbox',
  ], { user: 'root' })

await Template.build(template, TEMPLATES.workload, {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
})
