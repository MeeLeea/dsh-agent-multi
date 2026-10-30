---
description: "Compose and run multi-agent workflows on a drag-and-drop canvas with per-node model configuration, retry, breakpoints, human-in-the-loop, and scheduled triggers (experimental)."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-multi

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-multi` runs multi-agent workflows composed on a drag-and-drop canvas: input flows through agent nodes, each a real subagent with its own model, provider, prompt, and tool filter, shaped by router, join, and loop nodes. Runs journal `agent-multi/*` events into a session and project a per-node kanban with token and latency accounting. Node failures pause at a breakpoint for resume; optional human-in-the-loop questions route through the run root. Experimental; the Web panel is `dsh-experimental-client-ui-agent-multi`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add this package when a composition needs structured multi-agent pipelines — reviewer chains, fan-out summarization, routed escalation — orchestrated from the Web sidebar instead of ad-hoc delegation prompts. The client package depends on this one, so mounting both is the normal setup.

### When to choose it

Choose it for declarative, inspectable agent pipelines with durable definitions, per-node configuration hot-editing between runs, run kanban with token and latency accounting, and breakpoint-resume after failures. Do not choose it for unstructured teamwork in one shared conversation (that is `dsh-experimental-agent-team`) or for fan-out research delegation from a single agent (the built-in `subagent` tool).

### Smallest working setup

<a id="smallest-working-setup"></a>

Mount the host service and the client panel:

```yaml
# smallest agent-multi setup — host service plus client panel
- name: '@deepseek-ai/dsh-experimental-agent-multi'
- name: '@deepseek-ai/dsh-experimental-client-ui-agent-multi'
```

The service validates its configuration at startup:

| Field | Default | Meaning |
|---|---|---|
| `runRootProvider` | `deepseek` | Provider for the dormant run-root agent (it never makes model calls) |
| `runRootModel` | `deepseek-chat` | Model for the dormant run-root agent |
| `maxActive` | `8` | Maximum concurrent node activations per run |
| `tokenBudget` | unset | Default billed-token budget per run; requests and triggers may override it |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-multi) is the exhaustive source for every accepted field and its JSDoc.

### Workflows

A workflow is a directed graph of seven node kinds: `input`, `agent`, `router`, `join`, `loop`, `output`, and `note` (never executes). Agent nodes carry the full per-node configuration: system prompt, provider, model, tool allow/deny filter, context budget, retry policy (`maxAttempts`, `backoffMs`, optional `fallbackModel`), timeout, and whether the node may ask the user questions. Edges carry the intermediate-layer contract: `format` (`json`/`md`/`text`) renders the upstream output, `template` reshapes it with `{{output}}` and `{{nodes.<id>}}` references, and `inContext` decides whether the edge feeds the downstream prompt.

Definitions are stored durably with optimistic concurrency: saving a draft based on a stale revision returns `conflict` with the current definition. Whole workflows export to a portable JSON document and import as new definitions.

### Runs

A run executes the current stored definition in a dedicated session. The engine schedules agent nodes with at most `maxActive` activations in flight; a deterministic keyword-match router, all/any/quorum joins, and count-mode loops shape the flow. Each agent node runs as a fresh subagent activation whose prompt assembles the user input, the node's system prompt, and its direct predecessors' rendered outputs — agents have no individual memory; the run's global ledger plus the input window is the context.

Every state change journals an `agent-multi/*` event (run/node lifecycle, deltas, errors, human-in-the-loop, pauses). The `agentMulti` projection folds the journal into the per-node view — status, attempts, trimmed output preview, failure classification, duration, and token usage — which the Web panel polls for its kanban.

Failures pause the run: transient and timeout failures retry with the configured policy (fresh activation per attempt, failure feedback appended to the prompt, fallback model from the second attempt); deterministic failures such as invalid tool calls exhaust no retries. When retries are exhausted the run stops at a breakpoint — the failing node's error class and message appear in the panel, and a resume restarts the run on the same journal, skipping completed nodes and reloading the current stored definition, so fixes or node edits take effect immediately.

A billed-token budget (uncached input + cache reads + cache writes + output) aborts in-flight activations and pauses the run as a breakpoint when exceeded.

### Human-in-the-loop

An agent node with `hitlEnabled` receives an `agent-multi-ask-user` tool. Its questions relay through the run root's standard question surface, journal as `hitl-asked`/`hitl-answered` events, and block the node until answered. Nodes without the flag never see the tool.

### Triggers

A trigger binds a workflow to a `cron`, `daily`, or `weekly` timing rule with a fixed run input. The service runs its own timer: a due trigger starts a run, records `lastRunId`, and re-arms its committed target. Disabling preserves the committed target; re-enabling recomputes a strictly future one, so a disabled trigger never back-fires missed occurrences. Trigger persistence follows the storage domain, not the ScheduleService, so triggers survive restarts only with durable storage.

### What success and failure look like

Success returns the stored definition, a run id, a projected node view, or a saved trigger. Invalid graphs report the full rejection list with per-node/edge locators; revision conflicts report the current definition; exhausted retries report the failing node's error class, message, and attempt count for resume.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on one separation and three commitments:

- **Durable definitions, journaled runs.** The storage domain owns workflows, library agents, and triggers; each run journals `agent-multi/*` events to its own session and the projection derives all state.
- **Real subagents, no private memory.** Every agent node is a fresh activation with an assembled prompt; context is the global run ledger filtered to direct predecessors.
- **Failure is a pause, not a loss.** Deterministic breakups journal a breakpoint and keep the session, so resume replays the journal and continues.
- **Bounds that fail loud.** Graph validation rejects invalid structure with located codes; token budgets abort and pause instead of overspending silently.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, remote workflow/run/trigger/library methods, run registry, trigger wiring |
| [`src/domain.ts`](src/domain.ts) | Zod schemas for nodes, edges, definitions, library agents, and triggers; the `agent_multi` storage domain |
| [`src/contract.ts`](src/contract.ts) | Wire request/result interfaces, validation codes, and the run view types |
| [`src/validation.ts`](src/validation.ts) | Pure semantic graph validation (degrees, handles, router/join/loop rules, Kahn cycle check) |
| [`src/engine/run.ts`](src/engine/run.ts) | Run orchestration: scheduling loop, concurrency cap, token fuse, journal, replay |
| [`src/engine/scheduler.ts`](src/engine/scheduler.ts) | Edge-state scheduling, router resolution, join strategies, loop control |
| [`src/engine/executor.ts`](src/engine/executor.ts) | Per-node subagent activation, retry with feedback, error classification, usage observation |
| [`src/engine/format.ts`](src/engine/format.ts) | Intermediate-layer rendering, edge templates, prompt assembly, context trimming |
| [`src/engine/hitl.ts`](src/engine/hitl.ts) | Human-in-the-loop tool installation on child agents |
| [`src/engine/trigger-runtime.ts`](src/engine/trigger-runtime.ts) | Single-timer trigger drive with commit-and-re-arm semantics |
| [`src/engine/events.ts`](src/engine/events.ts) | The 12 `agent-multi/*` session event payload types |
| [`src/projection.ts`](src/projection.ts) | Strict journal replay projection publishing the `agentMulti` client view |
| [`src/trigger-views.ts`](src/trigger-views.ts) | Timing-rule helpers bridging trigger records to schedule resolution |

### Runs and journaling

`startRun` creates a dormant run-root agent via the agent loop, then executes the workflow in that session. The engine appends and flushes one event per state change; the projection (`agentMulti` key) folds them into per-node views. `getRun` merges the projection state with the in-memory registry, so the kanban reflects journal truth, not just live memory. Resume reuses the same run id: `replayJournal` marks nodes completed from `node-end` events, then execution continues with the freshly loaded stored definition.

### Retry and error classification

Each attempt is a fresh subagent activation with the prior failure appended as prompt feedback — continuation delivery has no result observation, so retrying the activation is the observable contract. `classifyStopReason` maps stop reasons to error classes: errors are transient (retryable), timeouts retry, `max-tokens` and `refusal` are deterministic (no retry). The retry policy may switch to `fallbackModel` from the second attempt.

### Token accounting

Subagent results carry no usage, so the executor observes the child session's `assistant/message` events and folds their `TokenUsage` into per-attempt counters; `node-end` carries the sum. The run-level fuse sums billed tokens (uncached input + cache reads + cache writes + output) and pauses the run when the budget is exceeded.

### Triggers

The trigger runtime owns one `setTimeout` re-armed from the earliest committed target (clamped to the timer maximum). Recurring math delegates to `dsh-schedule`'s `resolveRecurringOccurrence` family by constructing transient schedule records from the trigger's timing rule. The ScheduleService itself is deliberately unused: it delivers followup messages into session inboxes, while agent-multi runs are promise-driven by the controller.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Client UI package](../client-ui-agent-multi/README.md) — the sidebar panel, canvas editor, and run kanban.
- [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-agent-multi) — every accepted configuration field.
- [Session events](../../core/session/README.md) — the journal every run writes to.

<a id="model-experience"></a>
## Model Experience

### Assembled node prompts

#### What the model sees

Each agent-node activation receives one user-role prompt assembled from the run input, the node's system prompt, and its direct predecessors' rendered outputs (per-edge `format`, `template`, `inContext`). Retry attempts append the prior failure as a `## Retry feedback` section.

#### Token effect

Per-activation and data-dependent: the prompt length is the assembled section total, capped only when `contextBudgetTokens` trims predecessor sections from the end.

#### KV Cache effect

Independent model request per attempt; each activation starts a fresh child session, so earlier requests leave no reusable prefix within the run.

### Human-in-the-loop tool schema

#### What the model sees

Agent nodes with `hitlEnabled` receive one extra tool, `agent-multi-ask-user`, whose single `question` string argument the child model fills. The schema mirrors `ask_user_question`'s [question field](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ask-user); only the tool name and single-field wrapper differ.

#### Token effect

Conditional and small: the tool schema is appended to the child's tool list only on human-in-the-loop-enabled nodes.

#### KV Cache effect

Independent request per node activation; enabling the flag changes only that activation's own request, not any other prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the workflow engine cannot do yet or what needs special operational care. They are current package constraints, not a comparison with other coordination mechanisms.

- **In-memory run registry** — a host restart loses live runs; run-root session recovery is planned.
- **Deterministic router** — keyword match, not model-driven routing.
- **Count-mode loops** — items/while modes are validated but not executed.
- **Completion-time deltas** — `node-delta` is emitted once at completion, not streamed per token.
- **Truncating context trim** — `contextBudgetTokens` drops predecessor sections from the end rather than summarizing.
- **No per-node skill directories or read-write permissions** — nodes inherit the run root's; the subagent start request has no such fields.
- **Single input window** — one input per run start; mid-run user input is HITL-only.
- **Trigger delivery is in-process** — triggers need durable storage to survive restarts, and missed occurrences during downtime never back-fire.
- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

#### Promotion

Promotion to a product-role group requires reviewing the public contract, limitations, test evidence, release payload, runtime dependents, and a named stable owner, per the [experimental subtree rules](../AGENTS.md).

#### Future directions

Undecided directions include model-driven routing, streaming deltas from subagent delivery, run recovery from persisted sessions, and per-node workspace binding; none of these are committed.

</details>
