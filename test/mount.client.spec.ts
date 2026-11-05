/** The Remote namespace, workflow panel, and sidebar row follow client plugin disposal. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, vi } from 'vitest'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { AgentMultiIcon } from '../src/client/AgentMultiIcon.tsx'
import { NodeMessageView } from '../src/client/NodeMessageView.tsx'
import { WorkflowPage } from '../src/client/WorkflowPage.tsx'
import { zh } from '../src/client/locales.ts'
import { inject, mount } from '../src/client/mount.ts'

// The npm primitives bundle imports monorepo-hoisted third-party packages
// (simple-icons, shiki, markdown utils) that it does not declare; this spec
// never renders, so stub every used export with a no-op component.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => {
  const stub = () => null
  return {
    Button: stub,
    IconBranchOutlineRegular: stub,
    IconChevronLeftOutlineRegular: stub,
    IconPlayOutlineRegular: stub,
    IconPlusOutlineRegular: stub,
    IconRefreshOutlineRegular: stub,
    IconStopFillRegular: stub,
    IconTrashOutlineRegular: stub,
  }
})

const REMOTE: TypertRemoteContribution = {
  package: 'dsh-agent-multi',
  descriptors: [],
}

const METHOD_NAMES = [
  'createWorkflow', 'saveWorkflow', 'listWorkflows', 'getWorkflow', 'deleteWorkflow',
  'validateWorkflow', 'startRun', 'resumeRun', 'cancelRun', 'getRun', 'listModelCatalog',
  'dryRunNode',
] as const

type Dict = Record<string, string>

/**
 * Minimal locale service: register() stores dictionaries, bind() resolves
 * keys from the zh dictionary (the fixture locale). The npm client bundles are
 * loader-wrapped (window.__ModuleLoader__), so the real LocaleRuntime cannot
 * be imported in a plain Node test.
 */
class FakeLocale extends Service {
  private readonly dicts = new Map<string, { zh: Dict }>()

  constructor(ctx: Context) {
    super(ctx, 'locale')
  }

  register(ns: string, dict: { zh: Dict }): () => void {
    this.dicts.set(ns, dict)
    return () => { this.dicts.delete(ns) }
  }

  bind(ns: string): (key: string) => string {
    return key => this.dicts.get(ns)?.zh[key] ?? key
  }
}

interface FakeEntry {
  options: Record<string, unknown> & { name: string }
  component: unknown
  locale?: unknown
  inject?: () => unknown
}

/**
 * Minimal slot registry: register() stores entries keyed by slot name,
 * inject() runs the callback as an effect on the caller's context (the same
 * `this.ctx.effect` pattern the real SlotRegistry uses), entries() reads back.
 */
class FakeSlots extends Service {
  private readonly store = new Map<string, FakeEntry[]>()

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  inject(_name: string, callback: () => () => void): () => void {
    return this.ctx.effect(callback, 'fake slots.inject')
  }

  register(options: FakeEntry['options'], component: unknown): () => void {
    const entry: FakeEntry = { options, component, locale: options.locale, inject: options.inject as (() => unknown) | undefined }
    const list = this.store.get(options.name) ?? []
    list.push(entry)
    this.store.set(options.name, list)
    return () => {
      const index = list.indexOf(entry)
      if (index >= 0) list.splice(index, 1)
    }
  }

  entries(name: string): readonly FakeEntry[] {
    return this.store.get(name) ?? []
  }
}

/** Browser-service fixture: Remote carrier, mocked namespace, locale, slots. */
async function fixture(lists?: { workspaces?: unknown, sessions?: unknown }) {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  // Workspace/session snapshots default to the pre-ready phase: the action
  // binding leaves run requests workspace-less until the real lists arrive.
  class FakeWorkspaces extends Service {
    constructor() { super(ctx, 'workspaces') }
    readonly list = { getSnapshot: () => lists?.workspaces ?? { phase: 'pending', items: [] } }
  }
  class FakeSessions extends Service {
    constructor() { super(ctx, 'sessions') }
    readonly list = { getSnapshot: () => lists?.sessions ?? { phase: 'pending', ids: [], byId: {} } }
  }
  /**
   * Minimal conversation event registry: register() records definitions so
   * the mount can contribute the node-message mirror Definition; disposal
   * removes them again.
   */
  class FakeUiConversation extends Service {
    private readonly defs = new Map<string, unknown>()

    constructor() { super(ctx, 'uiConversation') }

    readonly events = {
      register: (definition: { kind: string }): (() => void) => {
        this.defs.set(definition.kind, definition)
        return () => { this.defs.delete(definition.kind) }
      },
    }

    has(kind: string): boolean {
      return this.defs.has(kind)
    }
  }
  new Remote()
  new FakeLocale(ctx)
  new FakeSlots(ctx)
  new FakeWorkspaces(ctx)
  new FakeSessions(ctx)
  const conversation = new FakeUiConversation(ctx)
  const methods = Object.fromEntries(METHOD_NAMES.map(name => [name, vi.fn(async () => ({ ok: true, value: undefined }))]))
  ctx.provide('remote.agentMulti', methods)
  return { ctx, unmount, methods, conversation }
}

function slotsOf(ctx: Context): FakeSlots {
  return (ctx as unknown as { slots: FakeSlots }).slots
}

