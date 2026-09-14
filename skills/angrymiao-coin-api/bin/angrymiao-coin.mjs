#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/angrymiao-coin-cli.ts', import.meta.url))
const result = spawnSync(
  process.execPath,
  ['--no-warnings', '--experimental-strip-types', script, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)

if (result.error) {
  console.error(result.error.message)
  process.exitCode = 1
} else {
  process.exitCode = result.status ?? 1
}
