/**
 * Phase 0 spike probes for the experimental agent-multi plugin.
 *
 * S1 — subagent activation request surface: verify `toolFilter` scopes child
 *      tools (deny removes a tool from the prompt and refuses execution) and
 *      `agentOptions` overrides the child model. Confirms the per-node config
 *      fields the plan relies on (R2 tool scope; agent model/provider) flow
 *      through the production {@link SubagentStartRequest}.
 *
 * S2 — typert host-side remote surface: a {@link TypertRemoteService}
 *      subclass with @Remote methods is discoverable by remoteMethods();
 *      the controller's namespace registration and ping method are covered
 *      in workflow-store.spec.ts through a storage-mounted harness (the
 *      controller now owns a storage domain, so bare construction no longer
 *      applies). The client-face codegen that produces ctx.remote.agentMulti
 *      is a later build spike.
 *
 * S3 — HITL brokerage precondition: verify a run root (a live runtime root
 *      in `agents.roots()`) passes `UserQuestionService` assertLiveRoot and can
 *      therefore broker human interaction, while an owned child agent is
 *      rejected with DELEGATED_CALLER (children cannot self-HITL).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations, startTestActivation as start } from '../../../subagent/subagent/tests/local-activation.ts'

/** One model turn in the scripted mock conversation. */
type ScriptTurn = ReturnType<typeof textResponse>

/** Shared runtime carrying the agent-loop, subagent, and user-question services. */
async function setup(script: ReadonlyArray<ScriptTurn | 'hang'>): Promise<{ ctx: Context, root: Agent, adapter: MockAdapter }> {
  const ctx = new Context()
  const adapter = new MockAdapter([...script])
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(UserQuestionService)
  ctx.llm.registerAdapter(['mock'], adapter)
  const root = await ctx.agentLoop.create(SessionId('multi-root'), { provider: 'mock', model: 'mock' })
  return { ctx, root, adapter }
}

/** Extract the concatenated text from a content-block list. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text).join('')
}

describe('agent-multi Phase 0 spike — S2 typert host surface', () => {
  it('a TypertRemoteService subclass with @Remote methods is discoverable (protocol parity)', () => {
    // Parity check mirroring typert/protocol/tests/protocol.spec.ts: an ad-hoc
    // subclass constructed with `new` exposes its @Remote methods immediately.
    class Probe extends TypertRemoteService {
      constructor(ctx: Context) { super(ctx, 'probeService', { namespace: 'probe' }) }
      @Remote('echo') echo(value: string): string { return value }
      @Remote({ mode: 'stream' }) *watch(): Generator<string> { yield 'value' }
    }
    const ctx = new Context()
    const probe = new Probe(ctx)

    expect(probe.typertRemote.namespace).toBe('probe')
    expect(remoteMethods(probe)).toEqual([
      { method: 'echo', invocation: { kind: 'direct' } },
      { method: 'watch', mode: 'stream', invocation: { kind: 'direct' } },
    ])
  })
})

describe('agent-multi Phase 0 spike — S1 subagent request surface', () => {
  it('toolFilter.deny removes a tool from the child prompt and refuses execution', async () => {
    const { ctx, root, adapter } = await setup([
      toolCallResponse('c1', 'forbidden_tool', {}),
      textResponse('done'),
    ])
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'forbidden_tool',
      description: 'a global tool the child must not see',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'ran' }]),
    })))

    const run = await start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'Call forbidden_tool.' }],
      parent: root,
      toolFilter: { deny: ['forbidden_tool'] },
    })
    const result = await run.result

    expect(result.stopReason).toBe('completed')
    // The denied tool never reached the child's model request.
    const childRequest = adapter.requests[0]!
    expect(childRequest.tools ?? []).not.toContainEqual(expect.objectContaining({ name: 'forbidden_tool' }))
    // The child attempted the call regardless; the runtime refused it.
    const toolResult = run.localAgent.session.snapshotEvents()
      .find(event => event.type === 'tool/result')
    expect(JSON.stringify(toolResult?.data)).toContain('unknown tool')

    await run.dispose()
  })

  it('agentOptions overrides the child model and provider', async () => {
    const { ctx, root, adapter } = await setup([textResponse('hello')])

    const run = await start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'Say hello.' }],
      parent: root,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const result = await run.result

    expect(result.stopReason).toBe('completed')
    expect(textOf(result.output)).toContain('hello')
    expect(adapter.requests).toHaveLength(1)

    await run.dispose()
  })
})

describe('agent-multi Phase 0 spike — S3 HITL brokerage precondition', () => {
  it('the run root is a live runtime root (assertLiveRoot precondition)', async () => {
    const { ctx, root } = await setup([textResponse('ok')])

    expect(ctx.agents.roots()).toContain(root)
  })

  it('a run root can broker human interaction (ask with agent resolves)', async () => {
    const { ctx, root } = await setup([textResponse('ok')])
    const seen: unknown[] = []
    ctx.on('user-questions/request', request => {
      seen.push(request)
      return Promise.resolve({
        answers: request.questions.map(question => ({ id: question.id, selected: ['approved'] })),
      })
    })

    const result = await ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: root,
    })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['approved'] }] })
    expect(seen).toHaveLength(1)
  })

  it('an owned child agent cannot self-HITL (DELEGATED_CALLER)', async () => {
    // A 'hang' entry keeps the child activation live (streaming, not settled)
    // so assertLiveRoot's first check — agents.get(child.id) === child — passes
    // and the second check — child is not a root — fires DELEGATED_CALLER.
    // Awaiting run.result first would tear the child down and yield CALLER_NOT_LIVE.
    const { ctx, root } = await setup(['hang'])
    const run = await start(ctx, 'spawn', {
      prompt: [{ type: 'text', text: 'ok' }],
      parent: root,
    })
    const child = run.localAgent

    // The child is live and owned (not a root).
    expect(ctx.agents.get(child.id)).toBe(child)
    expect(ctx.agents.roots()).not.toContain(child)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: child,
    })).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'DELEGATED_CALLER',
    })

    await run.dispose()
  })
})
