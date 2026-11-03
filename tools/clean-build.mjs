// Remove every pipeline output so a build starts clean: tsc faces
// (lib/types), the host bundle, the client bundle (+map), generated Typert
// artifacts, and the Typert staging workspace.
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const paths = [
  'lib/types',
  'lib/index.js',
  'lib/client.js',
  'lib/client.js.map',
  'lib/typert.host.js',
  'lib/typert.host.d.ts',
  'lib/typert.remote-client.js',
  'lib/typert.remote-client.d.ts',
  'lib/typert.remote-client.d.ts.map',
  '.typert-work',
]
for (const entry of paths) {
  rmSync(join(root, entry), { recursive: true, force: true })
}
console.log('clean: removed', paths.length, 'build outputs')
