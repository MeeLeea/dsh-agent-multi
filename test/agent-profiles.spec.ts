/**
 * Tests for the `.agents.json` agent attribute profiles: file parsing
 * (comment keys, null normalization, malformed entries), the file-backed
 * reader (default overlay, per-name override, hot reload, missing files),
 * and end-to-end executor integration (route attributes reach the model
 * call; the maxTurns watchdog fails the node deterministically).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, textResponse, toolCallResponse } from './helpers/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from './helpers/working-directory-fixture.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { executeRun } from '../src/host/engine/run.ts'
import { createAgentProfileReader, parseAgentProfilesFile } from '../src/host/engine/profile.ts'
import type { WorkflowDefinition, WorkflowDraft, WorkflowId } from '../src/host/types.ts'

/** Silent logger stand-in; assertions read back the captured warnings. */
function warningSink(): { logger: { warn(message: string): void }, warnings: string[] } {
  const warnings: string[] = []
  return { logger: { warn: (message: string) => warnings.push(message) }, warnings }
}

describe('parseAgentProfilesFile', () => {
  it('normalizes null entries to unset properties', () => {
    const file = parseAgentProfilesFile('{ "default": { "maxTokens": null, "provider": "p" } }')
    expect(file.default).toEqual({ provider: 'p' })
  })

  it('strips underscore comment keys from entries', () => {
    const file = parseAgentProfilesFile(JSON.stringify({
      default: { _doc: 'docs', maxTokens: 5 },
      agents: { A: { _note: 'note', provider: 'q' } },
    }))
    expect(file.default).toEqual({ maxTokens: 5 })
    expect(file.agents.A).toEqual({ provider: 'q' })
  })

  it('falls back to empty profiles on broken JSON with a warning', () => {
    const { logger, warnings } = warningSink()
    const file = parseAgentProfilesFile('{ not json', logger)
    expect(file).toEqual({ default: {}, agents: {} })
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('.agents.json')
  })

  it('skips one invalid agent entry but keeps the rest', () => {
    const { logger, warnings } = warningSink()
    const file = parseAgentProfilesFile(JSON.stringify({
      default: { maxTokens: 3 },
      agents: {
        Good: { provider: 'p' },
        Bad: { maxTokens: 'lots' },
      },
    }), logger)
    expect(file.agents.Good).toEqual({ provider: 'p' })
    expect(file.agents.Bad).toEqual({})
    expect(warnings.join('\n')).toContain('agents."Bad"')
  })

  it('warns and ignores a non-object agents block', () => {
    const { logger, warnings } = warningSink()
    const file = parseAgentProfilesFile('{ "default": {}, "agents": [] }', logger)
    expect(file.agents).toEqual({})
    expect(warnings.join('\n')).toContain('agents')
  })
})

describe('createAgentProfileReader', () => {
  const roots: string[] = []

  function tempFile(initial: string): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-multi-profile-'))
    roots.push(root)
    const path = join(root, '.agents.json')
    writeFileSync(path, initial, 'utf8')
    return path
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('overlays the per-agent entry on default and hot-reloads on change', async () => {
    const path = tempFile(JSON.stringify({
      default: { maxTokens: 10, provider: 'def' },
      agents: { A: { provider: 'a' } },
    }))
    const reader = createAgentProfileReader({ path })
    // A overrides provider but inherits default's maxTokens.
    expect(await reader.resolve('A')).toEqual({ maxTokens: 10, provider: 'a' })
    // Unknown agents get default verbatim.
    expect(await reader.resolve('B')).toEqual({ maxTokens: 10, provider: 'def' })

    // Editing the file changes the answer for the next created agent.
    writeFileSync(path, JSON.stringify({
      default: { maxTokens: 10 },
      agents: { A: { maxTurns: 4 } },
    }), 'utf8')
    expect(await reader.resolve('A')).toEqual({ maxTokens: 10, maxTurns: 4 })
  })

  it('treats a missing file as an empty profile', async () => {
    const reader = createAgentProfileReader({ path: join(tmpdir(), 'dsh-multi-profile-none', '.agents.json') })
    expect(await reader.resolve('A')).toEqual({})
  })
})

