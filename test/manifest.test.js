import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('package manifest shape', () => {
  assert.equal(pkg.name, 'dsh-agent-multi');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'].default, './lib/client.js');
  assert.equal(pkg.exports['./typert'], './lib/typert.host.js');
  assert.equal(pkg.exports['./remote'], './lib/typert.remote-client.js');
  assert.deepEqual(pkg.dsh.client.inject, [
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
  ]);
});

test('plugin meta locale files exist', () => {
  for (const rel of ['locale/en.json', 'locale/zh.json']) {
    assert.ok(existsSync(join(root, rel)), `missing ${rel}`);
  }
});

test('host bundle and typert artifacts exist', () => {
  for (const rel of [
    'lib/index.js',
    'lib/typert.host.js',
    'lib/typert.host.d.ts',
    'lib/typert.remote-client.js',
    'lib/typert.remote-client.d.ts',
  ]) {
    assert.ok(existsSync(join(root, rel)), `missing ${rel}`);
  }
});

test('client bundle exists', () => {
  assert.ok(existsSync(join(root, 'lib/client.js')), 'missing lib/client.js');
});

test('cordis.patch.yml inserts the host entry under the standalone name', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  const rows = patch.split('\n').filter((line) => /^\s*-\s*id:/.test(line));
  assert.equal(rows.length, 1, 'expected exactly one insert row');
  assert.match(patch, /name:\s*'dsh-agent-multi'/);
});

test('typert host manifest names the standalone package', () => {
  const src = readFileSync(join(root, 'lib/typert.host.js'), 'utf8');
  assert.match(src, /package:\s*['"]dsh-agent-multi['"]/);
  assert.doesNotMatch(src, /package:\s*['"]@deepseek-ai\/dsh-experimental-agent-multi['"]/);
});

test('typert remote-client manifest names the standalone package', () => {
  const src = readFileSync(join(root, 'lib/typert.remote-client.js'), 'utf8');
  assert.match(src, /package:\s*['"]dsh-agent-multi['"]/);
});

test('client bundle manifest names the standalone package', () => {
  const src = readFileSync(join(root, 'lib/client.js'), 'utf8');
  assert.match(src, /package:\s*"dsh-agent-multi"/);
});

test('host bundle externals are declared as peer dependencies', () => {
  const src = readFileSync(join(root, 'lib/index.js'), 'utf8');
  const imports = [...src.matchAll(/from\s*'(@deepseek-ai\/[^']+|zod|@deepseek-ai\/schemastery)'/g)]
    .map((m) => m[1]);
  const externals = [...new Set(imports)];
  const peers = new Set(Object.keys(pkg.peerDependencies ?? {}));
  for (const ext of externals) {
    assert.ok(peers.has(ext), `external import '${ext}' missing from peerDependencies`);
  }
});

test('client bundle externals are declared as peer dependencies', () => {
  const src = readFileSync(join(root, 'lib/client.js'), 'utf8');
  const requires = [...src.matchAll(/require\("(@deepseek-ai\/[^"]+|react[^"]*)"\)/g)]
    .map((m) => m[1]);
  // Subpaths like react/jsx-runtime resolve through the base package's exports
  // map; assert the base name only (two segments for @scope/name).
  const base = (ext) => (ext.startsWith('@') ? ext.split('/').slice(0, 2).join('/') : ext.split('/')[0]);
  const externals = [...new Set(requires.map(base))];
  const peers = new Set(Object.keys(pkg.peerDependencies ?? {}));
  for (const ext of externals) {
    assert.ok(peers.has(ext), `client external '${ext}' missing from peerDependencies`);
  }
});
