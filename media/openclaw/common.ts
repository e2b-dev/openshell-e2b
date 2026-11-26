// Shared by record.ts and compose.ts.
import { resolve } from 'node:path'

export const OUT = 'dist/openclaw-video'
export const MARKS = resolve(OUT, 'marks.jsonl')
// One window geometry for both kinds of scene: 1760x920 at (80, 80), 44 px title bar.
export const WINDOW = { x: 80, y: 80, width: 1760, height: 920, bar: 44 }
