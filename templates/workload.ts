// Per-task worker VM (B): the agent runs here, under the OpenShell runtime.
// The OpenShell layers are in worker-layers.ts.
//
// OPENSHELL_WORKLOAD_FROM=<template> builds on an existing E2B template (for
// example E2B's `claude`, which ships Claude Code at /usr/local/bin/claude).
//
// Build after `npm run build:binaries`:  npm run template:workload
import { Template, defaultBuildLogger } from 'e2b'
import { TEMPLATES } from '../scripts/openshell.ts'
import { withOpenShellWorker } from './worker-layers.ts'

// Paths in .copy() are relative to the project root (where you run the build).
const base = Template({ fileContextPath: process.cwd() })
const from = process.env.OPENSHELL_WORKLOAD_FROM
export const template = withOpenShellWorker(from ? base.fromTemplate(from) : base.fromBaseImage())

await Template.build(template, TEMPLATES.workload, {
  cpuCount: 2,
  memoryMB: 2048,
  onBuildLogs: defaultBuildLogger(),
})
