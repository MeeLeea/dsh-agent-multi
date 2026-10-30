// Offline typert manifest verification: import the generated host artifact
// (its only external dependency is zod) and assert the manifest that
// typert-loader will validate at load time. This mirrors the loader's check
// `manifest.package === entry name` without needing a Cordis runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('typert host artifact exposes a loadable manifest', async () => {
  const mod = await import(pathToFileURL(join(root, 'lib/typert.host.js')).href);
  const manifest = mod.TYPERT;
  assert.ok(manifest, 'TYPERT export missing');
  assert.equal(manifest.package, 'dsh-agent-multi');
  assert.equal(manifest.face, 'host');
  const invocations = manifest.invocations;
  assert.ok(Array.isArray(invocations) && invocations.length >= 20, 'no typert invocations');
  const names = new Set(invocations.map((d) => `${d.namespace}/${d.method}`));
  for (const method of ['createWorkflow', 'saveWorkflow', 'listWorkflows', 'startRun', 'resumeRun', 'cancelRun']) {
    assert.ok(names.has(`agentMulti/${method}`), `invocation agentMulti/${method} missing`);
  }
  for (const d of invocations) {
    assert.equal(d.service, 'agentMultiController', `invocation ${d.id} service mismatch`);
  }
});
