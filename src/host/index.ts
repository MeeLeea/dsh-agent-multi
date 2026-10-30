/**
 * Host service for agent-multi: durable workflow definitions with
 * optimistic-concurrency editing, plus run execution (start, resume,
 * cancel, inspect) over typert remote methods for the Web client.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/index
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { brandString } from '@deepseek-ai/dsh-brand'
import { agentMultiDomain, agentLibraryRecordSchema, workflowDraftSchema, workflowRecordSchema, triggerRecordSchema } from './domain.ts'
import type { TriggerRecord } from './domain.ts'
import { validateWorkflow } from './validation.ts'
import { agentMultiProjectionDefinition } from './projection.ts'
import { executeRun, type RunResult } from './engine/run.ts'
import type { RunId } from './engine/events.ts'
import { TriggerRuntime } from './engine/trigger-runtime.ts'
import { initialTargetOf, triggerEntryOf } from './trigger-views.ts'
import type {
  CancelRunRequest, CancelRunResult, CreateLibraryAgentRequest, CreateLibraryAgentResult,
  CreateTriggerRequest, CreateTriggerResult, CreateWorkflowRequest, CreateWorkflowResult,
  DeleteTriggerRequest, DeleteTriggerResult, DeleteWorkflowRequest,
  DeleteWorkflowResult, DryRunNodeRequest, DryRunNodeResult, ExportWorkflowRequest, ExportWorkflowResult,
  GetRunRequest, GetRunResult, GetWorkflowRequest,
  GetWorkflowResult, ImportWorkflowRequest, ImportWorkflowResult, ListRunsRequest,
  ListRunsResult, ListTriggersRequest, ListTriggersResult, ModelCatalog, ModelCatalogModel, ModelCatalogProvider,
  ResumeRunRequest, ResumeRunResult, RunStatus, RunView, SaveLibraryAgentRequest,
  SaveLibraryAgentResult, SaveWorkflowRequest, SaveWorkflowResult,
  SetTriggerEnabledRequest, SetTriggerEnabledResult, StartRunRequest, StartRunResult, ValidateWorkflowRequest, ValidateWorkflowResult, WorkflowSummary,
  WorkflowValidationError, AgentMultiJsonValue, AgentLibraryEntry,
} from './contract.ts'
import type { AgentLibraryId } from './types.ts'
import { RunJournal, executeAgentNode, type NodeExecutionDeps } from './engine/executor.ts'
import { textOf } from './engine/format.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { WorkflowDefinition, WorkflowDraft, WorkflowId } from './types.ts'

/** Usage shape on the dry-run result, mirroring the node-end payload. */
type DryRunNodeUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Render a node's content blocks to plain text for the dry-run result. */
function textOfContent(blocks: readonly ContentBlock[]): string {
  return textOf(blocks)
}

/** Controller configuration. */
export interface Config {
  /** Provider for the dormant run-root agent (it never makes model calls). */
  runRootProvider?: string
  /** Model for the dormant run-root agent. */
  runRootModel?: string
  /** Maximum concurrent node activations per run. */
  maxActive?: number
  /**
   * Default billed-token budget per run (uncached input + cache reads +
   * cache writes + output). A `startRun` request may override it per run;
   * both absent means unbudgeted.
   */
  tokenBudget?: number
}

/** Sentinel thrown inside a CAS write when the stored revision moved ahead. */
class RevisionConflict extends Error {
  constructor(readonly current: WorkflowDefinition) {
    super('workflow revision conflict')
  }
}

/** One live or settled run tracked by the controller. */
interface RunRecord {
  readonly runId: RunId
  readonly workflowId: WorkflowId
  readonly runRoot: Agent
  readonly controller: AbortController
  readonly execution: Promise<RunResult>
  /** Input of the latest launch; a resume replays it. */
  lastInput: string
  settled: boolean
  result: RunResult | undefined
}

