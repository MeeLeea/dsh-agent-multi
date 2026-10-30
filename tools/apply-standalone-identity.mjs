// Copy the in-repo built client bundle into this standalone plugin, renaming the
// in-repo package identities to the standalone name. Slash-form identity strings
// are renamed; snake-form codec identifiers (built from the same strings with
// underscores) are internal to the bundle and stay as-is.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = 'D:/work/deepseek-harness';
const clientUiPkg = `${repo}/packages/experimental/client-ui-agent-multi`;
const hostPkg = `${repo}/packages/experimental/agent-multi`;

const HOST_NAME = '@deepseek-ai/dsh-experimental-agent-multi';
const CLIENT_NAME = '@deepseek-ai/dsh-experimental-client-ui-agent-multi';
const STANDALONE = 'dsh-agent-multi';

// 1) client bundle
let src = readFileSync(join(clientUiPkg, 'lib/client.js'), 'utf8');
const before = {
  clientUiRefs: (src.match(new RegExp(CLIENT_NAME.replaceAll('/', '\\/'), 'g')) ?? []).length,
  hostRefs: (src.match(new RegExp(HOST_NAME.replaceAll('/', '\\/'), 'g')) ?? []).length,
};
src = src.split(CLIENT_NAME).join(STANDALONE);
src = src.split(HOST_NAME).join(STANDALONE);

const requires = [...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
const externals = [...new Set(requires.filter((s) => !s.startsWith('.')))].sort();
const checks = {
  banner: /window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-agent-multi"/.test(src),
  packageField: src.includes('package: "dsh-agent-multi"'),
  noClientUiLeft: !src.includes(CLIENT_NAME),
  noHostLeft: !src.includes(HOST_NAME),
};
console.log(JSON.stringify({ before, externals, checks }, null, 2));
for (const [name, ok] of Object.entries(checks)) {
  if (!ok) {
    console.error(`identity check failed: ${name}`);
    process.exit(1);
  }
}
writeFileSync(join(root, 'lib/client.js'), src);
if (existsSync(join(clientUiPkg, 'lib/client.js.map'))) {
  copyFileSync(join(clientUiPkg, 'lib/client.js.map'), join(root, 'lib/client.js.map'));
}

// 2) typert artifacts (host manifest + remote client + declarations).
// The JS artifacts are esbuild self-contained bundles in .typert-build/ (the
// plugin ships bundles that resolve nothing at runtime); declarations come raw.
for (const rel of [
  'lib/typert.host.js',
  'lib/typert.remote-client.js',
]) {
  const text = readFileSync(join(root, '.typert-build', rel.split('/')[1]), 'utf8');
  if (text.includes(CLIENT_NAME)) {
    console.error(`unexpected client name in ${rel}`);
    process.exit(1);
  }
  writeFileSync(join(root, rel), text.split(HOST_NAME).join(STANDALONE));
}
for (const rel of [
  'lib/typert.host.d.ts',
  'lib/typert.remote-client.d.ts',
]) {
  const text = readFileSync(join(hostPkg, rel), 'utf8');
  if (text.includes(CLIENT_NAME)) {
    console.error(`unexpected client name in ${rel}`);
    process.exit(1);
  }
  writeFileSync(join(root, rel), text.split(HOST_NAME).join(STANDALONE));
}

// 3) client type declarations
mkdirSync(join(root, 'lib/types/client'), { recursive: true });
for (const rel of ['index.d.ts', 'mount.d.ts', 'panel.d.ts', 'locales.d.ts', 'icon.d.ts', 'css-modules.d.ts']) {
  const from = join(clientUiPkg, 'lib/types/client', rel);
  if (existsSync(from)) copyFileSync(from, join(root, 'lib/types/client', rel));
}

console.log('copied client.js, typert artifacts, and client type declarations');
