# repo/ — in-repo development artifacts

This directory preserves everything needed to resurrect agent-multi **inside the deepseek-harness monorepo** for rebuilding, typechecking, and running the full vitest suites. The standalone plugin in this package (`../lib`, `../src`) was produced from these in-repo packages; after in-repo development, re-run the build pipeline and copy the bundles back over `../lib`.

## Contents

```
in-repo-changes.patch          # diff of the 10 tracked repo files the packages depended on
agent-multi/                   # host package: package.json, tsconfig, tsdown.config, READMEs, tests/
client-ui-agent-multi/         # client package: package.json, tsconfig, tsdown.config, READMEs, tests/
agent-multi-profile/           # profile bundle: package.json, cordis.patch.yml, src, lib, tests, READMEs
```

`src/` sources are NOT duplicated here: the canonical copies live at `../src/host` (agent-multi) and `../src/client` (client-ui-agent-multi, minus its host stub).

## Resurrection steps

From the deepseek-harness repository root:

1. **Restore the repo wiring** captured in `in-repo-changes.patch` (tsconfig aliases/references, experimental README entries, verify-script tweak):

   ```sh
   git apply <this-dir>/in-repo-changes.patch
   ```

2. **Recreate the three packages** under `packages/experimental/`, moving sources into their in-repo shapes:

   ```
   packages/experimental/agent-multi/            ← repo/agent-multi/*  +  src = ../src/host
   packages/experimental/client-ui-agent-multi/ ← repo/client-ui-agent-multi/*  +  src/client = ../src/client
   packages/experimental/agent-multi-profile/   ← repo/agent-multi-profile/*
   ```

   (client-ui-agent-multi also needs the small host stub src/index.ts from its tsdown `clientBundle` host phase.)

3. **Install and build**:

   ```sh
   pnpm install
   tsc -b packages/experimental/agent-multi
   npx tsdown --config-loader native --env.DSH_BUILD_FACE host -F @deepseek-ai/dsh-experimental-agent-multi
   tsc -b packages/experimental/client-ui-agent-multi
   npx tsdown --config-loader native --env.DSH_BUILD_FACE client   # full workspace pass, no -F filter
   ```

   Notes: `tsdown -F` cannot be used for clientBundle packages (function-shaped workspace configs are dropped under the filter); the client pass must run over the whole workspace.

4. **Test**: the vitest suites under `agent-multi/tests` and `client-ui-agent-multi/tests` expect the repo's testkit and storage helpers; run them with the repo's `pnpm run test` filtered to those projects. On Windows under a confined sandbox, vitest needs `danger-full-access` (vite child spawn EPERM) and `tsc -b` needs `--tsBuildInfoFile` redirected outside the tree.

5. **Copy bundles back**: `agent-multi/lib/index.js` + typert artifacts and `client-ui-agent-multi/lib/client.js` back into this package's `lib/`.