/**
 * Workflow CRUD and run service. Owns the `agent_multi` storage domain: the
 * domain opens with the plugin, validates every stored record, and closes on
 * dispose, so a hot reload never leaks a domain handle. Runs execute in a
 * dedicated session each; the run registry is in-memory, so resuming a run
 * after a host restart requires the run-root session recovery planned for a
 * later phase.
 */
export class AgentMultiController extends TypertRemoteService {
  static inject = ['storageDomain', 'agentLoop', 'sessions', 'subagents', 'userQuestions', 'sessionProjections']

  static Config = z.object({
    runRootProvider: z.string().default('deepseek'),
    runRootModel: z.string().default('deepseek-chat'),
    maxActive: z.number().step(1).min(1).default(8),
    tokenBudget: z.number().step(1).min(0),
  })

  private readonly ready: Promise<Domain<typeof agentMultiDomain>>
  private readonly runs = new Map<string, RunRecord>()
  private readonly config: Config & { runRootProvider: string, runRootModel: string, maxActive: number }
  private readonly triggerRuntime: TriggerRuntime
  /** Resolved domain handle once `ready` settles; the promise never rejects. */
  private resolvedDomain: Domain<typeof agentMultiDomain> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'agentMultiController', { namespace: 'agentMulti' })
    this.config = {
      runRootProvider: config.runRootProvider ?? 'deepseek',
      runRootModel: config.runRootModel ?? 'deepseek-chat',
      maxActive: config.maxActive ?? 8,
      ...(config.tokenBudget !== undefined ? { tokenBudget: config.tokenBudget } : {}),
    }
    this.ready = ctx.storageDomain.open(agentMultiDomain).then(async (domain) => {
      for (const [key, record] of domain.table('workflows').entries()) {
        if (key !== record.definition.id) {
          // The mismatch is the actionable failure; a rejecting close must not replace it.
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`agent-multi: closing the domain after a key mismatch failed: ${String(error)}`)
          }
          throw new Error(`agent-multi: stored workflow key "${key}" differs from record id "${record.definition.id}"`)
        }
      }
      this.resolvedDomain = domain
      return domain
    })
    this.triggerRuntime = new TriggerRuntime(
      ctx,
      () => { const domain = this.domainOf(); return domain === undefined ? [] : [...domain.table('triggers').entries()].map(([, record]) => record) },
      async (trigger) => await this.fireTrigger(trigger),
      async (trigger) => {
        const domain = await this.ready
        await domain.table('triggers').put(trigger.id, triggerRecordSchema.parse(trigger))
      },
    )
    ctx.effect(async () => {
      const domain = await this.ready
      this.triggerRuntime.requestDrive()
      return () => { void domain.close() }
    })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(agentMultiProjectionDefinition)
      return () => disposeProjection()
    })
    ctx.effect(() => () => {
      void this.triggerRuntime.dispose()
      for (const record of this.runs.values()) record.controller.abort()
    })
  }

  /** Recompute the trigger timer after any durable trigger change. */
  private requestTriggerDrive(): void {
    this.triggerRuntime.requestDrive()
  }

  /** Synchronous domain access when already resolved, for the timer read. */
  private domainOf(): Domain<typeof agentMultiDomain> | undefined {
    return this.resolvedDomain
  }

  /** Spike smoke method; retained as the cheapest remote round-trip check. */
  @Remote('ping')
  ping(): { pong: true } {
    return { pong: true }
  }

  /**
   * Read the host model catalog: registered providers with their models, so
   * the client can offer provider/model dropdowns instead of free text. A
   * provider whose model listing fails is skipped, not fatal.
   */
  @Remote('listModelCatalog')
  async listModelCatalog(): Promise<ModelCatalog> {
    const providers = this.ctx.llm.listProviders().map(provider => ({ id: provider.id, name: provider.name }))
    const models = (await Promise.all(providers.map(async provider => {
      try {
        const listed = await this.ctx.llm.listModels(provider.id)
        return listed.map(model => ({ provider: model.provider, id: model.id, name: model.name }))
      } catch {
        this.ctx.logger.warn(`agent-multi: listing models for provider "${provider.id}" failed`)
        return []
      }
    }))).flat()
    return { providers, models }
  }

  /** @param request - Draft content for a new workflow. */
  @Remote('createWorkflow')
  async createWorkflow(request: CreateWorkflowRequest): Promise<CreateWorkflowResult> {
    const errors = checkDraft(request.draft)
    if (errors.length > 0) return { outcome: 'invalid', errors }
    const definition: WorkflowDefinition = {
      version: 1,
      id: brandString<WorkflowId>(randomUUID()),
      revision: 1,
      name: request.draft.name,
      nodes: request.draft.nodes,
      edges: request.draft.edges,
    }
    const now = new Date().toISOString()
    const record = workflowRecordSchema.parse({ definition, createdAt: now, updatedAt: now })
    const domain = await this.ready
    await domain.table('workflows').put(definition.id, record)
    return { outcome: 'created', definition }
  }

  /** @param request - Draft content plus the revision the editor based it on. */
  @Remote('saveWorkflow')
  async saveWorkflow(request: SaveWorkflowRequest): Promise<SaveWorkflowResult> {
    const errors = checkDraft(request.draft)
    if (errors.length > 0) return { outcome: 'invalid', errors }
    const domain = await this.ready
    const table = domain.table('workflows')
    if (table.get(request.id) === undefined) return { outcome: 'missing' }
    const now = new Date().toISOString()
    try {
      const record = await table.update(request.id, (current) => {
        if (current.definition.revision !== request.expectedRevision) {
          throw new RevisionConflict(current.definition)
        }
        const definition: WorkflowDefinition = {
          version: 1,
          id: request.id,
          revision: request.expectedRevision + 1,
          name: request.draft.name,
          nodes: request.draft.nodes,
          edges: request.draft.edges,
        }
        return workflowRecordSchema.parse({ definition, createdAt: current.createdAt, updatedAt: now })
      })
      return { outcome: 'saved', definition: record.definition }
    } catch (error: unknown) {
      if (error instanceof RevisionConflict) return { outcome: 'conflict', current: error.current }
      throw error
    }
  }

  /** Lists every stored workflow, name-ascending with id as tiebreaker. */
  @Remote('listWorkflows')
  async listWorkflows(): Promise<WorkflowSummary[]> {
    const domain = await this.ready
    return [...domain.table('workflows').entries()]
      .map(([, record]) => ({ id: record.definition.id, name: record.definition.name, revision: record.definition.revision, updatedAt: record.updatedAt }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1)
  }

  /** @param request - Exact workflow identity. */
  @Remote('getWorkflow')
  async getWorkflow(request: GetWorkflowRequest): Promise<GetWorkflowResult> {
    const record = (await this.ready).table('workflows').get(request.id)
    if (record === undefined) return { outcome: 'missing' }
    return { outcome: 'found', definition: record.definition, createdAt: record.createdAt, updatedAt: record.updatedAt }
  }

  /** @param request - Exact workflow identity. */
  @Remote('deleteWorkflow')
  async deleteWorkflow(request: DeleteWorkflowRequest): Promise<DeleteWorkflowResult> {
    const deleted = await (await this.ready).table('workflows').delete(request.id)
    return deleted ? { outcome: 'deleted' } : { outcome: 'missing' }
  }

  /** @param request - Draft to validate without storing. */
  @Remote('validateWorkflow')
  async validateWorkflow(request: ValidateWorkflowRequest): Promise<ValidateWorkflowResult> {
    return { errors: checkDraft(request.draft) }
  }

  /**
   * Export one stored workflow as a portable document: the definition plus a
   * package stamp. The document round-trips through {@link importWorkflow}.
   * @param request - The workflow to export.
   */
  @Remote('exportWorkflow')
  async exportWorkflow(request: ExportWorkflowRequest): Promise<ExportWorkflowResult> {
    const record = (await this.ready).table('workflows').get(request.id)
    if (record === undefined) return { outcome: 'missing' }
    return {
      outcome: 'found',
      document: { kind: 'dsh-agent-multi-workflow', version: 1, definition: record.definition },
    }
  }

  /**
   * Import a portable workflow document: validated from scratch, stored with
   * either the exported identity (`keepId`) or a fresh id. An id collision
   * under `keepId` fails as `invalid` rather than overwriting.
   * @param request - The document and identity policy.
   */
  @Remote('importWorkflow')
  async importWorkflow(request: ImportWorkflowRequest): Promise<ImportWorkflowResult> {
    const { document } = request
    if (document.kind !== 'dsh-agent-multi-workflow' || document.version !== 1) {
      return { outcome: 'invalid', errors: [{ code: 'schema-invalid', message: 'unknown workflow document kind or version' }] }
    }
    const parsed = workflowRecordSchema.safeParse({
      definition: document.definition,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    if (!parsed.success) {
      return { outcome: 'invalid', errors: [{ code: 'schema-invalid', message: 'document does not match the workflow schema' }] }
    }
    const definition: WorkflowDefinition = {
      ...parsed.data.definition,
      id: request.keepId === true
        ? parsed.data.definition.id
        : brandString<WorkflowId>(randomUUID()),
      revision: 1,
    }
    const errors = validateWorkflow(definition)
    if (errors.length > 0) return { outcome: 'invalid', errors }
    const now = new Date().toISOString()
    const domain = await this.ready
    const existing = await domain.table('workflows').get(definition.id)
    if (existing !== undefined) {
      return { outcome: 'invalid', errors: [{ code: 'duplicate-id', message: `workflow id "${definition.id}" already exists` }] }
    }
    const record = workflowRecordSchema.parse({ definition, createdAt: now, updatedAt: now })
    await domain.table('workflows').put(definition.id, record)
    return { outcome: 'created', definition }
  }

  /**
   * Save one agent-node spec into the reusable library. The spec is validated
   * structurally (the same schema agent nodes use); a fresh agent id is
   * assigned on create.
   * @param request - Display name and the reusable agent payload.
   */
  @Remote('createLibraryAgent')
  async createLibraryAgent(request: CreateLibraryAgentRequest): Promise<CreateLibraryAgentResult> {
    const parsed = agentLibraryRecordSchema.safeParse({
      id: randomUUID(),
      name: request.name,
      spec: request.spec,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    if (!parsed.success) {
      return {
        outcome: 'invalid',
        errors: parsed.error.issues.map(issue => ({
          code: 'schema-invalid' as const,
          message: `${issue.path.join('.')}: ${issue.message}`,
        })),
      }
    }
    const record = parsed.data
    const domain = await this.ready
    await domain.table('agents').put(record.id, record)
    return { outcome: 'created', agent: { id: record.id, name: record.name, spec: record.spec, updatedAt: record.updatedAt } }
  }

  /**
   * Replace one library agent's name and spec.
   * @param request - The agent to update and its replacement content.
   */
  @Remote('saveLibraryAgent')
  async saveLibraryAgent(request: SaveLibraryAgentRequest): Promise<SaveLibraryAgentResult> {
    const domain = await this.ready
    const current = await domain.table('agents').get(request.id)
    if (current === undefined) return { outcome: 'missing' }
    const parsed = agentLibraryRecordSchema.safeParse({
      id: request.id,
      name: request.name,
      spec: request.spec,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    })
    if (!parsed.success) {
      return {
        outcome: 'invalid',
        errors: parsed.error.issues.map(issue => ({
          code: 'schema-invalid' as const,
          message: `${issue.path.join('.')}: ${issue.message}`,
        })),
      }
    }
    await domain.table('agents').put(parsed.data.id, parsed.data)
    return { outcome: 'saved', agent: { id: parsed.data.id, name: parsed.data.name, spec: parsed.data.spec, updatedAt: parsed.data.updatedAt } }
  }

  /** Lists every library agent, name-ascending with id as tiebreaker. */
  @Remote('listLibraryAgents')
  async listLibraryAgents(): Promise<AgentLibraryEntry[]> {
    const domain = await this.ready
    return [...domain.table('agents').entries()]
      .map(([, record]) => ({ id: record.id, name: record.name, spec: record.spec, updatedAt: record.updatedAt }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1)
  }

  /**
   * Delete one library agent. Stored workflows keep their own node copies,
   * so deleting never breaks an existing workflow.
   * @param request - The agent to remove.
   */
  @Remote('deleteLibraryAgent')
  async deleteLibraryAgent(request: { readonly id: AgentLibraryId }): Promise<{ outcome: 'deleted' | 'missing' }> {
    const domain = await this.ready
    const deleted = await domain.table('agents').delete(request.id)
    return deleted ? { outcome: 'deleted' } : { outcome: 'missing' }
  }

  /**
   * Start a run: a dedicated session, a dormant run-root agent parenting every
   * node activation, and the engine driving the workflow to a terminal
   * outcome. Returns the run identity immediately; poll `get-run`.
   * @param request - The workflow to execute and the user input.
   */
  @Remote('startRun')
  async startRun(request: StartRunRequest): Promise<StartRunResult> {
    const record = (await this.ready).table('workflows').get(request.workflowId)
    if (record === undefined) return { outcome: 'missing' }
    const runRoot = await this.ctx.agentLoop.create(SessionId(randomUUID()), {
      provider: this.config.runRootProvider,
      model: this.config.runRootModel,
    })
    const budget = request.tokenBudget !== undefined
      ? request.tokenBudget
      : this.config.tokenBudget
    return this.launchRun(record.definition, request.input, runRoot, false, undefined, budget)
  }

  /**
   * Fire one trigger: resolve the workflow, start the run, and return the run
   * id so the runtime can record it as the trigger's latest run. Resolves with
   * `undefined` when the workflow disappeared; the trigger keeps its target.
   * @param trigger - The due trigger record.
   */
  private async fireTrigger(trigger: TriggerRecord): Promise<string | undefined> {
    const record = (await this.ready).table('workflows').get(trigger.workflowId)
    if (record === undefined) return undefined
    const runRoot = await this.ctx.agentLoop.create(SessionId(randomUUID()), {
      provider: this.config.runRootProvider,
      model: this.config.runRootModel,
    })
    const budget = trigger.tokenBudget !== undefined
      ? trigger.tokenBudget
      : this.config.tokenBudget
    const started = this.launchRun(record.definition, trigger.input, runRoot, false, undefined, budget)
    return started.runId
  }

  /**
   * Create a workflow trigger. The timing rule is validated by the schedule
   * package's recurrence arithmetic and armed with its first future target.
   * @param request - Workflow binding, timing rule, and run parameters.
   */
  @Remote('createTrigger')
  async createTrigger(request: CreateTriggerRequest): Promise<CreateTriggerResult> {
    const domain = await this.ready
    if (domain.table('workflows').get(request.workflowId) === undefined) return { outcome: 'missing' }
    let scheduledAt: string
    try {
      scheduledAt = initialTargetOf(request.timing, Date.now())
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { outcome: 'invalid', errors: [{ code: 'schema-invalid', message: `timing: ${message}` }] }
    }
    const now = new Date().toISOString()
    const parsed = triggerRecordSchema.safeParse({
      id: randomUUID(),
      workflowId: request.workflowId,
      timing: request.timing,
      input: request.input,
      ...(request.tokenBudget !== undefined ? { tokenBudget: request.tokenBudget } : {}),
      enabled: true,
      scheduledAt,
      createdAt: now,
      updatedAt: now,
    })
    if (!parsed.success) {
      return {
        outcome: 'invalid',
        errors: parsed.error.issues.map(issue => ({
          code: 'schema-invalid',
          message: `${issue.path.join('.')}: ${issue.message}`,
        })),
      }
    }
    await domain.table('triggers').put(parsed.data.id, parsed.data)
    this.requestTriggerDrive()
    return { outcome: 'created', trigger: triggerEntryOf(parsed.data) }
  }

  /**
   * Enable or disable one trigger. Disabling stops the timer obligation; the
   * committed target is preserved, so re-enabling never back-fires missed runs.
   * @param request - The trigger and its new enabled state.
   */
  @Remote('setTriggerEnabled')
  async setTriggerEnabled(request: SetTriggerEnabledRequest): Promise<SetTriggerEnabledResult> {
    const domain = await this.ready
    const table = domain.table('triggers')
    const current = table.get(request.id)
    if (current === undefined) return { outcome: 'missing' }
    const updated: TriggerRecord = {
      ...current,
      enabled: request.enabled,
      // Re-acceptance restarts from a strictly future occurrence.
      ...(request.enabled ? { scheduledAt: initialTargetOf(current.timing, Date.now()) } : {}),
      updatedAt: new Date().toISOString(),
    }
    await table.put(request.id, triggerRecordSchema.parse(updated))
    this.requestTriggerDrive()
    return { outcome: 'saved', trigger: triggerEntryOf(updated) }
  }

  /**
   * Delete one trigger. Runs already started by it keep running.
   * @param request - The trigger to remove.
   */
  @Remote('deleteTrigger')
  async deleteTrigger(request: DeleteTriggerRequest): Promise<DeleteTriggerResult> {
    const domain = await this.ready
    const deleted = await domain.table('triggers').delete(request.id)
    this.requestTriggerDrive()
    return deleted ? { outcome: 'deleted' } : { outcome: 'missing' }
  }

  /**
   * List triggers, oldest first, optionally narrowed to one workflow.
   * @param request - Workflow filter, or all triggers when omitted.
   */
  @Remote('listTriggers')
  async listTriggers(request: ListTriggersRequest): Promise<ListTriggersResult> {
    const domain = await this.ready
    const triggers = [...domain.table('triggers').entries()]
      .map(([, record]) => record)
      .filter(record => request.workflowId === undefined || record.workflowId === request.workflowId)
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)
      .map(record => triggerEntryOf(record))
    return { triggers }
  }

  /**
   * Resume a paused or failed run on its existing session: completed nodes
   * are skipped from the journal, the current stored definition is used (so
   * edits between attempts take effect), and the original input replays.
   * @param request - The run to continue.
   */
  @Remote('resumeRun')
  async resumeRun(request: ResumeRunRequest): Promise<ResumeRunResult> {
    const entry = this.runs.get(request.runId)
    if (entry === undefined) return { outcome: 'missing' }
    if (!entry.settled) return { outcome: 'running' }
    const record = (await this.ready).table('workflows').get(entry.workflowId)
    if (record === undefined) return { outcome: 'missing' }
    this.runs.delete(request.runId)
    return this.launchRun(record.definition, entry.lastInput, entry.runRoot, true, entry.runId)
  }

  /**
   * Cancel a run: aborts the run signal, which tears down in-flight node
   * activations and settles the run as cancelled. Awaiting the settled
   * status makes the response deterministic.
   * @param request - The run to abort.
   */
  @Remote('cancelRun')
  async cancelRun(request: CancelRunRequest): Promise<CancelRunResult> {
    const entry = this.runs.get(request.runId)
    if (entry === undefined) return { outcome: 'missing' }
    entry.controller.abort()
    await entry.execution
    return { outcome: 'cancelled', runId: request.runId, status: runStatusOf(entry) }
  }

  /**
   * Inspect a run: status plus the full agent-multi journal projected from
   * the run session (the kanban derives from these events).
   * @param request - Exact run identity.
   */
  @Remote('getRun')
  async getRun(request: GetRunRequest): Promise<GetRunResult> {
    const entry = this.runs.get(request.runId)
    if (entry === undefined) return { outcome: 'missing' }
    return { outcome: 'found', run: this.viewOf(entry) }
  }

  /**
   * List tracked runs, newest first, optionally narrowed to one workflow.
   * Registry is in-memory, so the history covers this host process only.
   * @param request - Workflow filter, or all workflows when omitted.
   */
  @Remote('listRuns')
  async listRuns(request: ListRunsRequest): Promise<ListRunsResult> {
    const runs = [...this.runs.values()]
      .filter(entry => request.workflowId === undefined || entry.workflowId === request.workflowId)
      .reverse()
      .map(entry => {
        const result = entry.result
        const failure = result?.failure === undefined ? {} : { failure: { ...result.failure } }
        return { runId: entry.runId, workflowId: entry.workflowId, status: runStatusOf(entry), ...failure }
      })
    return { runs }
  }

  /**
   * Dry-run one agent node in isolation: a throwaway run-root session, no
   * workflow storage, no journal registration. Resolves with the settled
   * node outcome so the caller sees the final output or failure directly.
   * @param request - The node spec to try and the input to feed it.
   */
  @Remote('dryRunNode')
  async dryRunNode(request: DryRunNodeRequest): Promise<DryRunNodeResult> {
    const runRoot = await this.ctx.agentLoop.create(SessionId(randomUUID()), {
      provider: this.config.runRootProvider,
      model: this.config.runRootModel,
    })
    const controller = new AbortController()
    const journal = new RunJournal(this.ctx, runRoot.session)
    const deps: NodeExecutionDeps = {
      ctx: this.ctx,
      runRoot,
      journal,
      runId: brandString<RunId>(randomUUID()),
      ledger: new Map(),
      userInput: request.input,
      signal: controller.signal,
      nodeOf: new Map(),
      hitlChildren: new Set(),
    }
    try {
      const outcome = await executeAgentNode(deps, request.node, [])
      if (outcome.ok) {
        const events = runRoot.session.snapshotEvents()
          .filter(event => event.type === 'agent-multi/node-end')
        const usage = events.length > 0
          ? (events.at(-1)?.data as { usage?: DryRunNodeUsage }).usage
          : undefined
        const durationMs = events.length > 0
          ? ((events.at(-1)?.data as { durationMs?: number }).durationMs ?? 0)
          : 0
        return {
          outcome: 'completed',
          output: textOfContent(outcome.output),
          durationMs,
          ...(usage !== undefined ? { usage } : {}),
        }
      }
      return {
        outcome: 'failed',
        errorClass: outcome.errorClass,
        message: outcome.message,
        attempts: outcome.attempts,
      }
    } finally {
      controller.abort()
    }
  }

  /**
   * Launch (or relaunch) one run and register it. The execution promise never
   * rejects here: the engine maps every outcome to a {@link RunResult}, and a
   * journaling failure is contained as a synthetic failed run.
   */
  private launchRun(
    definition: WorkflowDefinition,
    input: string,
    runRoot: Agent,
    resume: boolean,
    runId: RunId = brandString<RunId>(randomUUID()),
    tokenBudget?: number,
  ): { outcome: 'started'; runId: string } {
    const controller = new AbortController()
    const execution = executeRun({
      ctx: this.ctx,
      runRoot,
      definition,
      userInput: input,
      signal: controller.signal,
      maxActive: this.config.maxActive,
      resume,
      runId,
      ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    })
    const entry: RunRecord = {
      runId, workflowId: definition.id, runRoot, controller, execution,
      lastInput: input, settled: false, result: undefined,
    }
    this.runs.set(runId, entry)
    void execution.then(
      (result) => {
        entry.settled = true
        entry.result = result
      },
      () => {
        entry.settled = true
        entry.result = { outcome: 'failed', runId }
      },
    )
    return { outcome: 'started', runId }
  }

  /** Project a run record into the client view over its session journal and projection. */
  private viewOf(entry: RunRecord): RunView {
    const events = entry.runRoot.session.snapshotEvents()
      .filter((event) => event.type.startsWith('agent-multi/'))
      .map((event) => ({ type: event.type, data: event.data as AgentMultiJsonValue }))
    const result = entry.result
    const failure = result?.failure === undefined ? {} : { failure: { ...result.failure } }
    const projected = this.ctx.sessionProjections.stateOf(entry.runRoot.session, 'agentMulti')
    const nodes = projected?.run === undefined
      ? []
      : Object.values(projected.run.nodes)
          .map(node => ({
            nodeId: node.nodeId,
            nodeKind: node.nodeKind,
            status: node.status,
            attempt: node.attempt,
            ...node.streaming === undefined ? {} : { streaming: node.streaming },
            ...node.output === undefined ? {} : { output: node.output },
            ...node.errorClass === undefined ? {} : { errorClass: node.errorClass },
            ...node.message === undefined ? {} : { message: node.message },
            ...node.attempts === undefined ? {} : { attempts: node.attempts },
            ...node.durationMs === undefined ? {} : { durationMs: node.durationMs },
            ...node.usage === undefined ? {} : { usage: node.usage },
          }))
    const hitl = projected?.run?.hitl === undefined
      ? {}
      : {
          hitl: {
            nodeId: projected.run.hitl.nodeId,
            question: projected.run.hitl.question,
            ...projected.run.hitl.answer === undefined ? {} : { answer: projected.run.hitl.answer },
          },
        }
    const pausedReason = projected?.run?.pauseReason === undefined
      ? {}
      : { pausedReason: projected.run.pauseReason }
    if (result?.output === undefined) {
      return {
        runId: entry.runId, workflowId: entry.workflowId,
        status: runStatusOf(entry), nodes, ...hitl, ...pausedReason, events, ...failure,
      }
    }
    return {
      runId: entry.runId, workflowId: entry.workflowId,
      status: runStatusOf(entry), nodes, ...hitl, ...pausedReason, events, ...failure,
      output: result.output,
    }
  }
}

/** Terminal or in-progress status of a tracked run. */
function runStatusOf(entry: RunRecord): RunStatus {
  return entry.settled ? (entry.result?.outcome ?? 'failed') : 'running'
}

/** Structural parse followed by semantic graph rules. */
function checkDraft(draft: WorkflowDraft): WorkflowValidationError[] {
  const parsed = workflowDraftSchema.safeParse(draft)
  if (!parsed.success) {
    return parsed.error.issues.map(issue => ({
      code: 'schema-invalid',
      message: `${issue.path.join('.')}: ${issue.message}`,
    }))
  }
  return validateWorkflow(parsed.data)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentMultiController: AgentMultiController
  }
}

export type {
  CancelRunRequest, CancelRunResult, CreateLibraryAgentRequest, CreateLibraryAgentResult,
  CreateTriggerRequest, CreateTriggerResult, CreateWorkflowRequest, CreateWorkflowResult,
  DeleteLibraryAgentResult, DeleteTriggerRequest, DeleteTriggerResult, DeleteWorkflowRequest,
  DeleteWorkflowResult, DryRunNodeRequest, DryRunNodeResult, ExportWorkflowRequest, ExportWorkflowResult,
  GetRunRequest, GetRunResult, GetWorkflowRequest,
  GetWorkflowResult, ImportWorkflowRequest, ImportWorkflowResult, ListRunsRequest,
  ListRunsResult, ListTriggersRequest, ListTriggersResult, ModelCatalog, ModelCatalogModel, ModelCatalogProvider,
  ResumeRunRequest, ResumeRunResult, RunHitlView, RunNodeView, RunStatus, RunSummary, RunView,
  SaveLibraryAgentRequest, SaveLibraryAgentResult, SaveWorkflowRequest, SaveWorkflowResult,
  SetTriggerEnabledRequest, SetTriggerEnabledResult, StartRunRequest, StartRunResult, TriggerEntry,
  ValidateWorkflowRequest, ValidateWorkflowResult, WorkflowExportDocument, WorkflowSummary, WorkflowValidationError,
} from './contract.ts'
export type { AgentMultiErrorClass } from './engine/events.ts'
export type {
  AgentLibraryEntry, AgentLibraryId, AgentLibrarySpec, TriggerTiming,
  EdgeFormat, EdgeSpec, NodeKind, NodeSpec, WorkflowDefinition, WorkflowDraft, WorkflowId,
} from './types.ts'

export default AgentMultiController
