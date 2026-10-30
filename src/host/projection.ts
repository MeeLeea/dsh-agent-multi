/**
 * agent-multi run state projected incrementally from the run Session's
 * agent-multi journal events. One run Session belongs to exactly one run
 * (resume reuses both), so the state holds at most one run; the wire view is
 * the kanban/canvas shape: per-node status, streaming output, HITL state,
 * and the terminal failure derived from node errors.
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { NodeKind, WorkflowId } from './types.ts'
import { RunId, type AgentMultiErrorClass, type NodeStopReason, type NodeUsagePayload } from './engine/events.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const runIdSchema = z.string().min(1).transform(value => brandString<RunId>(value))

/** Cap on the accumulated streaming preview of one running node. */
const MAX_STREAM_CHARS = 20_000

/** Per-node status within one run, as the kanban and canvas rings consume it. */
export type NodeViewStatus = 'running' | 'completed' | 'failed'

/** One node's projected lifecycle inside its run. */
export interface NodeView {
  readonly nodeId: string
  readonly nodeKind: NodeKind
  status: NodeViewStatus
  /** Latest attempt number seen for the node. */
  attempt: number
  /** Fully-assembled prompt of the latest attempt. */
  prompt?: string
  /** Accumulated streaming preview while running; replaced by `output` on end. */
  streaming?: string
  output?: string
  payload?: string
  stopReason?: NodeStopReason
  errorClass?: AgentMultiErrorClass
  message?: string
  /** Terminal attempt count reported by the node-error that ended the node. */
  attempts?: number
  durationMs?: number
  /** Token accounting over the node's model calls, when any reported usage. */
  usage?: NodeUsagePayload
}

/** Human-interaction state of one run. */
export interface HitlView {
  readonly nodeId: string
  readonly question: string
  answer?: string
}

/** Run status as the client sees it. */
export type RunViewStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

/** The run's journal-derived state once its run-start has been applied. */
export interface RunState {
  readonly runId: string
  readonly workflowId: WorkflowId
  readonly workflowRevision: number
  readonly input: string
  status: RunViewStatus
  nodes: Record<string, NodeView>
  hitl?: HitlView
  pauseReason?: 'breakpoint' | 'hitl' | 'process-restart'
  totalDurationMs?: number
}

/** Projected state of the Session; `run` is absent until the first run-start. */
export interface AgentMultiProjectionState {
  readonly run?: RunState
  readonly failure?: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    agentMulti: AgentMultiProjectionState
  }
}

/** Wire view of a started run. */
export interface RunStartedView {
  readonly started: true
  readonly runId: string
  readonly workflowId: WorkflowId
  readonly status: RunViewStatus
  readonly nodes: readonly NodeView[]
  readonly hitl?: HitlView
  readonly totalDurationMs?: number
}

/** Wire view before any run event arrived on the Session. */
export interface RunIdleView {
  readonly started: false
}

/** Wire view of the run for the Web client's run panel and canvas. */
export type AgentMultiRunView = RunStartedView | RunIdleView

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Run kanban view of the agent-multi run owned by the projected Session. */
    agentMulti: AgentMultiRunView
  }
}

const nodeViewSchema = z.object({
  nodeId: z.string().min(1),
  nodeKind: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  attempt: nonNegativeSafeInteger,
  prompt: z.string().optional(),
  streaming: z.string().optional(),
  output: z.string().optional(),
  payload: z.string().optional(),
  stopReason: z.enum(['completed', 'aborted', 'error', 'max-tokens', 'refusal']).optional(),
  errorClass: z.enum(['transient', 'timeout', 'deterministic', 'auth']).optional(),
  message: z.string().optional(),
  attempts: nonNegativeSafeInteger.optional(),
  durationMs: nonNegativeSafeInteger.optional(),
  usage: z.object({
    inputTokens: nonNegativeSafeInteger,
    outputTokens: nonNegativeSafeInteger,
    cacheReadTokens: nonNegativeSafeInteger,
    cacheWriteTokens: nonNegativeSafeInteger,
  }).strict().optional(),
}).strict() as z.ZodType<NodeView>

const hitlViewSchema = z.object({
  nodeId: z.string().min(1),
  question: z.string(),
  answer: z.string().optional(),
}).strict() as z.ZodType<HitlView>

