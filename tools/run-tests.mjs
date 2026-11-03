// In-process test runner: imports every test/*.test.js into this process so
// node:test auto-runs them on exit. `node --test test/` spawns one child per
// file, which the sandboxed session shell denies (spawn EPERM); importing
// in-process keeps `npm test` usable there.
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const testDir = resolve(import.meta.dirname, '..', 'test')
const files = (await readdir(testDir)).filter((name) => name.endsWith('.test.js')).sort()
if (files.length === 0) {
  console.error('run-tests: no test/*.test.js files found')
  process.exitCode = 1
} else {
  for (const name of files) {
    await import(pathToFileURL(join(testDir, name)).href)
  }
}
