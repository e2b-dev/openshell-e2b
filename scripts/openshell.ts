// openshell.ts: the one place that says which OpenShell this repo builds against.
//
// Bumping OpenShell = edit OPENSHELL_VERSION and the three crate tags in
// driver/Cargo.toml (build:binaries refuses to run if they disagree), then
// rebuild the binaries and templates.
import { readFileSync } from 'node:fs'

export const OPENSHELL_TAG = readFileSync(new URL('../OPENSHELL_VERSION', import.meta.url), 'utf8').trim()
export const OPENSHELL_RELEASE = `https://github.com/NVIDIA/OpenShell/releases/download/${OPENSHELL_TAG}`

// Demo-only: E2B guests run Linux 6.1 (Landlock ABI v2) and OpenShell
// requires ABI v3. When on (the default until E2B ships a newer guest kernel),
// build:binaries compiles the supervisor and runtime with
// patches/landlock-abi2.patch. Set OPENSHELL_LANDLOCK_ABI2=0 to use NVIDIA's
// stock release binaries instead.
export const LANDLOCK_ABI2 = process.env.OPENSHELL_LANDLOCK_ABI2 !== '0'

// Where build:binaries puts the Linux binaries the templates copy in.
export const DIST = `dist/${OPENSHELL_TAG}`

export const WSTUNNEL_LINUX =
  'https://github.com/erebe/wstunnel/releases/download/v11.0.0/wstunnel_11.0.0_linux_amd64.tar.gz'

// E2B template names. One task = one supervisor VM + one worker VM.
export const TEMPLATES = {
  builder: 'openshell-builder',
  control: 'openshell-control-separated',
  supervisor: 'openshell-supervisor-separated',
  workload: 'openshell-workload-separated',
} as const
