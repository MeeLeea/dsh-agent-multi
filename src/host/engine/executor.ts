/**
 * Per-node execution for agent-multi runs.
 *
 * Assembles the node prompt from the global ledger and runs one subagent
 * activation under the run root, journaling the attempt to the run session.
 * Extra per-agent attributes (provider, reasoning effort, token and turn
 * budgets, delegation depth, preset, working directory) load from the
 * plugin-root `.agents.json` profile file, keyed by node name with a
 * documented `default` block as fallback; client-edited node fields stay
 * authoritative. Retries, timeouts, tool filtering and context budgeting
 * are inherited host behavior, not per-node configuration; the run root is
 * the parent of the activation.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, type SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { AgentNodeSpec, EdgeSpec } from '../domain.ts'
import type { AgentMultiErrorClass, NodeUsagePayload, RunId } from './events.ts'
import { assembleAgentPrompt, textOf, type Ledger } from './format.ts'
import { defaultAgentProfiles, type AgentProfile, type AgentProfileReader } from './profile.ts'

/** Every agent-multi journal event key. */
export type AgentMultiEventType = Extract<keyof SessionEventMap, `agent-multi/${string}`>

/** Session.append narrowed to non-surface agent-multi journal events. */
type AgentMultiAppend = <T extends AgentMultiEventType>(type: T, data: SessionEventMap[T]) => void

/** Journal writer bound to the run session; every append is flushed durably. */
export class RunJournal {
  constructor(
    private readonly ctx: Context,
    private readonly session: Agent['session'],
  ) {}

  /** Append one event and flush the session to durable storage. */
  async append<T extends AgentMultiEventType>(type: T, data: SessionEventMap[T]): Promise<void> {
    // agent-multi events never enter the conversation surface; this narrowed
    // local capability removes Session.append's conditional surface argument
    // while preserving the event-key/payload correlation.
    const append = this.session.append.bind(this.session) as unknown as AgentMultiAppend
    append(type, data)
    await this.ctx.sessions.flush(this.session)
  }
}

/**
 * Global tool names that mint further agent sessions: subagent spawn/fork,
 * task-board card runs, squad launches, nested workflow runs. A node with
 * `allowSubagents: false` gets these denied on its child's scoped tool
 * layer, so the node does its own work instead of delegating it away.
 */
const DELEGATION_TOOL_NAMES: readonly string[] = [
  'subagent',
  'subagent_fork',
  'task_board_run',
  'squads_run_squad',
  'squads_run_member',
  'workflow',
]

/** Terminal failure of a node. */
export interface NodeExecutionFailure {
  readonly ok: false
  readonly errorClass: AgentMultiErrorClass
  readonly message: string
  readonly attempts: number
}

/** Successful node execution; `output` becomes the ledger payload. */
export interface NodeExecutionSuccess {
  readonly ok: true
  readonly output: readonly ContentBlock[]
}

export type NodeExecutionOutcome = NodeExecutionSuccess | NodeExecutionFailure

/** Dependencies shared by every node execution within one run. */
export interface NodeExecutionDeps {
  readonly ctx: Context
  readonly runRoot: Agent
  readonly journal: RunJournal
  readonly runId: RunId
  readonly ledger: Ledger
  readonly userInput: string
  /** Run-wide cancellation; every attempt signal links to it. */
  readonly signal: AbortSignal
  /** Child session id to node id, shared with the HITL tool installation. */
  readonly nodeOf: Map<string, string>
  /** Pre-assigned child session ids whose node enables HITL. */
  readonly hitlChildren: Set<string>
  /**
   * Run-wide token fuse: called with the node usage after every settled
   * attempt. Throwing aborts the run through the shared signal.
   */
  readonly onNodeUsage?: (usage: NodeUsagePayload) => void
  /**
   * Agent attribute profiles from `.agents.json`; absent falls back to the
   * plugin-root file reader. Injection exists for tests and host overrides.
   */
  readonly profiles?: AgentProfileReader
}

/** Classify a settled subagent result into the failure vocabulary. */
export function classifyStopReason(result: SubagentResult, timedOut: boolean): AgentMultiErrorClass | 'cancelled' {
  switch (result.stopReason) {
    case 'error':
      return 'transient'
    case 'aborted':
      return timedOut ? 'timeout' : 'cancelled'
    case 'max-tokens':
    case 'refusal':
      return 'deterministic'
    default:
      return 'deterministic'
  }
}

