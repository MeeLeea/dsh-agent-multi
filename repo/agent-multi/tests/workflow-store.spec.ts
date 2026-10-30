/**
 * Workflow store behavior over the storage domain: CRUD round-trips,
 * structural rejections surfaced as schema-invalid, optimistic-concurrency
 * conflicts, delete semantics, restart durability through a shared media
 * pool, and the remote-method registration the Phase 0 spike asserted on a
 * bare controller.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { cleanupHarnessRoots, mountStorage } from './helpers/mount-storage.ts'
import type { WorkflowDraft, WorkflowId } from '../src/types.ts'

const contexts: Context[] = []

/** Fresh context registered for afterEach teardown. */
function track(ctx: Context): void {
  contexts.push(ctx)
}

/** Minimal runnable draft: input → agent → output. */
function baseDraft(): WorkflowDraft {
  return {
    name: 'demo',
    nodes: [
      { kind: 'input', id: 'in', name: 'Input' },
      {
        kind: 'agent', id: 'a1', name: 'A1', systemPrompt: 'you are A1',
        retry: { maxAttempts: 2, backoffMs: 10 }, hitlEnabled: false,
      },
      { kind: 'output', id: 'out', name: 'Out' },
    ],
    edges: [
      { id: 'e1', from: 'in', to: 'a1', format: 'text', inContext: true },
      { id: 'e2', from: 'a1', to: 'out', format: 'text', inContext: true },
    ],
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  cleanupHarnessRoots()
})

describe('agent-multi workflow store', () => {
  it('registers the agentMulti namespace and discovers remote methods', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    expect(controller.typertRemote.namespace).toBe('agentMulti')
    expect(controller.typertRemote.serviceKey).toBe('agentMultiController')
    const methods = remoteMethods(controller).map(method => method.method)
    expect(methods).toContain('ping')
    expect(methods).toContain('createWorkflow')
    expect(methods).toContain('saveWorkflow')
    expect(methods).toContain('listWorkflows')
    expect(methods).toContain('getWorkflow')
    expect(methods).toContain('deleteWorkflow')
    expect(methods).toContain('validateWorkflow')
  })

  it('creates, gets, and lists a workflow', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    const created = await controller.createWorkflow({ draft: baseDraft() })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return
    expect(created.definition.revision).toBe(1)
    expect(created.definition.nodes).toHaveLength(3)

    const found = await controller.getWorkflow({ id: created.definition.id })
    expect(found.outcome).toBe('found')
    if (found.outcome !== 'found') return
    expect(found.definition.name).toBe('demo')
    expect(found.createdAt).toBe(found.updatedAt)

    const listed = await controller.listWorkflows()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual({ id: created.definition.id, name: 'demo', revision: 1, updatedAt: found.updatedAt })
  })

  it('rejects structurally invalid and semantically invalid drafts', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    const structural: WorkflowDraft = {
      name: 'demo',
      nodes: [
        { kind: 'input', id: 'in', name: 'Input' },
        {
          kind: 'agent', id: 'a1', name: 'A1', systemPrompt: 'you are A1',
          retry: { maxAttempts: 0, backoffMs: 10 }, hitlEnabled: false,
        },
        { kind: 'output', id: 'out', name: 'Out' },
      ],
      edges: baseDraft().edges,
    }
    const structuralResult = await controller.createWorkflow({ draft: structural })
    expect(structuralResult.outcome).toBe('invalid')
    if (structuralResult.outcome !== 'invalid' || structuralResult.errors.length === 0) return
    expect(structuralResult.errors[0]?.code).toBe('schema-invalid')

    const semantic: WorkflowDraft = {
      ...baseDraft(),
      edges: [
        ...baseDraft().edges,
        { id: 'e3', from: 'ghost', to: 'a1', format: 'text', inContext: true },
      ],
    }
    const semanticResult = await controller.validateWorkflow({ draft: semantic })
    expect(semanticResult.errors.map(error => error.code)).toContain('edge-endpoint-unknown')
  })

  it('saves with a revision bump and reports stale saves as conflicts', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    const created = await controller.createWorkflow({ draft: baseDraft() })
    if (created.outcome !== 'created') throw new Error('create failed')
    const id = created.definition.id

    const saved = await controller.saveWorkflow({ id, draft: { ...baseDraft(), name: 'demo v2' }, expectedRevision: 1 })
    expect(saved.outcome).toBe('saved')
    if (saved.outcome !== 'saved') return
    expect(saved.definition.revision).toBe(2)
    expect(saved.definition.name).toBe('demo v2')

    const stale = await controller.saveWorkflow({ id, draft: baseDraft(), expectedRevision: 1 })
    expect(stale.outcome).toBe('conflict')
    if (stale.outcome !== 'conflict') return
    expect(stale.current.revision).toBe(2)
  })

  it('reports missing on save, get, and delete of unknown ids', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    const id = brandString<WorkflowId>('nope')
    expect((await controller.saveWorkflow({ id, draft: baseDraft(), expectedRevision: 1 })).outcome).toBe('missing')
    expect((await controller.getWorkflow({ id })).outcome).toBe('missing')
    expect((await controller.deleteWorkflow({ id })).outcome).toBe('missing')
  })

  it('deletes an existing workflow', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    const created = await controller.createWorkflow({ draft: baseDraft() })
    if (created.outcome !== 'created') throw new Error('create failed')
    expect((await controller.deleteWorkflow({ id: created.definition.id })).outcome).toBe('deleted')
    expect((await controller.getWorkflow({ id: created.definition.id })).outcome).toBe('missing')
  })

  it('persists workflows across a simulated process restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await mountStorage(pool)
    const created = await first.controller.createWorkflow({ draft: baseDraft() })
    if (created.outcome !== 'created') throw new Error('create failed')
    await first.ctx.fiber.dispose()

    const second = await mountStorage(pool)
    track(second.ctx)
    const found = await second.controller.getWorkflow({ id: created.definition.id })
    expect(found.outcome).toBe('found')
    if (found.outcome !== 'found') return
    expect(found.definition.name).toBe('demo')
    expect(found.definition.revision).toBe(1)
  })

  it('exports a workflow and re-imports it with a fresh identity', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    const created = await controller.createWorkflow({ draft: baseDraft() })
    if (created.outcome !== 'created') throw new Error('create failed')

    const exported = await controller.exportWorkflow({ id: created.definition.id })
    expect(exported.outcome).toBe('found')
    if (exported.outcome !== 'found' || exported.document === undefined) return
    expect(exported.document.kind).toBe('dsh-agent-multi-workflow')

    const imported = await controller.importWorkflow({ document: exported.document })
    expect(imported.outcome).toBe('created')
    if (imported.outcome !== 'created') return
    expect(imported.definition.id).not.toBe(created.definition.id)
    expect(imported.definition.revision).toBe(1)
    expect(imported.definition.nodes).toHaveLength(3)
    expect(await controller.listWorkflows()).toHaveLength(2)
  })

  it('importing with keepId fails on collision and validates content', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    const created = await controller.createWorkflow({ draft: baseDraft() })
    if (created.outcome !== 'created') throw new Error('create failed')
    const exported = await controller.exportWorkflow({ id: created.definition.id })
    if (exported.outcome !== 'found' || exported.document === undefined) return

    const collision = await controller.importWorkflow({ document: exported.document, keepId: true })
    expect(collision.outcome).toBe('invalid')
    if (collision.outcome !== 'invalid' || collision.errors.length === 0) return
    expect(collision.errors[0]?.code).toBe('duplicate-id')

    const malformed = await controller.importWorkflow({
      document: { kind: 'dsh-agent-multi-workflow', version: 2 as unknown as 1, definition: exported.document.definition },
    })
    expect(malformed.outcome).toBe('invalid')

    const structurallyBad = await controller.importWorkflow({
      document: {
        kind: 'dsh-agent-multi-workflow',
        version: 1,
        definition: { ...exported.document.definition, nodes: [{ kind: 'input', id: 'in', name: 'Input' }] },
      },
    })
    expect(structurallyBad.outcome).toBe('invalid')
    if (structurallyBad.outcome !== 'invalid') return
    expect(structurallyBad.errors.map(error => error.code)).toContain('edge-endpoint-unknown')
  })
})

