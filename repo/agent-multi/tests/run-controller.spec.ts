/**
 * Controller-level run tests: start / cancel / resume / get over the remote
 * service, with storage-backed workflow definitions driving mock-LLM engine
 * runs through real spawn subagents.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import AgentMultiController from '../src/index.ts'
import type { WorkflowDraft } from '../src/types.ts'

const contexts: Context[] = []
const roots: string[] = []

interface Harness {
  ctx: Context
  controller: AgentMultiController
  adapter: MockAdapter
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  const adapter = new MockAdapter(script)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-multi-runs-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  const pool = new MemoryMediaPool()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => {
    await backend.close()
  })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => {
      await facility.closeAll()
      unmount()
    }
  })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(UserQuestionService)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentMultiController, {
    runRootProvider: 'mock', runRootModel: 'mock', maxActive: 4,
  })
  return { ctx, controller: ctx.agentMultiController, adapter }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const linearDraft: WorkflowDraft = {
  name: 'controller-linear',
  nodes: [
    { kind: 'input', id: 'in', name: 'in' },
    {
      kind: 'agent', id: 'A', name: 'A', systemPrompt: 'You are A.', provider: 'mock', model: 'mock',
      retry: { maxAttempts: 1, backoffMs: 0 }, hitlEnabled: false,
    },
    {
      kind: 'agent', id: 'B', name: 'B', systemPrompt: 'You are B.', provider: 'mock', model: 'mock',
      retry: { maxAttempts: 1, backoffMs: 0 }, hitlEnabled: false,
    },
    { kind: 'output', id: 'out', name: 'out' },
  ],
  edges: [
    { id: 'in-A', from: 'in', to: 'A', format: 'text', inContext: true },
    { id: 'A-B', from: 'A', to: 'B', format: 'text', inContext: true },
    { id: 'B-out', from: 'B', to: 'out', format: 'text', inContext: true },
  ],
}

/** Poll `get-run` until the run leaves the running state. */
async function settle(controller: AgentMultiController, runId: string): Promise<Exclude<
  Awaited<ReturnType<AgentMultiController['getRun']>>,
  { outcome: 'missing' }