it('registers the localized panel, sidebar row, and remote action face', async () => {
  const b = await fixture()
  const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mount(ctx, REMOTE) })
  await fiber
  try {
    const slots = slotsOf(b.ctx)
    const panel = slots.entries('main').find(item => item.component === WorkflowPage)
    expect(panel?.options).toMatchObject({ key: 'agent-multi' })
    expect(panel?.locale).toBe('agent-multi')
    const actions = panel!.inject!() as Record<string, unknown>
    for (const name of METHOD_NAMES) assert(typeof actions[name] === 'function', name)
    await (actions.listWorkflows as () => Promise<unknown>)()
    expect(b.methods.listWorkflows).toHaveBeenCalledOnce()
    const row = slots.entries('sidebar.panellist').find(item => item.component === AgentMultiIcon)
    expect(row?.options).toMatchObject({ id: 'agent-multi' })
    expect(row?.locale).toBe('agent-multi')
    expect(resolveSlotLabel(row?.options.label as () => string)).toBe(zh.panel)
    const t = (b.ctx as unknown as { locale: FakeLocale }).locale.bind('agent-multi')
    expect(t('panel')).toBe(zh.panel)
    expect(t('create')).toBe(zh.create)
  } finally {
    await fiber.dispose()
    await b.ctx.fiber.dispose()
  }
})

it('stamps startRun and dryRunNode with the most recently active workspace', async () => {
  const b = await fixture({
    workspaces: {
      phase: 'ready',
      items: [
        { workspaceId: 'w-old', path: 'D:/w-old', sessionIds: ['s-old'], createdAt: '2026-01-01T00:00:00Z' },
        { workspaceId: 'w-recent', path: 'D:/w-recent', sessionIds: ['s-recent'], createdAt: '2026-01-02T00:00:00Z' },
        { workspaceId: 'w-empty', path: 'D:/w-empty', sessionIds: [], createdAt: '2026-01-03T00:00:00Z' },
      ],
    },
    sessions: {
      phase: 'ready',
      ids: ['s-old', 's-recent'],
      byId: {
        's-old': { updatedAt: Date.parse('2026-02-01T00:00:00Z') },
        's-recent': { updatedAt: Date.parse('2026-03-01T00:00:00Z') },
      },
    },
  })
  const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mount(ctx, REMOTE) })
  await fiber
  try {
    await b.methods.startRun.mockClear()
    await b.methods.dryRunNode.mockClear()
    const slots = slotsOf(b.ctx)
    const panel = slots.entries('main').find(item => item.component === WorkflowPage)
    const actions = panel!.inject!() as Record<string, (request: unknown) => Promise<unknown>>
    await actions.startRun({ workflowId: 'wf', input: 'hi' })
    expect(b.methods.startRun).toHaveBeenCalledWith({ workflowId: 'wf', input: 'hi', workspaceId: 'w-recent' })
    await actions.dryRunNode({ node: { id: 'n' }, input: 'hi' })
    expect(b.methods.dryRunNode).toHaveBeenCalledWith({ node: { id: 'n' }, input: 'hi', workspaceId: 'w-recent' })
  } finally {
    await fiber.dispose()
    await b.ctx.fiber.dispose()
  }
})

it('keeps an explicit workspace choice and exposes the workspace list handle', async () => {
  const b = await fixture({
    workspaces: {
      phase: 'ready',
      items: [
        { workspaceId: 'w-old', path: 'D:/w-old', sessionIds: [], createdAt: '2026-01-01T00:00:00Z' },
        { workspaceId: 'w-recent', path: 'D:/w-recent', sessionIds: [], createdAt: '2026-01-02T00:00:00Z' },
      ],
    },
    sessions: { phase: 'ready', ids: [], byId: {} },
  })
  const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mount(ctx, REMOTE) })
  await fiber
  try {
    await b.methods.startRun.mockClear()
    const slots = slotsOf(b.ctx)
    const panel = slots.entries('main').find(item => item.component === WorkflowPage)
    const actions = panel!.inject!() as Record<string, (request: unknown) => Promise<unknown>> & {
      workspaces: { getSnapshot: () => { items: readonly { workspaceId: string }[] } }
      defaultWorkspaceId: () => string | undefined
    }
    // An explicit workspaceId picked in the UI survives the auto-stamp.
    await actions.startRun({ workflowId: 'wf', input: 'hi', workspaceId: 'w-old' })
    expect(b.methods.startRun).toHaveBeenCalledWith({ workflowId: 'wf', input: 'hi', workspaceId: 'w-old' })
    // The list handle mirrors the source snapshot and auto resolves the
    // most recently active workspace, so the run launcher can preview it.
    expect(actions.workspaces.getSnapshot().items).toHaveLength(2)
    expect(actions.defaultWorkspaceId()).toBe('w-recent')
  } finally {
    await fiber.dispose()
    await b.ctx.fiber.dispose()
  }
})

it('withdraws the remote contribution and every slot entry on disposal', async () => {
  const b = await fixture()
  const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mount(ctx, REMOTE) })
  await fiber
  const slots = slotsOf(b.ctx)
  expect(slots.entries('main').some(item => item.component === WorkflowPage)).toBe(true)
  expect(slots.entries('sidebar.panellist').some(item => item.component === AgentMultiIcon)).toBe(true)
  expect(slots.entries('conversation.chat.node').some(item => item.component === NodeMessageView)).toBe(true)
  expect(b.conversation.has('agent-multi-node')).toBe(true)
  await fiber.dispose()
  expect(slots.entries('main').some(item => item.component === WorkflowPage)).toBe(false)
  expect(slots.entries('sidebar.panellist').some(item => item.component === AgentMultiIcon)).toBe(false)
  expect(slots.entries('conversation.chat.node').some(item => item.component === NodeMessageView)).toBe(false)
  expect(b.conversation.has('agent-multi-node')).toBe(false)
  expect(b.unmount).toHaveBeenCalledOnce()
  await b.ctx.fiber.dispose()
})
