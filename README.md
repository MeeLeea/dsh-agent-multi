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
| `runRootCwd` | unset | Working directory for trigger-fired runs; runs started from the Web client use the caller's current workspace instead. When the path is a registered workspace, the run session groups under it in the sidebar |

Run sessions present like ordinary chat sessions: the run session carries the workspace as its cwd (inherited by every node activation), the run input appears as the user message (which also gives the session its automatic title), and the terminal outcome lands as the assistant message — so runs show up in the sidebar, can be opened, and read like a normal conversation. On top of that, every node mirrors its conversation into the same run session as display-only `agent-multi/node-message` events: each node input and its final output appear in the chat as a bubble headed by the node name (input on the user side, output on the agent side), so one run reads as a group chat of its agent nodes without opening the per-node subagent sessions.

The run launcher shows a **Workspace** picker: it defaults to *Auto (most recently active)* — the workspace with the latest session activity — and any explicit choice overrides it for that run. Node dry runs and trigger-fired runs do not prompt; dry runs use the automatic workspace, triggers use `runRootCwd`.

While any run is live, the workflow list shows an **activity strip** under the header: one chip per running run (workflow name, short run id, agent-node progress `x/y`, elapsed time, and a "waiting for human answer" marker when HITL is open), polled every 2 s. Clicking a chip opens that run directly in the run panel; workflows with live runs also show a pulsing dot with the count on their row.

The panel header carries two tabs: **Workflows** (the list, with *New workflow* and *Import workflow*) and **Status**. The status page tracks every run known to the host: the left column lists each run with its workflow name and run-session title — a green dot while it runs, a yellow dot once settled — and the right side renders the selected run's workflow graph on a read-only canvas, ringing the currently running node in pulsing green, completed nodes in green, failed nodes in red, and a node waiting on a human answer in amber.

Each agent node has an **Allow subagent delegation** toggle (default on). Turning it off denies the node's agent the host's session-minting tools for the duration of that node's activation — `subagent`, `subagent_fork`, `task_board_run`, `squads_run_squad`, `squads_run_member`, and `workflow`, whichever the host actually exposes. The node then does its own work instead of delegating through the host task board or squads, which keeps those delegated sessions out of your sidebar and the workflow graph the single source of parallelism. Node-scoped registrations (like the HITL ask tool) are unaffected, and library agents carry the setting along.

## What you get

- **Workflow editor**: React Flow canvas with 7 node kinds (agent / input / output / router / join / loop / loop-end), per-edge middle representation (`json` / `md` / `text`) and templates, inline node inspector (name, model, prompts, permission preset, HITL toggle, subagent-delegation toggle; context budget, retry and timeout inherit host defaults), CAS-safe saves.
- **Runs**: journaled on the run-root session; per-node status, attempts, durations, token usage on the kanban; failure view with resume (journal replay skips completed nodes); HITL questions relayed through the standard question UI; single-node dry run; run history.
- **Agent library**: reusable agent specs insertable as nodes.
- **Triggers**: cron / daily / weekly schedules stored in the plugin's own storage domain; fires start a run and re-arm.

## Known limitations

- Run registry is in-memory: a host process restart does not resume in-flight runs (workflow definitions and history persist).
- Router nodes use deterministic keyword matching (no LLM routing yet).
- Loop nodes support count-mode only.
- Node output streams to the panel once at completion, not token-by-token.
- `lib/index.js` externals (`@deepseek-ai/*`, `zod`, `schemastery`) resolve from the host dsh installation — this directory is not runnable standalone outside a dsh profile.
- Token usage is billed against the run-root agent; per-child usage detail is not separately reported yet.

## Building

`src/` is the source of truth; `lib/` is generated. One command rebuilds everything:

```sh
npm install   # once: devDependencies (typescript, tsdown, @deepseek-ai/* type packages)
npm run build # clean -> tsc (host + client) -> typert generation -> tsdown bundles -> tests
```

Notes:

- The typert generator is workspace-shaped, so `tools/generate-typert.mjs` stages a throwaway workspace under `.typert-work/` (a copy of `src/host` plus every `@deepseek-ai/dsh-*` package in `node_modules`), runs the analyzer there, and copies the emitted `lib/typert.*` back. Never edit `lib/typert.*` by hand.
- `lib/types/` is pure `tsc` output; `lib/index.js` and `lib/client.js` are tsdown bundles over it.
- `npm test` runs the contract tests in-process (`node --test` spawns are denied under the harness sandbox) and then the vitest spec suite (`test/*.spec.ts`, sources imported straight from `src/`). `npm run build` runs both after bundling, so a green build means a green test suite.
- vitest transforms through oxc, which keeps TC39 decorators verbatim; `vitest.config.mjs` carries a tiny pre-pass that lowers `@Remote(...)` with esbuild in exactly the files that use it.

## Layout

```
package.json        # dsh.bundle + dsh.client manifest, exports map
cordis.patch.yml    # composition: insert host entry (client discovered via dsh.client)
lib/index.js        # host bundle (controller, engine, projection)
lib/client.js       # browser bundle (canvas editor + run kanban)
lib/typert.*.js     # typert strict remote schemas (host + remote-client)
lib/types/          # tsc emit (host at root, client under client/)
src/host, src/client  # TypeScript sources (source of truth)
tools/              # build pipeline: clean-build, generate-typert, build, run-tests
test/               # vitest specs (*.spec.ts) + contract tests (*.test.js) + helpers/
docs/plan.md        # original design plan
```

Run everything with `npm test`; `npm run test:spec` runs vitest alone. The pre-standalone in-repo archive (`repo/`) was removed after its specs were ported into `test/` — see git history for it.