/** Executor integration harness mirroring engine.spec.ts's setup. */
describe('agent profiles in executeRun', () => {
  const contexts: Context[] = []
  const roots: string[] = []

  interface Harness {
    ctx: Context
    runRoot: Agent
    adapter: MockAdapter
    profilesPath: string
  }

  async function setup(script: ConstructorParameters<typeof MockAdapter>[0]): Promise<Harness> {
    const ctx = new Context()
    contexts.push(ctx)
    const adapter = new MockAdapter(script)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-multi-profile-engine-'))
    roots.push(storageRoot)
    const profilesRoot = mkdtempSync(join(tmpdir(), 'dsh-multi-profile-file-'))
    roots.push(profilesRoot)
    const profilesPath = join(profilesRoot, '.agents.json')
    writeFileSync(profilesPath, '{}', 'utf8')
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(UserQuestionService)
    ctx.llm.registerAdapter(['mock'], adapter)
    const runRoot = await ctx.agentLoop.create(SessionId('multi-root'), { provider: 'mock', model: 'mock' })
    return { ctx, runRoot, adapter, profilesPath }
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

  const agent = (id: string): AgentFixture => ({
    kind: 'agent', id, name: id, systemPrompt: `You are ${id}.`, provider: 'mock', model: 'mock',
    retry: { maxAttempts: 1, backoffMs: 0 }, hitlEnabled: false,
  })

  function definition(draft: WorkflowDraft): WorkflowDefinition {
    return { version: 1, id: brandString<WorkflowId>('wf-profile'), name: draft.name, revision: 1, nodes: draft.nodes, edges: draft.edges }
  }

  /** Single-node workflow fixture with a profiles reader over a temp file. */
  async function runSingle(harness: Harness, name: string, file: object): Promise<Awaited<ReturnType<typeof executeRun>>> {
    writeFileSync(harness.profilesPath, JSON.stringify(file), 'utf8')
    const profiles = createAgentProfileReader({ path: harness.profilesPath })
    return executeRun({
      ctx: harness.ctx, runRoot: harness.runRoot, profiles,
      definition: definition({
        name: 'profiled',
        nodes: [
          { kind: 'input', id: 'in', name: 'in' },
          agent(name),
          { kind: 'output', id: 'out', name: 'out' },
        ],
        edges: [
          { id: 'in-node', from: 'in', to: name, format: 'text', inContext: true },
          { id: 'node-out', from: name, to: 'out', format: 'text', inContext: true },
        ],
      }),
      userInput: 'go', signal: new AbortController().signal,
    })
  }

  it('applies maxTokens from the per-agent profile to the model call', async () => {
    const harness = await setup([textResponse('ok')])
    const result = await runSingle(harness, 'A', { default: {}, agents: { A: { maxTokens: 4242 } } })
    expect(result.outcome).toBe('completed')
    expect(harness.adapter.requests[0]!.maxTokens).toBe(4242)
  })

  it('applies the default profile to agents without their own entry', async () => {
    const harness = await setup([textResponse('ok')])
    const result = await runSingle(harness, 'A', { default: { maxTokens: 99 }, agents: {} })
    expect(result.outcome).toBe('completed')
    expect(harness.adapter.requests[0]!.maxTokens).toBe(99)
  })

  it('routes the child to the profile provider', async () => {
    const harness = await setup([textResponse('ok')])
    const result = await runSingle(harness, 'A', { default: {}, agents: { A: { provider: 'mock' } } })
    // The mock adapter serves the 'mock' route; the request records the
    // provider the activation resolved to.
    expect(result.outcome).toBe('completed')
    expect(harness.adapter.requests[0]!.provider).toBe('mock')
  })

  it('applies the reasoning effort from the profile when the model supports it', async () => {
    const reasoning = { efforts: [{ id: 'high', name: 'High' }] }
    const harness = await setup([textResponse('ok')])
    const adapter = new MockAdapter([textResponse('ok')], reasoning)
    harness.ctx.llm.registerAdapter(['reasoned'], adapter as unknown as MockAdapter)
    const result = await runSingle(harness, 'A', {
      default: {}, agents: { A: { provider: 'reasoned', reasoningEffort: 'high' } },
    })
    expect(result.outcome).toBe('completed')
    expect(adapter.requests[0]!.reasoningEffort).toBe('high')
  })

  it('fails the node deterministically when the turn budget is exceeded', async () => {
    // Tool call -> text: the agent needs two model calls; the budget is 1.
    const harness = await setup([
      toolCallResponse('c1', 'agent-multi-ask-user', { question: 'Proceed?' }),
      textResponse('never reached'),
    ])
    const result = await runSingle(harness, 'A', { default: {}, agents: { A: { maxTurns: 1 } } })
    expect(result.outcome).toBe('failed')
    expect(result.failure).toMatchObject({ nodeId: 'A', errorClass: 'deterministic' })
    expect(result.failure?.message).toContain('maxTurns')
    // The second model call was stopped before it started.
    expect(harness.adapter.requests.length).toBe(1)
  })

  it('completes when the turn budget is not exceeded', async () => {
    const harness = await setup([textResponse('ok'), textResponse('ok2')])
    const result = await runSingle(harness, 'A', { default: { maxTurns: 2 }, agents: {} })
    expect(result.outcome).toBe('completed')
    expect(harness.adapter.requests.length).toBe(1)
  })
})