>['run']> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const result = await controller.getRun({ runId })
    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') throw new Error('run vanished')
    if (result.run.status !== 'running') return result.run
    if (Date.now() > deadline) throw new Error(`run ${runId} did not settle in time`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('agent-multi controller runs', () => {
  it('starts a run and reports the completed view', async () => {
    const { controller } = await setup([textResponse('alpha'), textResponse('beta')])
    const created = await controller.createWorkflow({ draft: linearDraft })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return

    const started = await controller.startRun({ workflowId: created.definition.id, input: 'hello' })
    expect(started.outcome).toBe('started')
    if (started.outcome !== 'started') return

    const run = await settle(controller, started.runId)
    expect(run.status).toBe('completed')
    expect(run.output).toBe('beta')
    expect(run.workflowId).toBe(created.definition.id)
    const types = run.events.map(event => event.type)
    expect(types).toContain('agent-multi/run-start')
    expect(types).toContain('agent-multi/node-end')
    expect(types).toContain('agent-multi/run-end')
    // The projection feeds the kanban: per-node states with settled output.
    const nodeA = run.nodes.find(node => node.nodeId === 'A')
    const nodeB = run.nodes.find(node => node.nodeId === 'B')
    expect(nodeA).toMatchObject({ nodeKind: 'agent', status: 'completed', attempt: 1, output: 'alpha' })
    expect(nodeB).toMatchObject({ nodeKind: 'agent', status: 'completed', attempt: 1, output: 'beta' })
    expect(run.hitl).toBeUndefined()
  })

  it('rejects starting an unknown workflow', async () => {
    const { controller } = await setup([])
    const started = await controller.startRun({ workflowId: 'nope' as never, input: 'x' })
    expect(started.outcome).toBe('missing')
  })

  it('cancels a hanging run', async () => {
    const { controller } = await setup([textResponse('alpha'), 'hang'])
    const created = await controller.createWorkflow({ draft: linearDraft })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return

    const started = await controller.startRun({ workflowId: created.definition.id, input: 'hello' })
    expect(started.outcome).toBe('started')
    if (started.outcome !== 'started') return

    const cancelled = await controller.cancelRun({ runId: started.runId })
    expect(cancelled.outcome).toBe('cancelled')
    if (cancelled.outcome !== 'cancelled') return
    expect(cancelled.status).toBe('cancelled')

    const run = await controller.getRun({ runId: started.runId })
    expect(run.outcome).toBe('found')
    if (run.outcome !== 'found') return
    expect(run.run.status).toBe('cancelled')
  })

  it('resumes a failed run to completion on the same identity', async () => {
    // Attempt 1: node A fails deterministically (max-tokens, no retry).
    // Resume: the adapter script continues with successful responses.
    const { controller } = await setup([maxTokensResponse('truncated'), textResponse('alpha'), textResponse('beta')])
    const created = await controller.createWorkflow({ draft: linearDraft })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return

    const started = await controller.startRun({ workflowId: created.definition.id, input: 'hello' })
    expect(started.outcome).toBe('started')
    if (started.outcome !== 'started') return

    const failed = await settle(controller, started.runId)
    expect(failed.status).toBe('failed')
    expect(failed.failure?.nodeId).toBe('A')
    expect(failed.failure?.errorClass).toBe('deterministic')

    const resumed = await controller.resumeRun({ runId: started.runId })
    expect(resumed.outcome).toBe('started')
    if (resumed.outcome !== 'started') return
    expect(resumed.runId).toBe(started.runId)

    const run = await settle(controller, started.runId)
    expect(run.status).toBe('completed')
    expect(run.output).toBe('beta')
    const types = run.events.map(event => event.type)
    expect(types).toContain('agent-multi/run-resumed')
    // The failed attempt and the resumed success share one journal.
    expect(types.filter(type => type === 'agent-multi/run-end')).toHaveLength(2)
  })

  it('lists run history filtered by workflow', async () => {
    const { controller } = await setup([textResponse('alpha'), textResponse('beta')])
    const created = await controller.createWorkflow({ draft: linearDraft })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return
    const workflowId = created.definition.id

    const empty = await controller.listRuns({ workflowId })
    expect(empty.runs).toHaveLength(0)

    const started = await controller.startRun({ workflowId, input: 'hello' })
    expect(started.outcome).toBe('started')
    if (started.outcome !== 'started') return
    await settle(controller, started.runId)

    const listed = await controller.listRuns({ workflowId })
    expect(listed.runs).toHaveLength(1)
    expect(listed.runs[0]).toMatchObject({ runId: started.runId, workflowId, status: 'completed' })
    expect(listed.runs[0]?.failure).toBeUndefined()

    // A second run lands newest-first in the unfiltered list.
    const second = await controller.startRun({ workflowId, input: 'again' })
    expect(second.outcome).toBe('started')
    if (second.outcome !== 'started') return
    const all = await controller.listRuns({})
    expect(all.runs.map(run => run.runId)).toStrictEqual([second.runId, started.runId])
  })

  it('dry-runs a single agent node in isolation', async () => {
    const { controller } = await setup([textResponse('solo-output')])
    const result = await controller.dryRunNode({
      node: {
        kind: 'agent', id: 'A', name: 'A', systemPrompt: 'You are A.', provider: 'mock', model: 'mock',
        retry: { maxAttempts: 1, backoffMs: 0 }, hitlEnabled: false,
      },
      input: 'hello',
    })
    expect(result.outcome).toBe('completed')
    if (result.outcome === 'completed') {
      expect(result.output).toBe('solo-output')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    }
    // The dry-run root must not appear in run history.
    const runs = await controller.listRuns({})
    expect(runs.runs).toHaveLength(0)
  })

  it('dry-runs a node to its terminal failure', async () => {
    const { controller } = await setup([maxTokensResponse('too long')])
    const result = await controller.dryRunNode({
      node: {
        kind: 'agent', id: 'A', name: 'A', systemPrompt: 'You are A.', provider: 'mock', model: 'mock',
        retry: { maxAttempts: 2, backoffMs: 0 }, hitlEnabled: false,
      },
      input: 'hello',
    })
    expect(result.outcome).toBe('failed')
    if (result.outcome === 'failed') {
      expect(result.errorClass).toBe('deterministic')
      expect(result.attempts).toBe(1)
    }
  })

  it('aborts the run through the token fuse when the budget is exceeded', async () => {
    // textResponse('alpha') reports inputTokens 10 + outputTokens len('alpha'):
    // node A alone consumes 15 billed tokens; budget 1 trips after node A.
    const { controller } = await setup([textResponse('alpha'), textResponse('beta')])
    const created = await controller.createWorkflow({ draft: linearDraft })
    if (created.outcome !== 'created') return
    const started = await controller.startRun({ workflowId: created.definition.id, input: 'hello', tokenBudget: 1 })
    if (started.outcome !== 'started') return
    const run = await settle(controller, started.runId)
    expect(run.status).toBe('failed')
    expect(run.failure).toMatchObject({ errorClass: 'deterministic' })
    expect(run.failure?.message).toContain('token budget exceeded')
    // Node A finished and journaled before the fuse tripped; node B never ran.
    const nodeA = run.nodes.find(node => node.nodeId === 'A')
    expect(nodeA).toMatchObject({ status: 'completed', output: 'alpha' })
    const nodeB = run.nodes.find(node => node.nodeId === 'B')
    expect(nodeB).toBeUndefined()
  })

  it('completes a budgeted run under the limit', async () => {
    const { controller } = await setup([textResponse('alpha'), textResponse('beta')])
    const created = await controller.createWorkflow({ draft: linearDraft })
    if (created.outcome !== 'created') return
    const started = await controller.startRun({ workflowId: created.definition.id, input: 'hello', tokenBudget: 1_000_000 })
    if (started.outcome !== 'started') return
    const run = await settle(controller, started.runId)
    expect(run.status).toBe('completed')
    expect(run.output).toBe('beta')
  })

  it('reports missing for unknown runs', async () => {
    const { controller } = await setup([])
    expect((await controller.getRun({ runId: 'nope' })).outcome).toBe('missing')
    expect((await controller.cancelRun({ runId: 'nope' })).outcome).toBe('missing')
    expect((await controller.resumeRun({ runId: 'nope' })).outcome).toBe('missing')
  })
})

describe('agent-multi controller triggers', () => {
  /** Poll `list-triggers` until one trigger has fired (lastRunId set). */
  async function waitFired(controller: AgentMultiController, id: string, timeoutMs = 5_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const { triggers } = await controller.listTriggers({})
      const trigger = triggers.find(entry => entry.id === id)
      if (trigger?.lastRunId !== undefined) return trigger.lastRunId
      if (Date.now() > deadline) return undefined
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  it('creates, lists, disables, and deletes a trigger without firing it', async () => {
    const { controller } = await setup([])
    const created = await controller.createWorkflow({ draft: linearDraft })
    if (created.outcome !== 'created') return
    const workflowId = created.definition.id

    // A daily time in the far future: the trigger never becomes due here.
    const trigger = await controller.createTrigger({
      workflowId,
      timing: { kind: 'daily', time: '23:59:59', timeZone: 'UTC' },
      input: 'scheduled',
    })
    expect(trigger.outcome).toBe('created')
    if (trigger.outcome !== 'created') return
    expect(trigger.trigger.enabled).toBe(true)
    expect(Date.parse(trigger.trigger.scheduledAt)).toBeGreaterThan(Date.now())

    const listed = await controller.listTriggers({ workflowId })
    expect(listed.triggers).toHaveLength(1)
    expect(listed.triggers[0]?.id).toBe(trigger.trigger.id)

    const disabled = await controller.setTriggerEnabled({ id: trigger.trigger.id, enabled: false })
    expect(disabled.outcome).toBe('saved')
    if (disabled.outcome === 'saved') expect(disabled.trigger.enabled).toBe(false)

    const deleted = await controller.deleteTrigger({ id: trigger.trigger.id })
    expect(deleted.outcome).toBe('deleted')
    expect((await controller.listTriggers({ workflowId })).triggers).toHaveLength(0)
    expect((await controller.deleteTrigger({ id: trigger.trigger.id })).outcome).toBe('missing')
  })

  it('rejects a trigger for an unknown workflow and an unsatisfiable timing', async () => {
    const { controller } = await setup([])
    const missing = await controller.createTrigger({
      workflowId: 'nope' as never,
      timing: { kind: 'daily', time: '12:00:00', timeZone: 'UTC' },
      input: 'x',
    })
    expect(missing.outcome).toBe('missing')

    const created = await controller.createWorkflow({ draft: linearDraft })
    if (created.outcome !== 'created') return
    const invalid = await controller.createTrigger({
      workflowId: created.definition.id,
      timing: { kind: 'cron', expression: 'not a cron', timeZone: 'UTC' },
      input: 'x',
    })
    expect(invalid.outcome).toBe('invalid')
  })

  it('fires a due trigger and re-arms its committed target', async () => {
    const { controller } = await setup([textResponse('alpha'), textResponse('beta')])
    const created = await controller.createWorkflow({ draft: linearDraft })
    if (created.outcome !== 'created') return
    const workflowId = created.definition.id

    // A daily time a few seconds ahead: the runtime timer fires it for real.
    const soon = new Date(Date.now() + 5_000).toISOString().slice(11, 19)
    const trigger = await controller.createTrigger({
      workflowId,
      timing: { kind: 'daily', time: soon, timeZone: 'UTC' },
      input: 'fired',
    })
    expect(trigger.outcome).toBe('created')
    if (trigger.outcome !== 'created') return
    expect(Date.parse(trigger.trigger.scheduledAt)).toBeGreaterThan(Date.now())

    const runId = await waitFired(controller, trigger.trigger.id, 15_000)
    expect(runId).toBeDefined()
    if (runId === undefined) return
    const run = await settle(controller, runId)
    expect(run.status).toBe('completed')
    expect(run.output).toBe('beta')

    // After the fire the committed target moved strictly into the future.
    const after = (await controller.listTriggers({ workflowId })).triggers
      .find(entry => entry.id === trigger.trigger.id)
    expect(after).toBeDefined()
    if (after !== undefined) {
      expect(after.lastRunId).toBe(runId)
      expect(Date.parse(after.scheduledAt)).toBeGreaterThan(Date.now())
    }
  }, 30_000)
})