const runStateSchema = z.object({
  runId: runIdSchema,
  workflowId: z.string().min(1).transform(brandString<WorkflowId>),
  workflowRevision: nonNegativeSafeInteger,
  input: z.string(),
  status: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']),
  nodes: z.record(z.string(), nodeViewSchema),
  hitl: hitlViewSchema.optional(),
  pauseReason: z.enum(['breakpoint', 'hitl', 'process-restart']).optional(),
  totalDurationMs: nonNegativeSafeInteger.optional(),
}).strict() as unknown as z.ZodType<RunState>

const runProjectionStateSchema = z.object({
  run: runStateSchema.optional(),
  failure: z.string().optional(),
}).strict() as z.ZodType<AgentMultiProjectionState>

/** Every agent-multi journal event key. */
export type AgentMultiEventType =
  | 'agent-multi/run-start'
  | 'agent-multi/node-start'
  | 'agent-multi/node-input'
  | 'agent-multi/node-delta'
  | 'agent-multi/node-end'
  | 'agent-multi/node-error'
  | 'agent-multi/hitl-asked'
  | 'agent-multi/hitl-answered'
  | 'agent-multi/run-paused'
  | 'agent-multi/run-resumed'
  | 'agent-multi/run-end'
  | 'agent-multi/run-cancelled'

type AgentMultiSessionEvent = SessionEvent<AgentMultiEventType>

/**
 * Test whether a Session event belongs to the agent-multi domain.
 * @param event - candidate Session event.
 * @returns whether the event has an agent-multi-owned type.
 */
export function isAgentMultiEvent(event: SessionEvent): event is AgentMultiSessionEvent {
  return event.type.startsWith('agent-multi/')
}

/** Decode one persisted agent-multi payload, retaining the schema failure as cause. */
function parsePersisted<T>(type: string, schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value)
  } catch (error: unknown) {
    throw new Error(`persisted agent-multi ${type} payload is invalid`, { cause: error })
  }
}

const runStartSchema = z.object({
  version: z.literal(1),
  runId: runIdSchema,
  workflowId: z.string().min(1),
  workflowRevision: nonNegativeSafeInteger,
  input: z.string(),
}).strict()

const selectorSchema = z.object({
  version: nonNegativeSafeInteger,
  runId: runIdSchema,
}).loose()

const nodeStartSchema = z.object({
  version: z.literal(1), runId: runIdSchema, nodeId: z.string().min(1), nodeKind: z.string(), attempt: nonNegativeSafeInteger,
}).strict()
const nodeInputSchema = z.object({
  version: z.literal(1), runId: runIdSchema, nodeId: z.string().min(1), attempt: nonNegativeSafeInteger, prompt: z.string(),
}).strict()
const nodeDeltaSchema = z.object({
  version: z.literal(1), runId: runIdSchema, nodeId: z.string().min(1), attempt: nonNegativeSafeInteger, delta: z.string(),
}).strict()
const nodeEndSchema = z.object({
  version: z.literal(1), runId: runIdSchema, nodeId: z.string().min(1), attempt: nonNegativeSafeInteger,
  output: z.string(), payload: z.string(), stopReason: z.enum(['completed', 'aborted', 'error', 'max-tokens', 'refusal']),
  durationMs: nonNegativeSafeInteger,
  usage: z.object({
    inputTokens: nonNegativeSafeInteger,
    outputTokens: nonNegativeSafeInteger,
    cacheReadTokens: nonNegativeSafeInteger,
    cacheWriteTokens: nonNegativeSafeInteger,
  }).strict().optional(),
}).strict()
const nodeErrorSchema = z.object({
  version: z.literal(1), runId: runIdSchema, nodeId: z.string().min(1), attempt: nonNegativeSafeInteger,
  errorClass: z.enum(['transient', 'timeout', 'deterministic', 'auth']), message: z.string(), attempts: nonNegativeSafeInteger,
}).strict()
const hitlAskedSchema = z.object({
  version: z.literal(1), runId: runIdSchema, nodeId: z.string().min(1), question: z.string(),
}).strict()
const hitlAnsweredSchema = z.object({
  version: z.literal(1), runId: runIdSchema, nodeId: z.string().min(1), answer: z.string(),
}).strict()
const runPausedSchema = z.object({
  version: z.literal(1), runId: runIdSchema,
  reason: z.enum(['breakpoint', 'hitl', 'process-restart']), nodeId: z.string().min(1).optional(),
}).strict()
const runEndSchema = z.object({
  version: z.literal(1), runId: runIdSchema, outcome: z.enum(['completed', 'failed', 'cancelled']),
  totalDurationMs: nonNegativeSafeInteger,
}).strict()

