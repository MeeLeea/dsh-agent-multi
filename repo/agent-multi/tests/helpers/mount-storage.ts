/**
 * Storage harness for agent-multi tests: a real storage plugin over a shared
 * memory pool so a second harness simulates a process restart against the
 * same durable state, plus the engine services the controller injects.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { mountWorkingDirectoryFixture } from '../../../../subagent/subagent/tests/working-directory-fixture.ts'
import AgentMultiController from '../../src/index.ts'

/** Roots created by mounted harnesses, cleaned by {@link cleanupHarnessRoots}. */
const roots: string[] = []

/**
 * Mount storage plus the full AgentMultiController service set on a fresh
 * context.
 * @param pool - Shared media; pass the same pool to a later harness to
 * simulate a process restart against the persisted workflows.
 * @returns The mounted context and its controller.
 */
export async function mountStorage(pool: MemoryMediaPool): Promise<{ ctx: Context, controller: AgentMultiController }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-multi-store-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
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
  await ctx.plugin(AgentMultiController, {})
  return { ctx, controller: ctx.agentMultiController }
}

/** Remove harness scratch directories; call from afterEach. */
export function cleanupHarnessRoots(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}
