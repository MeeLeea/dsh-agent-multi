---
description: "Web sidebar panel for multi-agent workflows: canvas editor, run kanban, and trigger management (experimental)."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-multi

English | [中文](README.zh.md)

## Summary

`dsh-experimental-client-ui-agent-multi` renders the agent-multi workflow panel in the Web client: a sidebar entry with its own icon, a workflow list, a drag-and-drop canvas editor with hot-editable node and edge configuration, a run kanban with per-node status, output, token, and latency views plus breakpoint-resume controls, an agent library, and trigger management. It talks to `dsh-experimental-agent-multi` over generated typert remotes. This package is experimental.

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

Mount this package together with the host service to get the full sidebar experience; it has no standalone use.

```yaml
# smallest agent-multi setup — host service plus client panel
- name: '@deepseek-ai/dsh-experimental-agent-multi'
- name: '@deepseek-ai/dsh-experimental-client-ui-agent-multi'
```

### Workflow editor

The canvas is a React Flow surface: drag nodes from the palette (input, agent, router, join, loop, output, note), wire handles into edges, and select any node or edge to edit its configuration inline — agent identity fields (name, system prompt, provider, model, tool allow/deny lists, context budget, retry policy, timeout, human-in-the-loop flag), router cases, join strategy, loop parameters, and per-edge intermediate format (`json`/`md`/`text`), template, and context inclusion. Validation runs on demand and before every save; the badge reports the full located issue list. Saves use optimistic concurrency and surface conflicts explicitly.

### Run kanban

Starting a run opens an input window, then the run view: read-only canvas with per-node status rings, kanban cards with attempt counts, durations, token summaries, and output previews, a human-in-the-loop card while a question is open, and the event journal below. A failed run shows the failing node's error class and message with a resume button that restarts on the same journal. Run history lists past runs per workflow. A single-node dry run executes one agent node in isolation from the inspector.

### Agent library and triggers

The palette's library section inserts saved agent specs as new nodes; the inspector's save-to-library form captures one. The trigger panel manages cron/daily/weekly triggers bound to the workflow, with enable/disable and deletion.

### Localization

All panel copy is locale-owned through typed dictionaries (namespace `agent-multi`, English and Chinese).

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The client registers three surfaces on mount: the Remote namespace `agentMulti` (generated client), the main-panel slot keyed `agent-multi`, and the sidebar row (order 30). `WorkflowPage` switches between list, editor, and run views; `WorkflowEditor` owns the React Flow canvas and the node/edge inspector; `RunPanel` polls `getRun` at 1s intervals while a run is executing and refreshes history otherwise. All state is local React state plus the remote calls — no client-side store beyond component state.

The client bundle is built through the repo's `clientBundle` config with `hostPhase: true`: the host pass emits a node stub, the client pass emits `lib/client.js`. The panel copy lives in `locales.ts` behind a key union type; the locale namespace merges into `LocaleNamespaceMap` by declaration merging.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Host service](../agent-multi/README.md) — workflow storage, run engine, triggers, and the event journal.
- [Client UI conventions](../../../docs/development.md) — slots, locale ownership, and bundling.

<a id="model-experience"></a>
## Model Experience

None, as this browser panel registers no model-facing input.

#### KV Cache effect

No direct effect; the workflow engine's assembled prompts and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe what the panel cannot do yet or what needs special operational care. They are current package constraints, not a comparison with other client surfaces.
- **Polling refresh** — the run view polls once per second rather than subscribing to journal events.
- **Canvas rings, not live layout** — the run canvas is read-only; node positions come from the saved definition.
- **No offline editing** — every mutation is a remote round-trip; drafts live in component state only.
- **Experimental prototype with no stability promise** — the package is public, but its contracts can change freely while it incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative.

#### Promotion

Promotion to a product-role group requires reviewing the public contract, limitations, test evidence, release payload, runtime dependents, and a named stable owner, per the [experimental subtree rules](../AGENTS.md).

</details>