function applyProjectionEvent(state: AgentMultiProjectionState, event: SessionEvent): AgentMultiProjectionState {
  if (state.failure !== undefined) return state
  if (!isAgentMultiEvent(event)) return state
  try {
    if (event.type === 'agent-multi/run-start') {
      const data = parsePersisted(event.type, runStartSchema, event.data)
      if (state.run === undefined) {
        return {
          run: {
            runId: data.runId, workflowId: brandString<WorkflowId>(data.workflowId),
            workflowRevision: data.workflowRevision,
            input: data.input, status: 'running', nodes: {},
          },
        }
      }
      // The same run replays run-start after a host restart; a different run on
      // one Session would corrupt the journal attribution.
      if (state.run.runId === data.runId) return state
      throw new Error(`run Session received a second run ${data.runId} after ${state.run.runId}`)
    }
    const payload = parsePersisted(event.type, selectorSchema, event.data)
    if (state.run === undefined) {
      throw new Error(`agent-multi ${event.type} arrived before run-start`)
    }
    if (payload.runId !== state.run.runId) return state
    if (payload.version !== 1) {
      throw new Error(`unsupported agent-multi event version ${String(payload.version)}`)
    }
    return { run: applyRunEvent(state.run, event) }
  } catch (error: unknown) {
    return { ...state, failure: error instanceof Error ? error.message : String(error) }
  }
}

function applyRunEvent(state: RunState, event: AgentMultiSessionEvent): RunState {
  switch (event.type) {
    case 'agent-multi/node-start': {
      const data = parsePersisted(event.type, nodeStartSchema, event.data)
      const prior = state.nodes[data.nodeId]
      if (prior !== undefined && prior.status === 'completed') {
        throw new Error(`node "${data.nodeId}" restarted after completion`)
      }
      const node: NodeView = {
        nodeId: data.nodeId, nodeKind: data.nodeKind as NodeKind, status: 'running', attempt: data.attempt,
        ...prior?.prompt === undefined ? {} : { prompt: prior.prompt },
      }
      return { ...state, nodes: { ...state.nodes, [data.nodeId]: node } }
    }
    case 'agent-multi/node-input': {
      const data = parsePersisted(event.type, nodeInputSchema, event.data)
      return patchNode(state, data.nodeId, node => ({ ...node, prompt: data.prompt }))
    }
    case 'agent-multi/node-delta': {
      const data = parsePersisted(event.type, nodeDeltaSchema, event.data)
      return patchNode(state, data.nodeId, node => {
        const accumulated = (node.streaming ?? '') + data.delta
        return { ...node, streaming: accumulated.length > MAX_STREAM_CHARS ? accumulated.slice(-MAX_STREAM_CHARS) : accumulated }
      })
    }
    case 'agent-multi/node-end': {
      const data = parsePersisted(event.type, nodeEndSchema, event.data)
      return patchNode(state, data.nodeId, node => ({
        ...node, status: 'completed', output: data.output, payload: data.payload,
        stopReason: data.stopReason, durationMs: data.durationMs,
        ...(data.usage !== undefined ? { usage: data.usage } : {}),
      }))
    }
    case 'agent-multi/node-error': {
      const data = parsePersisted(event.type, nodeErrorSchema, event.data)
      // A retryable failure is followed by a node-start of the next attempt,
      // which flips the node back to running; a terminal one is the last word.
      return patchNode(state, data.nodeId, node => ({
        ...node, status: 'failed', errorClass: data.errorClass, message: data.message, attempts: data.attempts,
      }))
    }
    case 'agent-multi/hitl-asked': {
      const data = parsePersisted(event.type, hitlAskedSchema, event.data)
      if (state.hitl !== undefined && state.hitl.nodeId !== data.nodeId) {
        throw new Error(`node "${data.nodeId}" asked while node "${state.hitl.nodeId}" question is open`)
      }
      return { ...state, hitl: { nodeId: data.nodeId, question: data.question } }
    }
    case 'agent-multi/hitl-answered': {
      const data = parsePersisted(event.type, hitlAnsweredSchema, event.data)
      if (state.hitl === undefined || state.hitl.nodeId !== data.nodeId) {
        throw new Error(`hitl answer for node "${data.nodeId}" has no open question`)
      }
      return { ...state, hitl: { ...state.hitl, answer: data.answer } }
    }
    case 'agent-multi/run-paused': {
      const data = parsePersisted(event.type, runPausedSchema, event.data)
      return { ...state, status: 'paused', pauseReason: data.reason }
    }
    case 'agent-multi/run-resumed': {
      const { pauseReason: _drop, ...rest } = state
      return { ...rest, status: 'running' }
    }
    case 'agent-multi/run-end': {
      const data = parsePersisted(event.type, runEndSchema, event.data)
      return { ...state, status: data.outcome, totalDurationMs: data.totalDurationMs }
    }
    case 'agent-multi/run-cancelled': {
      return { ...state, status: 'cancelled' }
    }
    /* v8 ignore next 2 -- AgentMultiEventType is closed and every member is handled above. */
    default:
      return state
  }
}

