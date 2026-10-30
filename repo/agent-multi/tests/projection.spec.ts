/**
 * Projection fold tests: every agent-multi journal event type, order
 * violations, foreign-run selectors, unsupported versions, and the wire view.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionEventMap, type SessionEventType } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { agentMultiProjectionDefinition, type AgentMultiProjectionState } from '../src/projection.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RunId } from '../src/engine/events.ts'
import type { WorkflowId } from '../src/types.ts'

/** Widened reference: the literal export narrows `init` to its zero-arg form. */
const projection: ProjectionDefinition<'agentMulti', AgentMultiProjectionState> = agentMultiProjectionDefinition

const WORKFLOW = brandString<WorkflowId>('wf-1')

const RUN = brandString<RunId>('run-1')
const OTHER = brandString<RunId>('run-2')

function event<T extends Extract<SessionEventType, `agent-multi/${string}`>>(type: T, data: SessionEventMap[T], seq: number): SessionEvent<T> {
  return { type, data, seq, time: seq } as unknown as SessionEvent<T>
}

function project(events: readonly SessionEvent[]): AgentMultiProjectionState {
  let state = projection.init(
    { version: SESSION_FORMAT_VERSION, id: SessionId('run-root'), createdAt: 0, isSeeded: false },
    SessionLogOffset(0),
  ) as AgentMultiProjectionState
  for (const e of events) state = projection.apply(state, e)
  return state
}

const runStart = (runId: RunId = RUN) => event('agent-multi/run-start', {
  version: 1, runId, workflowId: WORKFLOW, workflowRevision: 3, input: 'do the thing',
}, 1)

const nodeStart = (nodeId = 'a', attempt = 1, seq = 2) => event('agent-multi/node-start', {
  version: 1, runId: RUN, nodeId, nodeKind: 'agent', attempt,
}, SessionSeq(seq))

