// openshell-control: the E2B template for the trusted control box.
//
//   /opt/openshell-e2b/bin/openshell-gateway     NVIDIA gateway, stock release
//   /opt/openshell-e2b/bin/openshell-supervisor  NVIDIA supervisor, demo patch (dist/)
//   /opt/openshell-e2b/bin/openshell-driver-e2b  our driver (dist/)
//   /opt/openshell-e2b/bin/wstunnel              tunnel client + server
//   /opt/openshell-e2b/node/                     Node 24 (the E2B SDK needs >= 22)
//   /opt/openshell-e2b/helper/                   e2b-helper.mjs + the E2B SDK
//
// Nothing secret is baked in: certificates, the E2B API key and the gateway
// config are created per box by scripts/connect.ts.
//
// Build after `npm run build:binaries`:  npm run template:control
import { Template, defaultBuildLogger } from 'e2b'

const TAG = process.env.OPENSHELL_TAG ?? 'v0.1.2'
const NODE = 'v24.21.0'
const RELEASE = `https://github.com/NVIDIA/OpenShell/releases/download/${TAG}`
const WSTUNNEL = 'https://github.com/erebe/wstunnel/releases/download/v11.0.0/wstunnel_11.0.0_linux_amd64.tar.gz'
const ROOT = '/opt/openshell-e2b'

export const template = Template({ fileContextPath: process.cwd() })
  .fromBaseImage()
  .aptInstall(['curl', 'ca-certificates', 'xz-utils', 'jq'])
  .copy(`dist/${TAG}/openshell-supervisor`, `${ROOT}/bin/openshell-supervisor`, { mode: 0o755, user: 'root' })
  .copy(`dist/${TAG}/openshell-driver-e2b`, `${ROOT}/bin/openshell-driver-e2b`, { mode: 0o755, user: 'root' })
  .copy('driver/e2b-helper.mjs', `${ROOT}/helper/e2b-helper.mjs`, { mode: 0o644, user: 'root' })
  .runCmd([
    `curl -fsSL ${RELEASE}/openshell-gateway-x86_64-unknown-linux-gnu.tar.gz | tar xz -C ${ROOT}/bin`,
    `curl -fsSL ${WSTUNNEL} | tar xz -C ${ROOT}/bin wstunnel`,
    `chmod 755 ${ROOT}/bin/*`,
    `mkdir -p ${ROOT}/node && curl -fsSL https://nodejs.org/dist/${NODE}/node-${NODE}-linux-x64.tar.xz | tar xJ -C ${ROOT}/node --strip-components=1`,
    `cd ${ROOT}/helper && echo '{"type":"module","private":true}' > package.json && PATH=${ROOT}/node/bin:$PATH npm install --silent e2b@2.51.0`,
  ], { user: 'root' })

Template.build(template, 'openshell-control', {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
})