/** Replace one node entry; a node event before node-start is a journal order violation. */
function patchNode(
  state: RunState,
  nodeId: string,
  patch: (node: NodeView) => NodeView,
): RunState {
  const prior = state.nodes[nodeId]
  if (prior === undefined) throw new Error(`agent-multi node event for "${nodeId}" arrived before node-start`)
  return { ...state, nodes: { ...state.nodes, [nodeId]: patch(prior) } }
}

const runStartedViewSchema = z.object({
  started: z.literal(true),
  runId: z.string().min(1),
  workflowId: z.string().min(1).transform(brandString<WorkflowId>),
  status: z.enum(['running', 'paused', 'completed', 'failed', 'cancelled']),
  nodes: z.array(nodeViewSchema),
  hitl: hitlViewSchema.optional(),
  totalDurationMs: nonNegativeSafeInteger.optional(),
}).strict() as unknown as z.ZodType<RunStartedView>

const runViewSchema = z.union([runStartedViewSchema, z.object({ started: z.literal(false) }).strict()]) as unknown as z.ZodType<AgentMultiRunView>

/** Client views memoized on the state reference they were derived from. */
const runViews = new WeakMap<AgentMultiProjectionState, AgentMultiRunView>()

function buildRunView(state: AgentMultiProjectionState): AgentMultiRunView {
  const run = state.run
  if (run === undefined) return { started: false }
  return {
    started: true,
    runId: run.runId,
    workflowId: run.workflowId,
    status: run.status,
    nodes: Object.values(run.nodes),
    ...run.hitl === undefined ? {} : { hitl: run.hitl },
    ...run.totalDurationMs === undefined ? {} : { totalDurationMs: run.totalDurationMs },
  }
}

/**
 * Wire view of the projected run. The same state reference reuses the same
 * view reference, so unchanged state publishes nothing; a projection failure
 * also keeps the last derived view.
 * @param state - current projection state.
 * @returns the run kanban view.
 */
function runView(state: AgentMultiProjectionState): AgentMultiRunView {
  const prior = runViews.get(state)
  if (prior !== undefined) return prior
  const view = buildRunView(state)
  runViews.set(state, view)
  return view
}

/** Empty state before the run Session's first agent-multi event. */
const EMPTY_STATE: AgentMultiProjectionState = Object.freeze({}) as AgentMultiProjectionState

/** agent-multi run projection; the run Session owns exactly one run. */
export const agentMultiProjectionDefinition = {
  key: 'agentMulti',
  stateVersion: 1,
  stateSchema: runProjectionStateSchema,
  init: () => EMPTY_STATE,
  apply: applyProjectionEvent,
  wire: { viewSchema: runViewSchema, view: runView },
} satisfies ProjectionDefinition<'agentMulti', AgentMultiProjectionState>
