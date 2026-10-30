/**
 * Per-node execution for agent-multi runs.
 *
 * Assembles the node prompt from the global ledger, runs a fresh subagent
 * activation per attempt under the run root, retries transient and timeout
 * failures (with optional fallback model), and journals every attempt to the
 * run session. The run root is the parent of every activation; attempts are
 * fresh activations with prior failure feedback folded into the retry prompt.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
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

/** Terminal failure of a node after the retry budget was spent. */
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

/** Classify a settled subagent result into the retry decision vocabulary. */
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

/** Abort-aware backoff between retry attempts. */
function sleepBackoff(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Whether an error thrown by `startActivation` is retryable capacity trouble. */
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
 * Run one agent node to a terminal outcome: success, exhausted retries, or
 * non-retryable failure. Every attempt is journaled.
 */
export async function executeAgentNode(
  deps: NodeExecutionDeps,
  node: AgentNodeSpec,
  inEdges: readonly EdgeSpec[],
): Promise<NodeExecutionOutcome> {
  const started = Date.now()
  let attempt = 1
  let promptBlocks = assembleAgentPrompt(node, inEdges, deps.ledger, deps.userInput)
  await deps.journal.append('agent-multi/node-start', {
    version: 1, runId: deps.runId, nodeId: node.id, nodeKind: node.kind, attempt,
  })
  await deps.journal.append('agent-multi/node-input', {
    version: 1, runId: deps.runId, nodeId: node.id, attempt, prompt: textOf(promptBlocks),
  })
  while (true) {
    if (deps.signal.aborted) {
      return { ok: false, errorClass: 'transient', message: 'run cancelled before attempt', attempts: attempt - 1 }
    }
    // Local spawn children do not observe activation-signal abort mid-flight
    // (the signal only gates creation), so cancellation and node timeout tear
    // the activation down via dispose(), which settles its result as aborted.
    let timedOut = false
    let fireAbort: (() => void) | undefined
    const abortTrigger = new Promise<'abort'>(resolve => {
      fireAbort = (): void => resolve('abort')
      if (deps.signal.aborted) fireAbort()
      else deps.signal.addEventListener('abort', fireAbort, { once: true })
    })
    const timer =
      node.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            fireAbort?.()
          }, node.timeoutMs)
    try {
      const useModel = attempt > 1 && node.retry.fallbackModel !== undefined ? node.retry.fallbackModel : node.model
      const restriction = toToolRestriction(node.toolFilter)
      // The child session id is pre-assigned so the HITL installation can
      // resolve the asking node from `agent/created` without ordering
      // assumptions, and the mapping exists before the activation starts.
      const childId = SessionId(randomUUID())
      if (node.hitlEnabled) deps.hitlChildren.add(childId)
      deps.nodeOf.set(childId, node.id)
      const activation = await deps.ctx.subagents.startActivation({
        provider: 'spawn',
        label: `${node.name} (attempt ${attempt})`,
        childId,
        request: {
          prompt: promptBlocks,
          parent: deps.runRoot,
          agentOptions: {
            ...(node.provider !== undefined ? { provider: node.provider } : {}),
            ...(useModel !== undefined ? { model: useModel } : {}),
          },
          ...(restriction !== undefined ? { toolFilter: restriction } : {}),
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
      const classification = classifyStopReason(result, timedOut)
      if (classification === 'cancelled') {
        return { ok: false, errorClass: 'transient', message: 'run cancelled during attempt', attempts: attempt }
      }
      const message = result.diagnostic ?? `stop reason: ${result.stopReason}`
      await deps.journal.append('agent-multi/node-error', {
        version: 1, runId: deps.runId, nodeId: node.id, attempt,
        errorClass: classification, message, attempts: attempt,
      })
      if ((classification === 'transient' || classification === 'timeout') && attempt < node.retry.maxAttempts) {
        await sleepBackoff(node.retry.backoffMs, deps.signal)
        attempt += 1
        promptBlocks = withRetryFeedback(promptBlocks, message)
        await deps.journal.append('agent-multi/node-start', {
          version: 1, runId: deps.runId, nodeId: node.id, nodeKind: node.kind, attempt,
        })
        await deps.journal.append('agent-multi/node-input', {
          version: 1, runId: deps.runId, nodeId: node.id, attempt, prompt: textOf(promptBlocks),
        })
        continue
      }
      return { ok: false, errorClass: classification, message, attempts: attempt }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const errorClass: AgentMultiErrorClass = timedOut
        ? 'timeout'
        : isTransientActivationError(error)
          ? 'transient'
          : 'deterministic'
      if ((errorClass === 'transient' || errorClass === 'timeout') && attempt < node.retry.maxAttempts) {
        await deps.journal.append('agent-multi/node-error', {
          version: 1, runId: deps.runId, nodeId: node.id, attempt,
          errorClass, message, attempts: attempt,
        })
        await sleepBackoff(node.retry.backoffMs, deps.signal)
        attempt += 1
        promptBlocks = withRetryFeedback(promptBlocks, message)
        await deps.journal.append('agent-multi/node-start', {
          version: 1, runId: deps.runId, nodeId: node.id, nodeKind: node.kind, attempt,
        })
        await deps.journal.append('agent-multi/node-input', {
          version: 1, runId: deps.runId, nodeId: node.id, attempt, prompt: textOf(promptBlocks),
        })
        continue
      }
      await deps.journal.append('agent-multi/node-error', {
        version: 1, runId: deps.runId, nodeId: node.id, attempt,
        errorClass, message, attempts: attempt,
      })
      return { ok: false, errorClass, message, attempts: attempt }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (fireAbort !== undefined) deps.signal.removeEventListener('abort', fireAbort)
    }
  }
}

/** Append failure feedback for the next attempt to the prompt. */
function withRetryFeedback(blocks: readonly ContentBlock[], message: string): ContentBlock[] {
  return [
    ...blocks,
    {
      type: 'text',
      text: `## Retry feedback\nYour previous attempt failed: ${message}\nCorrect the failure and complete the task.`,
    },
  ]
}

/**
 * Convert the zod-inferred tool filter into the subagent tool restriction.
 * The ask-user tool needs no entry here: it is installed on the child's own
 * scoped layer (exempt from restrictions), and only nodes with `hitlEnabled`
 * receive it at all.
 * @param filter - the node's tool filter, or undefined.
 * @returns the restriction, or undefined when nothing is filtered.
 */
function toToolRestriction(filter: AgentNodeSpec['toolFilter']): ToolRestriction | undefined {
  if (filter === undefined) return undefined
  const allow = filter.allow
  const deny = filter.deny
  if (allow === undefined && (deny === undefined || deny.length === 0)) return undefined
  return {
    ...(allow !== undefined ? { allow: [...allow] } : {}),
    ...(deny !== undefined && deny.length > 0 ? { deny: [...deny] } : {}),
  }
}
