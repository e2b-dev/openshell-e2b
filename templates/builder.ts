// openshell-builder: 8 vCPU / 8 GB box with Rust 1.95 for building OpenShell (+ our E2B driver).
import { Template, defaultBuildLogger } from 'e2b'

export const template = Template()
  .fromBaseImage()
  .aptInstall([
    'build-essential', 'pkg-config', 'libssl-dev', 'protobuf-compiler',
    'clang', 'cmake', 'git', 'curl', 'musl-tools', 'jq', 'iproute2',
  ])
  .runCmd([
    'curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.95.0',
    '$HOME/.cargo/bin/rustup target add x86_64-unknown-linux-musl',
  ])
  .setEnvs({ PATH: '/home/user/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' })

Template.build(template, 'openshell-builder', {
  cpuCount: 8,
  memoryMB: 8192,
  onBuildLogs: defaultBuildLogger(),
})
