// The shared control VM: OpenShell gateway + our compute driver.
//
//   /opt/openshell-e2b/bin/openshell-gateway     NVIDIA gateway, stock release
//   /opt/openshell-e2b/bin/openshell-driver-e2b  our driver (dist/)
//   /opt/openshell-e2b/bin/wstunnel              tunnel server for the laptop and the supervisors
//   /opt/openshell-e2b/node/                     Node 24 (runs the TypeScript helper directly)
//   /opt/openshell-e2b/helper/                   e2b-helper.ts + the E2B SDK
//
// Nothing secret is baked in: certificates, the E2B API key and the gateway
// config are created per VM by scripts/connect.ts.
//
// Build after `npm run build:binaries`:  npm run template:control
import { Template, defaultBuildLogger } from 'e2b'
import { DIST, OPENSHELL_RELEASE, TEMPLATES, WSTUNNEL_LINUX } from '../scripts/openshell.ts'

const NODE = 'v24.22.1'
const ROOT = '/opt/openshell-e2b'

export const template = Template({ fileContextPath: process.cwd() })
  .fromBaseImage()
  .aptInstall(['curl', 'ca-certificates', 'xz-utils', 'jq'])
  .copy(`${DIST}/openshell-driver-e2b`, `${ROOT}/bin/openshell-driver-e2b`, { mode: 0o755, user: 'root' })
  .copy('driver/e2b-helper.ts', `${ROOT}/helper/e2b-helper.ts`, { mode: 0o644, user: 'root' })
  .runCmd([
    `curl -fsSL ${OPENSHELL_RELEASE}/openshell-gateway-x86_64-unknown-linux-gnu.tar.gz | tar xz -C ${ROOT}/bin`,
    `curl -fsSL ${WSTUNNEL_LINUX} | tar xz -C ${ROOT}/bin wstunnel`,
    `chmod 755 ${ROOT}/bin/*`,
    `mkdir -p ${ROOT}/node && curl -fsSL https://nodejs.org/dist/${NODE}/node-${NODE}-linux-x64.tar.xz | tar xJ -C ${ROOT}/node --strip-components=1`,
    `cd ${ROOT}/helper && echo '{"type":"module","private":true}' > package.json && PATH=${ROOT}/node/bin:$PATH npm install --silent e2b@2.51.0`,
  ], { user: 'root' })

await Template.build(template, TEMPLATES.control, {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
})
