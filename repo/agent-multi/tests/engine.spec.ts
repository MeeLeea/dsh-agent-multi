/**
 * Integration tests for the agent-multi run engine: executeRun drives real
 * spawn subagents under a mock LLM adapter, journals to the run session, and
 * exercises failure, retry, resume, and cancellation paths.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { executeRun } from '../src/engine/run.ts'
import type { WorkflowDefinition, WorkflowDraft, WorkflowId } from '../src/types.ts'

const contexts: Context[] = []
const roots: string[] = []

interface Harness {
  ctx: Context
  runRoot: Agent
  adapter: MockAdapter
  /** Questions the mounted answerer received, in order. */
  asked: string[]
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  const adapter = new MockAdapter(script)
  const asked: string[] = []
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-multi-engine-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(UserQuestionService)
  ctx.on('user-questions/request', request => {
    for (const question of request.questions) asked.push(question.question)
    return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected: ['yes'] })) })
  })
  ctx.llm.registerAdapter(['mock'], adapter)
  const runRoot = await ctx.agentLoop.create(SessionId('multi-root'), { provider: 'mock', model: 'mock' })
  return { ctx, runRoot, adapter, asked }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface AgentFixture {
  kind: 'agent'
  id: string
  name: string
  systemPrompt: string
  provider: string
  model: string
  retry: { maxAttempts: number; backoffMs: number }
  hitlEnabled: boolean
}

/** Edge fixture: optional handles are present only when set (exactOptionalPropertyTypes). */
interface EdgeFixture {
  id: string
  from: string
  to: string
  format: 'text' | 'json' | 'md'
  inContext: boolean
  fromHandle?: string
  toHandle?: 'back'
}

const agent = (id: string, retry: AgentFixture['retry'] = { maxAttempts: 1, backoffMs: 0 }): AgentFixture => ({
  kind: 'agent', id, name: id, systemPrompt: `You are ${id}.`, provider: 'mock', model: 'mock', retry, hitlEnabled: false,
})

const edge = (from: string, to: string, fromHandle?: string, toHandle?: 'back'): EdgeFixture => {
  const resolved: EdgeFixture = { id: `${from}-${to}${fromHandle === undefined ? '' : `-${fromHandle}`}`, from, to, format: 'text', inContext: true }
  if (fromHandle !== undefined) resolved.fromHandle = fromHandle
  if (toHandle !== undefined) resolved.toHandle = toHandle
  return resolved
}

function definition(draft: WorkflowDraft): WorkflowDefinition {
  return { version: 1, id: brandString<WorkflowId>('wf-engine'), name: draft.name, revision: 1, nodes: draft.nodes, edges: draft.edges }
}

const linearDraft = (retryA: AgentFixture['retry'], retryB: AgentFixture['retry']): WorkflowDraft => ({
  name: 'linear',
  nodes: [
    { kind: 'input', id: 'in', name: 'in' },
    agent('A', retryA),
    agent('B', retryB),
    { kind: 'output', id: 'out', name: 'out' },
  ],
  edges: [edge('in', 'A'), edge('A', 'B'), edge('B', 'out')],
})

const eventTypes = (runRoot: Agent): string[] =>
  runRoot.session.snapshotEvents().map(event => event.type).filter(type => type.startsWith('agent-multi/'))

