# dsh-agent-multi

Multi-agent workflow plugin for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh): durable workflow definitions, a journaled run engine with retry breakpoints and human-in-the-loop, schedule triggers, plus a Web canvas editor and run kanban — in one standalone third-party package.

The host half (workflow CRUD, scheduler, executor, session projection) mounts as a Cordis plugin; the Web client half (React Flow canvas, node inspector, run kanban, agent library, triggers panel) is discovered from the `dsh.client` declaration and served to the browser automatically.

## Requirements

- An installed `dsh` with a profile that provides the base services: `storageDomain`, `agentLoop`, `sessions`, `subagents`, `userQuestions`, `sessionProjections` (the standard `web`/desktop profiles provide these), and a Web UI.
- All runtime dependencies are resolved from the host dsh installation — this package declares them as peer dependencies and ships prebuilt bundles.

## Install

```sh
dsh plugin --profile web add D:\work\deepseek-harness\scratch-plugin\dsh-agent-multi
```

Or manually, in your profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-agent-multi": "link:D:\\work\\deepseek-harness\\scratch-plugin\\dsh-agent-multi"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-agent-multi"]
    }
  }
}
```

Then restart `dsh web`. The sidebar gains an "Agent Multi" entry with its icon; the panel hosts the workflow editor, run kanban, agent library, and triggers.

## Configuration

Optional fields (defaults shown) can be set in `cordis.patch.yml`:

| Field | Default | Meaning |
| --- | --- | --- |
| `runRootProvider` | `deepseek` | Provider id for the run-root agent |
| `runRootModel` | `deepseek-chat` | Model id for the run-root agent |
| `maxActive` | `8` | Max concurrently running nodes per run |
| `tokenBudget` | unset | Run-wide billed-token fuse (input + cacheRead + cacheWrite + output) |

## What you get

- **Workflow editor**: React Flow canvas with 7 node kinds (agent / input / output / router / join / loop / loop-end), per-edge middle representation (`json` / `md` / `text`) and templates, inline node inspector (name, model, provider, prompts, tool allow/deny, retry, context budget, HITL toggle), CAS-safe saves.
- **Runs**: journaled on the run-root session; per-node status, attempts, durations, token usage on the kanban; failure view with resume (journal replay skips completed nodes); HITL questions relayed through the standard question UI; single-node dry run; run history.
- **Agent library**: reusable agent specs insertable as nodes.
- **Triggers**: cron / daily / weekly schedules stored in the plugin's own storage domain; fires start a run and re-arm.

## Known limitations

- Run registry is in-memory: a host process restart does not resume in-flight runs (workflow definitions and history persist).
- Router nodes use deterministic keyword matching (no LLM routing yet).
- Loop nodes support count-mode only.
- Node output streams to the panel once at completion, not token-by-token.
- `lib/index.js` externals (`@deepseek-ai/*`, `zod`, `schemastery`) resolve from the host dsh installation — this directory is not runnable standalone outside a dsh profile.
- `src/` ships TypeScript reference sources with repo-style `.ts` extension imports; rebuilding requires the deepseek-harness repository — see `repo/README.md` for the in-repo resurrection steps.
- Token usage is billed against the run-root agent; per-child usage detail is not separately reported yet.

## Layout

```
package.json        # dsh.bundle + dsh.client manifest, exports map
cordis.patch.yml    # composition: insert host entry (client discovered via dsh.client)
lib/index.js        # host bundle (controller, engine, projection)
lib/client.js       # browser bundle (canvas editor + run kanban)
lib/typert.*.js     # typert strict remote schemas (host + remote-client)
lib/types/          # per-module type stubs
src/host, src/client  # reference TypeScript sources
test/               # node --test contract tests (manifest, patch, typert names)
repo/               # in-repo development artifacts (packages, tests, tsdown configs, restore patch)
docs/plan.md        # original design plan
```

Run the contract tests with `npm test`.