/** Whether an error thrown by `startActivation` is capacity trouble. */
function isTransientActivationError(error: unknown): boolean {
  return error instanceof Error && /ACTIVATION_LIMIT_REACHED|capacity/i.test(error.message)
}

/**
 * Fold one child's `assistant/message` usage into per-node accounting.
 * The observer detaches with the activation; usage on abort- or error-settled
 * attempts is retained so a retried node reports what its calls consumed.
 * @param ctx - controller context seeing every child session event.
 * @param childId - reserved local child session identity.
 * @param activation - the managed child execution whose events are folded.
 * @returns the accumulated usage once the result settles, absent when no
 *   model call reported token accounting.
 */
function observeChildUsage(ctx: Context, childId: string, activation: SubagentActivation): NodeUsageAccumulator {
  const acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, any: false }
  const dispose = ctx.on('session/event', (session, event) => {
    if (session.id !== childId || event.type !== 'assistant/message') return
    const usage = event.data.usage
    if (usage === undefined) return
    acc.any = true
    acc.inputTokens += usage.inputTokens
    acc.outputTokens += usage.outputTokens
    acc.cacheReadTokens += usage.cacheReadTokens ?? 0
    acc.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  })
  void activation.result.finally(() => dispose())
  return acc
}

type NodeUsageAccumulator = { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, any: boolean }

/** Usage read out of a settled accumulator, absent when nothing reported usage. */
function readUsage(acc: NodeUsageAccumulator): NodeUsagePayload | undefined {
  return acc.any
    ? {
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens,
      }
    : undefined
}

/**
 * Merge `.agents.json` route attributes into the activation's agent
 * options. The node's client-edited `model` stays authoritative; the
 * profile contributes the attributes the client cannot edit.
 * @param node - agent node whose client-edited model may apply.
 * @param profile - resolved profile for this agent's name.
 * @returns agent options for `startActivation`'s request.
 */
function agentOptionsFor(node: AgentNodeSpec, profile: AgentProfile): { provider?: string, model?: string, reasoningEffort?: ReasoningEffortId, maxTokens?: number } {
  return {
    ...(profile.provider !== undefined ? { provider: profile.provider } : {}),
    ...(profile.reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(profile.reasoningEffort) } : {}),
    ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {}),
    ...(node.model !== undefined ? { model: node.model } : {}),
  }
}

/**
 * Watch one child's model calls against its per-agent turn budget. Every
 * `step/start` is one model call; the (budget+1)-th start fires
 * `onExceeded` exactly once — the executor then disposes the activation
 * and the node settles as a deterministic budget failure.
 * @param ctx - controller context seeing every child session event.
 * @param childId - reserved local child session identity.
 * @param maxTurns - inclusive model-call budget from `.agents.json`.
 * @param onExceeded - invoked when the child starts one call too many.
 * @returns listener disposer, released with the node attempt.
 */
function watchChildTurns(ctx: Context, childId: string, maxTurns: number, onExceeded: () => void): () => void {
  let started = 0
  let exceeded = false
  return ctx.on('session/event', (session, event) => {
    if (exceeded || session.id !== childId || event.type !== 'step/start') return
    started += 1
    if (started > maxTurns) {
      exceeded = true
      onExceeded()
    }
  })
}


/**
 * Run one agent node to a terminal outcome: success, cancellation, or
 * failure. The single attempt is journaled.
 */
