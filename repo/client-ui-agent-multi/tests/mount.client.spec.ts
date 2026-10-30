/** The Remote namespace, workflow panel, and sidebar row follow client plugin disposal. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, vi } from 'vitest'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { AgentMultiIcon } from '../src/client/AgentMultiIcon.tsx'
import { WorkflowPage } from '../src/client/WorkflowPage.tsx'
import { zh } from '../src/client/locales.ts'
import { inject, mount } from '../src/client/mount.ts'

const REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-experimental-agent-multi',
  descriptors: [],
}

const METHOD_NAMES = [
  'createWorkflow', 'saveWorkflow', 'listWorkflows', 'getWorkflow', 'deleteWorkflow',
  'validateWorkflow', 'startRun', 'resumeRun', 'cancelRun', 'getRun',
] as const

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
  const methods = Object.fromEntries(METHOD_NAMES.map(name => [name, vi.fn(async () => ({ ok: true, value: undefined }))]))
  ctx.provide('remote.agentMulti', methods)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.locale.setLocale('zh')
  ctx.slots.register({ name: 'root', children: {
    'main': { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  return { ctx, unmount, methods }
}

it('registers the localized panel, sidebar row, and remote action face', async () => {
  const b = await fixture()
  const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mount(ctx, REMOTE) })
  await fiber
  try {
    const panel = b.ctx.slots.entries('main').find(item => item.component === WorkflowPage)
    expect(panel?.options).toMatchObject({ key: 'agent-multi' })
    expect(panel?.locale).toBe('agent-multi')
    const actions = panel!.inject!() as Record<string, unknown>
    for (const name of METHOD_NAMES) assert(typeof actions[name] === 'function', name)
    await (actions.listWorkflows as () => Promise<unknown>)()
    expect(b.methods.listWorkflows).toHaveBeenCalledOnce()
    const row = b.ctx.slots.entries('sidebar.panellist').find(item => item.component === AgentMultiIcon)
    expect(row?.options).toMatchObject({ id: 'agent-multi' })
    expect(row?.locale).toBe('agent-multi')
    expect(resolveSlotLabel(row?.options.label)).toBe(zh.panel)
    const t = b.ctx.locale.bind('agent-multi')
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
  expect(b.ctx.slots.entries('main').some(item => item.component === WorkflowPage)).toBe(true)
  expect(b.ctx.slots.entries('sidebar.panellist').some(item => item.component === AgentMultiIcon)).toBe(true)
  await fiber.dispose()
  expect(b.ctx.slots.entries('main').some(item => item.component === WorkflowPage)).toBe(false)
  expect(b.ctx.slots.entries('sidebar.panellist').some(item => item.component === AgentMultiIcon)).toBe(false)
  expect(b.unmount).toHaveBeenCalledOnce()
  await b.ctx.fiber.dispose()
})