describe('agent-multi projection', () => {
  it('folds a complete successful run', () => {
    const state = project([
      runStart(),
      nodeStart(),
      event('agent-multi/node-input', { version: 1, runId: RUN, nodeId: 'a', attempt: 1, prompt: 'prompt a' }, 3),
      event('agent-multi/node-delta', { version: 1, runId: RUN, nodeId: 'a', attempt: 1, delta: 'partial ' }, 4),
      event('agent-multi/node-delta', { version: 1, runId: RUN, nodeId: 'a', attempt: 1, delta: 'output' }, 5),
      event('agent-multi/node-end', { version: 1, runId: RUN, nodeId: 'a', attempt: 1, output: 'partial output', payload: 'partial output', stopReason: 'completed', durationMs: 42 }, 6),
      event('agent-multi/run-end', { version: 1, runId: RUN, outcome: 'completed', totalDurationMs: 100 }, 7),
    ])
    expect(state.failure).toBeUndefined()
    expect(state.run?.status).toBe('completed')
    expect(state.run?.nodes['a']).toMatchObject({
      status: 'completed', attempt: 1, output: 'partial output', stopReason: 'completed', durationMs: 42,
    })
    expect(state.run?.totalDurationMs).toBe(100)
  })

  it('reports idle view before run-start and started view after', () => {
    expect(agentMultiProjectionDefinition.wire?.view(project([]))).toEqual({ started: false })
    const view = agentMultiProjectionDefinition.wire?.view(project([runStart(), nodeStart()]))
    expect(view).toMatchObject({ started: true, runId: RUN, status: 'running', nodes: [{ nodeId: 'a', status: 'running' }] })
  })

  it('reuses the same view reference for unchanged state', () => {
    const state = project([runStart()])
    const first = agentMultiProjectionDefinition.wire?.view(state)
    const second = agentMultiProjectionDefinition.wire?.view(state)
    expect(first).toBe(second)
  })

  it('folds retry attempts back to running after a retryable node error', () => {
    const state = project([
      runStart(),
      nodeStart(),
      event('agent-multi/node-error', { version: 1, runId: RUN, nodeId: 'a', attempt: 1, errorClass: 'transient', message: 'flaky', attempts: 1 }, 3),
      nodeStart('a', 2, 4),
      event('agent-multi/node-end', { version: 1, runId: RUN, nodeId: 'a', attempt: 2, output: 'ok', payload: 'ok', stopReason: 'completed', durationMs: 9 }, 5),
    ])
    expect(state.run?.nodes['a']).toMatchObject({ status: 'completed', attempt: 2, output: 'ok' })
  })

  it('keeps terminal node failure with errorClass and attempts', () => {
    const state = project([
      runStart(),
      nodeStart(),
      event('agent-multi/node-error', { version: 1, runId: RUN, nodeId: 'a', attempt: 2, errorClass: 'deterministic', message: 'bug', attempts: 2 }, 3),
    ])
    expect(state.run?.nodes['a']).toMatchObject({ status: 'failed', errorClass: 'deterministic', message: 'bug', attempts: 2 })
  })

  it('folds HITL asked/answered and run pause/resume', () => {
    const state = project([
      runStart(),
      nodeStart(),
      event('agent-multi/hitl-asked', { version: 1, runId: RUN, nodeId: 'a', question: 'continue?' }, 3),
      event('agent-multi/run-paused', { version: 1, runId: RUN, reason: 'hitl', nodeId: 'a' }, 4),
      event('agent-multi/hitl-answered', { version: 1, runId: RUN, nodeId: 'a', answer: 'yes' }, 5),
      event('agent-multi/run-resumed', { version: 1, runId: RUN, mode: 'resume' }, 6),
    ])
    expect(state.run?.hitl).toMatchObject({ nodeId: 'a', question: 'continue?', answer: 'yes' })
    expect(state.run?.status).toBe('running')
    expect(state.run?.pauseReason).toBeUndefined()
  })

  it('folds cancellation', () => {
    const state = project([
      runStart(),
      nodeStart(),
      event('agent-multi/run-cancelled', { version: 1, runId: RUN }, 3),
    ])
    expect(state.run?.status).toBe('cancelled')
  })

  it('ignores events for a different run and foreign event types', () => {
    const foreign = { type: 'assistant/message', data: {}, seq: 3, time: 3 } as unknown as SessionEvent
    const state = project([
      runStart(),
      event('agent-multi/node-start', { version: 1, runId: OTHER, nodeId: 'x', nodeKind: 'agent', attempt: 1 }, 2),
      foreign,
    ])
    expect(state.run?.nodes['x']).toBeUndefined()
    expect(state.failure).toBeUndefined()
  })

  it('caps accumulated streaming preview at the window limit', () => {
    const chunk = 'x'.repeat(15_000)
    const state = project([
      runStart(),
      nodeStart(),
      event('agent-multi/node-delta', { version: 1, runId: RUN, nodeId: 'a', attempt: 1, delta: chunk }, 3),
      event('agent-multi/node-delta', { version: 1, runId: RUN, nodeId: 'a', attempt: 1, delta: chunk }, 4),
    ])
    expect(state.run?.nodes['a']?.streaming?.length).toBeLessThanOrEqual(20_000)
  })

  it('captures a node event before node-start as a terminal failure', () => {
    const state = project([
      runStart(),
      event('agent-multi/node-end', { version: 1, runId: RUN, nodeId: 'ghost', attempt: 1, output: 'o', payload: 'o', stopReason: 'completed', durationMs: 1 }, 2),
    ])
    expect(state.failure).toContain('ghost')
    // Later events retain the failed state.
    const after = agentMultiProjectionDefinition.apply(state, nodeStart('ghost', 1, 3))
    expect(after).toBe(state)
  })

  it('captures any run event before run-start as a failure', () => {
    const state = project([nodeStart()])
    expect(state.failure).toContain('before run-start')
  })

  it('rejects a second different run on one session', () => {
    const state = project([runStart(), runStart(OTHER)])
    expect(state.failure).toContain('second run')
  })

  it('rejects an unsupported event version', () => {
    const state = project([
      runStart(),
      event('agent-multi/node-start', { version: 2, runId: RUN, nodeId: 'a', nodeKind: 'agent', attempt: 1 } as unknown as SessionEventMap['agent-multi/node-start'], 2),
    ])
    expect(state.failure).toContain('unsupported agent-multi event version')
  })

  it('rejects a node restart after completion', () => {
    const state = project([
      runStart(),
      nodeStart(),
      event('agent-multi/node-end', { version: 1, runId: RUN, nodeId: 'a', attempt: 1, output: 'o', payload: 'o', stopReason: 'completed', durationMs: 1 }, 3),
      nodeStart('a', 2, 4),
    ])
    expect(state.failure).toContain('restarted after completion')
  })

  it('rejects a hitl answer without an open question', () => {
    const state = project([
      runStart(),
      event('agent-multi/hitl-answered', { version: 1, runId: RUN, nodeId: 'a', answer: 'yes' }, 2),
    ])
    expect(state.failure).toContain('no open question')
  })

  it('rejects a second concurrent hitl question on another node', () => {
    const state = project([
      runStart(),
      nodeStart('a', 1, 2),
      nodeStart('b', 1, 3),
      event('agent-multi/hitl-asked', { version: 1, runId: RUN, nodeId: 'a', question: 'q1' }, 4),
      event('agent-multi/hitl-asked', { version: 1, runId: RUN, nodeId: 'b', question: 'q2' }, 5),
    ])
    expect(state.failure).toContain('while node')
  })

  it('validates a persisted payload strictly', () => {
    const state = project([
      runStart(),
      event('agent-multi/node-start', { version: 1, runId: RUN, nodeKind: 'agent', attempt: 1 } as unknown as SessionEventMap['agent-multi/node-start'], 2),
    ])
    expect(state.failure).toContain('payload is invalid')
  })
})