export async function executeAgentNode(
  deps: NodeExecutionDeps,
  node: AgentNodeSpec,
  inEdges: readonly EdgeSpec[],
): Promise<NodeExecutionOutcome> {
  const started = Date.now()
  const attempt = 1
  const promptBlocks = assembleAgentPrompt(node, inEdges, deps.ledger, deps.userInput)
  const promptText = textOf(promptBlocks)
  await deps.journal.append('agent-multi/node-start', {
    version: 1, runId: deps.runId, nodeId: node.id, nodeKind: node.kind, attempt,
  })
  await deps.journal.append('agent-multi/node-input', {
    version: 1, runId: deps.runId, nodeId: node.id, attempt, prompt: promptText,
  })
  await deps.journal.append('agent-multi/node-message', {
    version: 1, runId: deps.runId, nodeId: node.id, nodeLabel: node.name || node.id,
    role: 'input', text: promptText,
  })
  if (deps.signal.aborted) {
    return { ok: false, errorClass: 'transient', message: 'run cancelled before attempt', attempts: 0 }
  }
  // Local spawn children do not observe activation-signal abort mid-flight
  // (the signal only gates creation), so cancellation tears the activation
  // down via dispose(), which settles its result as aborted.
  let fireAbort: (() => void) | undefined
  // Released in `finally`: if the activation never creates the child, the
  // `agent/created` listener must not outlive the node attempt.
  let releaseDelegationRestriction: (() => void) | undefined
  // Released in `finally`: the turn watchdog must not outlive the attempt
  // even when the activation never creates the child.
  let releaseTurnsWatch: (() => void) | undefined
  const abortTrigger = new Promise<'abort'>(resolve => {
    fireAbort = (): void => resolve('abort')
    if (deps.signal.aborted) fireAbort()
    else deps.signal.addEventListener('abort', fireAbort, { once: true })
  })
  try {
    // The child session id is pre-assigned so the HITL installation can
    // resolve the asking node from `agent/created` without ordering
    // assumptions, and the mapping exists before the activation starts.
    const childId = SessionId(randomUUID())
    if (node.hitlEnabled) deps.hitlChildren.add(childId)
    deps.nodeOf.set(childId, node.id)
    // A node permission override applies as one `sandbox/mode` delegation
    // event on the child session. `session/created` fires synchronously
    // inside the unpublished creation window, so the override lands before
    // the child's first confined call and is journaled with the session.
    let releasePermissionSeed: (() => void) | undefined
    if (node.permissionPreset !== undefined) {
      const mode = node.permissionPreset
      const appendSandboxMode = (session: Agent['session'], data: { mode: typeof mode, source?: 'delegation' }): void => {
        const append = session.append.bind(session) as (type: string, data: unknown) => void
        append('sandbox/mode', data)
      }
      releasePermissionSeed = deps.ctx.on('session/created', session => {
        if (session.id !== childId) return
        releasePermissionSeed?.()
        releasePermissionSeed = undefined
        appendSandboxMode(session, { mode, source: 'delegation' })
      })
    }
    // A node may refuse delegated work: `allowSubagents === false` denies
    // the host's session-minting tools on the child's scoped tool layer.
    // `agent/created` fires inside the activation start before the child's
    // first model call, so the restriction shapes the tool list the model
    // sees; the restriction rides the child's own layer, which dies with
    // the activation — no manual disposal needed.
    if (node.allowSubagents === false) {
      releaseDelegationRestriction = deps.ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
        if (agent.id !== childId) return
        releaseDelegationRestriction?.()
        releaseDelegationRestriction = undefined
        // Restrict() rejects unknown names and the host's delegation tools
        // are optional features, so deny only what this child actually
        // inherits — the scoped `get` covers global AND ancestor-layer
        // contributions (tools.get with no scope reads the global view
        // only). An already-restricted-away name reads as absent, which
        // is fine: it is already denied.
        const scope = scopeOf(agent.ctx)
        const deny = DELEGATION_TOOL_NAMES.filter(name =>
          scope !== undefined && agent.ctx.tools.get(name, scope) !== undefined)
        if (deny.length === 0) return
        try {
          agent.ctx.tools.restrict({ deny })
        } catch (error) {
          // A scope-local name (the child's OWN registrations are not
          // restrictable) would land here; delegation tools never are, but
          // a failed denial must not fail the node.
          agent.ctx.logger.warn(`agent-multi: allowSubagents=false could not deny delegation tools: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    }
    // Additional attributes for this agent come from the plugin-root
    // `.agents.json` (per-name entry over `default`); loading is best-effort
    // and never fails the node. Client-edited node fields stay
    // authoritative — the profile only contributes what the client cannot
    // edit.
    const profile = await (deps.profiles ?? defaultAgentProfiles()).resolve(node.name, deps.ctx.logger)
    const maxTurns = profile.maxTurns
    // The turn watchdog registers before activation starts so no early
    // `step/start` of the child is missed; its trigger joins the abort race
    // below, and the winner disposes the activation (settling it aborted).
    const turnsTrigger = maxTurns === undefined
      ? undefined
      : new Promise<'turns'>(resolve => {
          const fire = (): void => resolve('turns')
          releaseTurnsWatch = watchChildTurns(deps.ctx, childId, maxTurns, fire)
        })
    const activation = await deps.ctx.subagents.startActivation({
      provider: 'spawn',
      label: node.name,
      childId,
      request: {
        prompt: promptBlocks,
        parent: deps.runRoot,
        ...(profile.maxDepth !== undefined ? { maxDepth: profile.maxDepth } : {}),
        ...(profile.agentPreset !== undefined ? { agentPreset: profile.agentPreset } : {}),
        ...(profile.cwd !== undefined ? { cwd: profile.cwd } : {}),
        agentOptions: agentOptionsFor(node, profile),
      },
      signal: deps.signal,
      delivery: 'caller',
    })
    // The activation type does not expose the child Agent, but the child id
    // is reserved and local, so its session events stream on the shared
    // `session/event` bus; usage accounting folds from `assistant/message`.
    const usage = observeChildUsage(deps.ctx, childId, activation)
    const settled = activation.result.then(() => 'result' as const)
    const winner = turnsTrigger === undefined
      ? await Promise.race([settled, abortTrigger])
      : await Promise.race([settled, abortTrigger, turnsTrigger])
    if (winner === 'abort' || winner === 'turns') {
      await activation.dispose()
    }
    const result = await activation.result
    const nodeUsage = readUsage(usage)
    if (nodeUsage !== undefined) deps.onNodeUsage?.(nodeUsage)
    if (winner === 'turns' && maxTurns !== undefined) {
      // The child started one model call beyond its budget; disposal
      // settled the activation aborted, which reads as cancellation —
      // report it as the deterministic budget failure it is.
      const message = `agent "${node.name}" exceeded its maxTurns budget of ${maxTurns} model calls`
      await deps.journal.append('agent-multi/node-error', {
        version: 1, runId: deps.runId, nodeId: node.id, attempt,
        errorClass: 'deterministic', message, attempts: attempt,
      })
      await deps.journal.append('agent-multi/node-message', {
        version: 1, runId: deps.runId, nodeId: node.id, nodeLabel: node.name || node.id,
        role: 'output', text: message,
      })
      return { ok: false, errorClass: 'deterministic', message, attempts: attempt }
    }
    if (result.stopReason === 'completed') {
      const text = textOf(result.output)
      await deps.journal.append('agent-multi/node-delta', {
        version: 1, runId: deps.runId, nodeId: node.id, attempt, delta: text,
      })
      await deps.journal.append('agent-multi/node-end', {
        version: 1, runId: deps.runId, nodeId: node.id, attempt,
        output: text, payload: text, stopReason: 'completed', durationMs: Date.now() - started,
        ...(nodeUsage !== undefined ? { usage: nodeUsage } : {}),
      })
      await deps.journal.append('agent-multi/node-message', {
        version: 1, runId: deps.runId, nodeId: node.id, nodeLabel: node.name || node.id,
        role: 'output', text,
      })
      return { ok: true, output: result.output }
    }
    const classification = classifyStopReason(result, false)
    if (classification === 'cancelled') {
      return { ok: false, errorClass: 'transient', message: 'run cancelled during attempt', attempts: attempt }
    }
    const message = result.diagnostic ?? `stop reason: ${result.stopReason}`
    await deps.journal.append('agent-multi/node-error', {
      version: 1, runId: deps.runId, nodeId: node.id, attempt,
      errorClass: classification, message, attempts: attempt,
    })
    await deps.journal.append('agent-multi/node-message', {
      version: 1, runId: deps.runId, nodeId: node.id, nodeLabel: node.name || node.id,
      role: 'output', text: message,
    })
    return { ok: false, errorClass: classification, message, attempts: attempt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const errorClass: AgentMultiErrorClass = isTransientActivationError(error) ? 'transient' : 'deterministic'
    await deps.journal.append('agent-multi/node-error', {
      version: 1, runId: deps.runId, nodeId: node.id, attempt,
      errorClass, message, attempts: attempt,
    })
    await deps.journal.append('agent-multi/node-message', {
      version: 1, runId: deps.runId, nodeId: node.id, nodeLabel: node.name || node.id,
      role: 'output', text: message,
    })
    return { ok: false, errorClass, message, attempts: attempt }
  } finally {
    if (fireAbort !== undefined) deps.signal.removeEventListener('abort', fireAbort)
    releaseDelegationRestriction?.()
    releaseTurnsWatch?.()
  }
}