describe('executeRun', () => {
  it('completes a linear run and journals the lifecycle', async () => {
    const { ctx, runRoot, adapter } = await setup([textResponse('alpha'), textResponse('beta')])
    const result = await executeRun({
      ctx, runRoot, definition: definition(linearDraft({ maxAttempts: 1, backoffMs: 0 }, { maxAttempts: 1, backoffMs: 0 })),
      userInput: 'go', signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('completed')
    expect(result.output).toBe('beta')
    // B's prompt carries A's output as predecessor context.
    expect(adapter.requests.length).toBe(2)
    const promptB = adapter.requests[1]!.messages.map(message =>
      message.content.map(block => block.type === 'text' ? block.text : '').join(''),
    ).join('')
    expect(promptB).toContain('alpha')
    expect(eventTypes(runRoot)).toEqual([
      'agent-multi/run-start',
      'agent-multi/node-start', 'agent-multi/node-input', 'agent-multi/node-delta', 'agent-multi/node-end',
      'agent-multi/node-start', 'agent-multi/node-input', 'agent-multi/node-delta', 'agent-multi/node-end',
      'agent-multi/run-end',
    ])
  })

  it('pauses at a breakpoint on deterministic failure', async () => {
    const { ctx, runRoot } = await setup([textResponse('alpha'), maxTokensResponse('truncated')])
    const result = await executeRun({
      ctx, runRoot, definition: definition(linearDraft({ maxAttempts: 1, backoffMs: 0 }, { maxAttempts: 3, backoffMs: 0 })),
      userInput: 'go', signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('failed')
    expect(result.failure).toMatchObject({ nodeId: 'B', errorClass: 'deterministic', attempts: 1 })
    const types = eventTypes(runRoot)
    expect(types).toContain('agent-multi/node-error')
    expect(types).toContain('agent-multi/run-paused')
    expect(types[types.length - 1]).toBe('agent-multi/run-end')
  })

  it('resumes from the journal and skips completed nodes', async () => {
    const { ctx, runRoot, adapter } = await setup([
      textResponse('alpha'),
      maxTokensResponse('truncated'),
      textResponse('beta-fixed'),
    ])
    const def = definition(linearDraft({ maxAttempts: 1, backoffMs: 0 }, { maxAttempts: 3, backoffMs: 0 }))
    const first = await executeRun({
      ctx, runRoot, definition: def, userInput: 'go', signal: new AbortController().signal,
    })
    expect(first.outcome).toBe('failed')
    const second = await executeRun({
      ctx, runRoot, definition: def, userInput: 'go', signal: new AbortController().signal, resume: true,
    })
    expect(second.outcome).toBe('completed')
    expect(second.output).toBe('beta-fixed')
    // A ran once (first run); the resume only re-ran B.
    expect(adapter.requests.length).toBe(3)
    const types = eventTypes(runRoot)
    expect(types.filter(type => type === 'agent-multi/run-resumed').length).toBe(1)
    expect(types.filter(type => type === 'agent-multi/node-start').length).toBe(3)
  })

  it('retries a transient failure with feedback and completes', async () => {
    const { ctx, runRoot, adapter } = await setup([
      (): never => { throw new Error('LLM exploded') },
      textResponse('recovered'),
    ])
    const result = await executeRun({
      ctx, runRoot,
      definition: definition({
        name: 'retry',
        nodes: [
          { kind: 'input', id: 'in', name: 'in' },
          agent('A', { maxAttempts: 2, backoffMs: 0 }),
          { kind: 'output', id: 'out', name: 'out' },
        ],
        edges: [edge('in', 'A'), edge('A', 'out')],
      }),
      userInput: 'go', signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('completed')
    expect(result.output).toBe('recovered')
    expect(adapter.requests.length).toBe(2)
    const retryPrompt = adapter.requests[1]!.messages.map(message =>
      message.content.map(block => block.type === 'text' ? block.text : '').join(''),
    ).join('')
    expect(retryPrompt).toContain('Retry feedback')
    expect(eventTypes(runRoot)).toContain('agent-multi/node-error')
  })

  it('relays a HITL question through the run root and journals the answer', async () => {
    const { ctx, runRoot, adapter, asked } = await setup([
      toolCallResponse('c1', 'agent-multi-ask-user', { question: 'Proceed?' }),
      textResponse('final: yes'),
    ])
    const hitlNode: AgentFixture = { ...agent('A'), hitlEnabled: true }
    const result = await executeRun({
      ctx, runRoot,
      definition: definition({
        name: 'hitl',
        nodes: [
          { kind: 'input', id: 'in', name: 'in' },
          hitlNode,
          { kind: 'output', id: 'out', name: 'out' },
        ],
        edges: [edge('in', 'A'), edge('A', 'out')],
      }),
      userInput: 'go', signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('completed')
    expect(result.output).toBe('final: yes')
    // The ask-user tool was visible to the hitl-enabled node.
    expect(adapter.requests[0]!.tools?.map(tool => tool.name)).toContain('agent-multi-ask-user')
    expect(asked).toEqual(['Proceed?'])
    const events = runRoot.session.snapshotEvents().filter(event => event.type.startsWith('agent-multi/'))
    const askedEvent = events.find(event => event.type === 'agent-multi/hitl-asked')
    expect(askedEvent?.data).toMatchObject({ nodeId: 'A', question: 'Proceed?' })
    const answeredEvent = events.find(event => event.type === 'agent-multi/hitl-answered')
    expect(answeredEvent?.data).toMatchObject({ nodeId: 'A', answer: 'yes' })
  })

  it('denies the ask-user tool to nodes without hitlEnabled', async () => {
    const { ctx, runRoot, adapter } = await setup([textResponse('alpha')])
    const result = await executeRun({
      ctx, runRoot,
      definition: definition({
        name: 'no-hitl',
        nodes: [
          { kind: 'input', id: 'in', name: 'in' },
          agent('A'),
          { kind: 'output', id: 'out', name: 'out' },
        ],
        edges: [edge('in', 'A'), edge('A', 'out')],
      }),
      userInput: 'go', signal: new AbortController().signal,
    })
    expect(result.outcome).toBe('completed')
    expect(adapter.requests[0]!.tools?.map(tool => tool.name) ?? []).not.toContain('agent-multi-ask-user')
  })

  it('cancels an in-flight run via the abort signal', async () => {
    const { ctx, runRoot } = await setup(['hang'])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const result = await executeRun({
      ctx, runRoot,
      definition: definition({
        name: 'cancel',
        nodes: [
          { kind: 'input', id: 'in', name: 'in' },
          agent('A'),
          { kind: 'output', id: 'out', name: 'out' },
        ],
        edges: [edge('in', 'A'), edge('A', 'out')],
      }),
      userInput: 'go', signal: controller.signal,
    })
    expect(result.outcome).toBe('cancelled')
    const types = eventTypes(runRoot)
    expect(types).toContain('agent-multi/run-cancelled')
    expect(types[types.length - 1]).toBe('agent-multi/run-end')
  })
})
