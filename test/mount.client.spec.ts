/** The Remote namespace, workflow panel, and sidebar row follow client plugin disposal. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, vi } from 'vitest'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { AgentMultiIcon } from '../src/client/AgentMultiIcon.tsx'
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
async function fixture() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  new FakeLocale(ctx)
  new FakeSlots(ctx)
  const methods = Object.fromEntries(METHOD_NAMES.map(name => [name, vi.fn(async () => ({ ok: true, value: undefined }))]))
  ctx.provide('remote.agentMulti', methods)
  return { ctx, unmount, methods }
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

it('withdraws the remote contribution and both slot entries on disposal', async () => {
  const b = await fixture()
  const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mount(ctx, REMOTE) })
  await fiber
  const slots = slotsOf(b.ctx)
  expect(slots.entries('main').some(item => item.component === WorkflowPage)).toBe(true)
  expect(slots.entries('sidebar.panellist').some(item => item.component === AgentMultiIcon)).toBe(true)
  await fiber.dispose()
  expect(slots.entries('main').some(item => item.component === WorkflowPage)).toBe(false)
  expect(slots.entries('sidebar.panellist').some(item => item.component === AgentMultiIcon)).toBe(false)
  expect(b.unmount).toHaveBeenCalledOnce()
  await b.ctx.fiber.dispose()
})
