---
description: "Enable the multi-agent workflow canvas, run engine, and Web kanban with one experimental bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-agent-multi-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-agent-multi-profile` enables the [Agent Multi](../agent-multi/README.md) workflow service and its [Web canvas](../client-ui-agent-multi/README.md) with one bundle. Compose multi-agent workflows on the sidebar canvas, start them from an input window, and watch each node on the run kanban with retry, breakpoints, human-in-the-loop pauses, and token accounting. Runs are journaled on a run-root session and can be resumed after a failure once the cause is fixed. The bundle ships with dsh switched off. Enable it from the Plugins page or add it to an initialized profile.

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

### Install into a profile

Add the package to an initialized profile, then open Web and click the Agent Multi icon in the sidebar:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-experimental-agent-multi-profile
```

The profile must already contain `@deepseek-ai/dsh-base`, whose Subagent services and provider rows the run engine consumes. Removing the package with `dsh plugin --profile <name> remove @deepseek-ai/dsh-experimental-agent-multi-profile` removes the bundle from the profile's ordered layer list.

### What you get

The layer adds the Agent Multi domain: durable workflow definitions, the journaled run engine with retry classification and breakpoint resume, the trigger table, and the Typert remote surface the Web client consumes. The sidebar panel offers the React Flow canvas for composing agent, router, join, and loop nodes, the input window for starting a run, and the run kanban with per-node status, attempts, durations, token usage, HITL cards, and resume controls. The Plugins page reads the bundle's [icon](icon.svg) from its `package.json.icon` declaration, including while the bundle is disabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package's runtime content is [`cordis.patch.yml`](cordis.patch.yml). Applied after `dsh-base`, the patch inserts the workflow service with an explicit concurrency limit and the Web UI row. The UI plugin has an inert Host entry; only the Web Client loader mounts its browser entry, so headless profiles need no Web server.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Ordered patch over `dsh-base` |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Experimental packages](../README.md) — incubation status and publication policy.
- [Agent Multi service](../agent-multi/README.md) — the workflow domain, run engine, and remote surface.
- [Agent Multi browser UI](../client-ui-agent-multi/README.md) — the canvas editor and run kanban.
- [Base bundle](../../bundle/base/README.md) — the profile layer this patch extends.

-----

<a id="model-experience"></a>
## Model Experience

### Workflow node runs

#### What the model sees

The assembled prompts and HITL tool schema belong to [`@deepseek-ai/dsh-experimental-agent-multi`](../agent-multi/README.md#model-experience). This bundle changes composition only: each node runs as a fresh one-shot subagent whose prompt is assembled from the user input and direct-predecessor outputs; run-node children see no other context.

#### Token effect

The bundle adds the per-node subagent requests described by `@deepseek-ai/dsh-experimental-agent-multi`; it adds no prompt text of its own.

#### KV Cache effect

The bundle's composition is prefix-stable while its patch, workflow definitions, and configured node options remain unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The bundle inherits every limitation of the two packages it mounts.

- **Opt-in only** — the package ships with the installation switched off; no shipped CLI, Web, SDK, ACP, or Python profile enables it.
- **In-memory run registry** — run history and pending breakpoints live in the host process; restarting the process clears them even though run sessions stay journaled.
- **Base profile required** — the patch depends on row ids and Subagent providers supplied by `dsh-base`; it is not a standalone profile.
- **Experimental prototype with no stability promise.**

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