describe('agent-multi library agents', () => {
  /** A reusable agent payload matching the agent-node schema minus identity. */
  function agentSpec(): { kind: 'agent', systemPrompt: string, retry: { maxAttempts: number, backoffMs: number }, hitlEnabled: boolean } {
    return { kind: 'agent', systemPrompt: 'you are reusable', retry: { maxAttempts: 3, backoffMs: 20 }, hitlEnabled: false }
  }

  it('creates, lists, saves, and deletes a library agent', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    const created = await controller.createLibraryAgent({ name: 'writer', spec: agentSpec() })
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return
    expect(created.agent.name).toBe('writer')
    expect(created.agent.spec.systemPrompt).toBe('you are reusable')
    expect(created.agent.spec.retry.maxAttempts).toBe(3)

    const listed = await controller.listLibraryAgents()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: 'writer' })

    const saved = await controller.saveLibraryAgent({
      id: created.agent.id, name: 'editor', spec: { ...agentSpec(), systemPrompt: 'you edit' },
    })
    expect(saved.outcome).toBe('saved')
    if (saved.outcome !== 'saved') return
    expect(saved.agent.name).toBe('editor')
    expect(saved.agent.spec.systemPrompt).toBe('you edit')

    const deleted = await controller.deleteLibraryAgent({ id: created.agent.id })
    expect(deleted.outcome).toBe('deleted')
    expect(await controller.listLibraryAgents()).toHaveLength(0)
    expect((await controller.deleteLibraryAgent({ id: created.agent.id })).outcome).toBe('missing')
    expect((await controller.saveLibraryAgent({ id: created.agent.id, name: 'x', spec: agentSpec() })).outcome).toBe('missing')
  })

  it('rejects invalid library specs structurally', async () => {
    const { ctx, controller } = await mountStorage(new MemoryMediaPool())
    track(ctx)
    const invalid = await controller.createLibraryAgent({
      name: 'bad', spec: { kind: 'agent', systemPrompt: 'x', retry: { maxAttempts: 0, backoffMs: 10 }, hitlEnabled: false } as never,
    })
    expect(invalid.outcome).toBe('invalid')
    if (invalid.outcome !== 'invalid' || invalid.errors.length === 0) return
    expect(invalid.errors[0]?.code).toBe('schema-invalid')

    const router = await controller.createLibraryAgent({
      name: 'not-agent', spec: { kind: 'router', cases: ['a'] } as never,
    })
    expect(router.outcome).toBe('invalid')
  })

  it('persists library agents across a simulated process restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await mountStorage(pool)
    const created = await first.controller.createLibraryAgent({ name: 'writer', spec: agentSpec() })
    if (created.outcome !== 'created') throw new Error('create failed')
    await first.ctx.fiber.dispose()

    const second = await mountStorage(pool)
    track(second.ctx)
    const listed = await second.controller.listLibraryAgents()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: created.agent.id, name: 'writer' })
  })
})
