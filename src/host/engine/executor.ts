/**
 * Per-node execution for agent-multi runs.
 *
 * Assembles the node prompt from the global ledger and runs one subagent
 * activation under the run root, journaling the attempt to the run session.
 * Retries, timeouts, tool filtering and context budgeting are inherited host
 * behavior, not per-node configuration; the run root is the parent of the
 * activation.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { AgentNodeSpec, EdgeSpec } from '../domain.ts'
import type { AgentMultiErrorClass, NodeUsagePayload, RunId } from './events.ts'
import { assembleAgentPrompt, textOf, type Ledger } from './format.ts'

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
  await deps.journal.append('agent-multi/node-start', {
    version: 1, runId: deps.runId, nodeId: node.id, nodeKind: node.kind, attempt,
  })
  await deps.journal.append('agent-multi/node-input', {
    version: 1, runId: deps.runId, nodeId: node.id, attempt, prompt: textOf(promptBlocks),
  })
  if (deps.signal.aborted) {
    return { ok: false, errorClass: 'transient', message: 'run cancelled before attempt', attempts: 0 }
  }
  // Local spawn children do not observe activation-signal abort mid-flight
  // (the signal only gates creation), so cancellation tears the activation
  // down via dispose(), which settles its result as aborted.
  let fireAbort: (() => void) | undefined
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
    const activation = await deps.ctx.subagents.startActivation({
      provider: 'spawn',
      label: node.name,
      childId,
      request: {
        prompt: promptBlocks,
        parent: deps.runRoot,
        agentOptions: {
          ...(node.model !== undefined ? { model: node.model } : {}),
        },
      },
      signal: deps.signal,
      delivery: 'caller',
    })
    // The activation type does not expose the child Agent, but the child id
    // is reserved and local, so its session events stream on the shared
    // `session/event` bus; usage accounting folds from `assistant/message`.
    const usage = observeChildUsage(deps.ctx, childId, activation)
    const winner = await Promise.race([activation.result.then(() => 'result' as const), abortTrigger])
    if (winner === 'abort') {
      await activation.dispose()
    }
    const result = await activation.result
    const nodeUsage = readUsage(usage)
    if (nodeUsage !== undefined) deps.onNodeUsage?.(nodeUsage)
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
    return { ok: false, errorClass: classification, message, attempts: attempt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const errorClass: AgentMultiErrorClass = isTransientActivationError(error) ? 'transient' : 'deterministic'
    await deps.journal.append('agent-multi/node-error', {
      version: 1, runId: deps.runId, nodeId: node.id, attempt,
      errorClass, message, attempts: attempt,
    })
    return { ok: false, errorClass, message, attempts: attempt }
  } finally {
    if (fireAbort !== undefined) deps.signal.removeEventListener('abort', fireAbort)
  }
}
