/**
 * Wire contracts shared by the host controller, the remote client, and the
 * tests: validation issue vocabulary, request and result interfaces, and the
 * template reference grammar.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/contract
 */

import type { AgentMultiErrorClass } from './engine/events.ts'

export type { AgentMultiErrorClass }
import type { WorkflowDefinition, WorkflowDraft, WorkflowId, AgentNodeSpec, AgentLibraryId, AgentLibrarySpec, TriggerTiming } from './types.ts'

/** Matches `{{nodes.<id>}}` template references (any spacing inside braces). */
export const TEMPLATE_NODE_REF_RE = /\{\{\s*nodes\.([A-Za-z0-9_-]+)\s*\}\}/g

/** Rejection codes the semantic validator and the inspector surface. */
export type WorkflowValidationCode =
  | 'schema-invalid'
  | 'name-empty'
  | 'node-id-invalid'
  | 'node-id-duplicate'
  | 'edge-id-duplicate'
  | 'edge-endpoint-unknown'
  | 'edge-self'
  | 'edge-note'
  | 'edge-handle-unexpected'
  | 'edge-tohandle-invalid'
  | 'input-count'
  | 'input-indegree'
  | 'output-count'
  | 'output-outdegree'
  | 'router-cases-empty'
  | 'router-case-blank'
  | 'router-case-duplicate'
  | 'router-case-unwired'
  | 'router-handle-missing'
  | 'router-handle-unknown'
  | 'loop-handle-unknown'
  | 'loop-handle-missing'
  | 'loop-params'
  | 'join-indegree'
  | 'join-quorum-range'
  | 'cycle-illegal'
  | 'template-node-unknown'
  | 'duplicate-id'

/** One semantic rejection; `nodeId`/`edgeId`/`handle` locate the offender. */
export interface WorkflowValidationError {
  readonly code: WorkflowValidationCode
  readonly message: string
  readonly nodeId?: string
  readonly edgeId?: string
  readonly handle?: string
}

/** Create request: draft content only; the host assigns id and revision. */
export interface CreateWorkflowRequest {
  readonly draft: WorkflowDraft
}

/** Save request: optimistic concurrency against `expectedRevision`. */
export interface SaveWorkflowRequest {
  readonly id: WorkflowId
  readonly draft: WorkflowDraft
  readonly expectedRevision: number
}

/** Lookup by exact workflow identity. */
export interface GetWorkflowRequest {
  readonly id: WorkflowId
}

/** Delete by exact workflow identity. */
export interface DeleteWorkflowRequest {
  readonly id: WorkflowId
}

/** On-demand semantic validation of an editor draft. */
export interface ValidateWorkflowRequest {
  readonly draft: WorkflowDraft
}

/** Export request: serialize one stored workflow for transfer. */
export interface ExportWorkflowRequest {
  readonly id: WorkflowId
}

/** Export result: the portable workflow document. */
export interface ExportWorkflowResult {
  readonly outcome: 'found' | 'missing'
  readonly document?: WorkflowExportDocument
}

/**
 * Portable workflow document: the stored definition plus a package stamp.
 * Importing validates the definition from scratch; the source revision is
 * informational only.
 */
export interface WorkflowExportDocument {
  readonly kind: 'dsh-agent-multi-workflow'
  readonly version: 1
  readonly definition: WorkflowDefinition
}

/** Import request: a portable document plus the identity policy. */
export interface ImportWorkflowRequest {
  readonly document: WorkflowExportDocument
  /** Keep the exported identity; default is to assign a fresh id. */
  readonly keepId?: boolean
}

/** Import result mirrors {@link CreateWorkflowResult}. */
export type ImportWorkflowResult = CreateWorkflowResult

/** Library-agent create request: display name and reusable agent payload. */
export interface CreateLibraryAgentRequest {
  readonly name: string
  readonly spec: AgentLibrarySpec
}

/** Library-agent CRUD results, one per lifecycle step. */
export type CreateLibraryAgentResult =
  | { readonly outcome: 'created'; readonly agent: AgentLibraryEntry }
  | { readonly outcome: 'invalid'; readonly errors: readonly WorkflowValidationError[] }
export type SaveLibraryAgentResult =
  | { readonly outcome: 'saved'; readonly agent: AgentLibraryEntry }
  | { readonly outcome: 'invalid'; readonly errors: readonly WorkflowValidationError[] }
  | { readonly outcome: 'missing' }
export type DeleteLibraryAgentResult =
  | { readonly outcome: 'deleted' }
  | { readonly outcome: 'missing' }

/** One library agent as the client sees it. */
export interface AgentLibraryEntry {
  readonly id: AgentLibraryId
  readonly name: string
  readonly spec: AgentLibrarySpec
  readonly updatedAt: string
}

/** Save request for one library agent: name/spec replace with revision check. */
export interface SaveLibraryAgentRequest {
  readonly id: AgentLibraryId
  readonly name: string
  readonly spec: AgentLibrarySpec
}

/** One stored workflow, summarized for list views. */
export interface WorkflowSummary {
  readonly id: WorkflowId
  readonly name: string
  readonly revision: number
  readonly updatedAt: string
}

/** Create result: stored definition or the full rejection list. */
export type CreateWorkflowResult =
  | { readonly outcome: 'created'; readonly definition: WorkflowDefinition }
  | { readonly outcome: 'invalid'; readonly errors: readonly WorkflowValidationError[] }

/** Save result: saved, rejected, revision conflict, or missing workflow. */
export type SaveWorkflowResult =
  | { readonly outcome: 'saved'; readonly definition: WorkflowDefinition }
  | { readonly outcome: 'invalid'; readonly errors: readonly WorkflowValidationError[] }
  | { readonly outcome: 'conflict'; readonly current: WorkflowDefinition }
  | { readonly outcome: 'missing' }

/** Get result: the record or `missing` for an unknown id. */
export type GetWorkflowResult =
  | { readonly outcome: 'found'; readonly definition: WorkflowDefinition; readonly createdAt: string; readonly updatedAt: string }
  | { readonly outcome: 'missing' }

/** Delete result: whether the workflow existed. */
export type DeleteWorkflowResult =
  | { readonly outcome: 'deleted' }
  | { readonly outcome: 'missing' }

/** Validation result: always succeeds; errors may be empty. */
export interface ValidateWorkflowResult {
  readonly errors: readonly WorkflowValidationError[]
}

/** Start-run request: the workflow to execute and the user input. */
export interface StartRunRequest {
  readonly workflowId: WorkflowId
  readonly input: string
  /**
   * Billed-token budget for this run (uncached input + cache reads + cache
   * writes + output); overrides the controller default, absent means the
   * controller default applies.
   */
  readonly tokenBudget?: number
}

/** Start result: the run identity, or `missing` for an unknown workflow. */
export type StartRunResult =
  | { readonly outcome: 'started'; readonly runId: string }
  | { readonly outcome: 'missing' }

/** Resume request: the paused or failed run to continue. */
export interface ResumeRunRequest {
  readonly runId: string
}

/** Resume result: restarted, unknown run, or still executing. */
export type ResumeRunResult =
  | { readonly outcome: 'started'; readonly runId: string }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'running' }

/** Cancel request: the run to abort. */
export interface CancelRunRequest {
  readonly runId: string
}

/** Cancel result: the settled status after abort, or unknown run. */
export type CancelRunResult =
  | { readonly outcome: 'cancelled'; readonly runId: string; readonly status: RunStatus }
  | { readonly outcome: 'missing' }

/** Get-run request: exact run identity. */
export interface GetRunRequest {
  readonly runId: string
}

/** Terminal or in-progress status of one run. */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** Recursively JSON-compatible value, for journal event payloads. */
export type AgentMultiJsonValue = null | boolean | number | string | AgentMultiJsonValue[] | { [key: string]: AgentMultiJsonValue }

/** One journal event projected for the client. */
export interface RunEventView {
  readonly type: string
  readonly data: AgentMultiJsonValue
}

/** The terminal node failure of a failed run. */
export interface RunFailureView {
  readonly nodeId: string
  readonly errorClass: AgentMultiErrorClass
  readonly message: string
  readonly attempts: number
}

/** Per-node execution state for the run kanban and canvas status rings. */
export interface RunNodeView {
  readonly nodeId: string
  readonly nodeKind: string
  /** Running, completed, or failed. */
  readonly status: 'running' | 'completed' | 'failed'
  /** Latest attempt number. */
  readonly attempt: number
  /** Trimmed streaming preview while the node runs. */
  readonly streaming?: string
  /** Final output once completed. */
  readonly output?: string
  /** Failure classification once failed. */
  readonly errorClass?: AgentMultiErrorClass
  /** Failure message once failed. */
  readonly message?: string
  /** Attempts exhausted at terminal failure. */
  readonly attempts?: number
  /** Wall-clock duration of the settled attempt, in milliseconds. */
  readonly durationMs?: number
  /** Token accounting over the node's model calls, when any reported usage. */
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
  }
}

/** An open human-in-the-loop question of the run. */
export interface RunHitlView {
  readonly nodeId: string
  readonly question: string
  /** The recorded answer, once provided. */
  readonly answer?: string
}

/** Run snapshot for the kanban: status, projected node states, and the journal. */
export interface RunView {
  readonly runId: string
  readonly workflowId: WorkflowId
  readonly status: RunStatus
  readonly output?: string
  readonly failure?: RunFailureView
  /** Why a non-running run paused, when the journal recorded one. */
  readonly pausedReason?: 'breakpoint' | 'hitl' | 'process-restart'
  /** Per-node execution state projected from the session journal. */
  readonly nodes: readonly RunNodeView[]
  /** The open or answered HITL question of the run. */
  readonly hitl?: RunHitlView
  /** Full agent-multi journal events, in order. */
  readonly events: readonly RunEventView[]
}

/** Get-run result: the view or `missing` for an unknown run. */
export type GetRunResult =
  | { readonly outcome: 'found'; readonly run: RunView }
  | { readonly outcome: 'missing' }

/** One run-history row: identity plus terminal state, no journal detail. */
export interface RunSummary {
  readonly runId: string
  readonly workflowId: WorkflowId
  readonly status: RunStatus
  /** Failure classification and message when the run failed. */
  readonly failure?: RunFailureView
}

/** List-runs request: filter by workflow, or all workflows when omitted. */
export interface ListRunsRequest {
  readonly workflowId?: WorkflowId
}

/** List-runs result: every tracked run, newest first. */
export interface ListRunsResult {
  readonly runs: readonly RunSummary[]
}

/** Dry-run request: one agent node spec and the input to try it with. */
export interface DryRunNodeRequest {
  readonly node: AgentNodeSpec
  readonly input: string
}

/** Dry-run result: the node output or its terminal failure. */
export type DryRunNodeResult =
  | {
    readonly outcome: 'completed'
    readonly output: string
    readonly durationMs: number
    readonly usage?: {
      readonly inputTokens: number
      readonly outputTokens: number
      readonly cacheReadTokens: number
      readonly cacheWriteTokens: number
    }
  }
  | {
    readonly outcome: 'failed'
    readonly errorClass: AgentMultiErrorClass
    readonly message: string
    readonly attempts: number
  }

/** Trigger create request: workflow binding, timing rule, and run parameters (G11). */
export interface CreateTriggerRequest {
  readonly workflowId: WorkflowId
  readonly timing: TriggerTiming
  /** Run input delivered at every fire. */
  readonly input: string
  /** Per-run billed-token budget override, as in {@link StartRunRequest}. */
  readonly tokenBudget?: number
}

/** Trigger creation result: the stored trigger view or rejection. */
export type CreateTriggerResult =
  | { readonly outcome: 'created'; readonly trigger: TriggerEntry }
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'invalid'; readonly errors: readonly WorkflowValidationError[] }

/** One trigger as the client sees it. */
export interface TriggerEntry {
  readonly id: string
  readonly workflowId: WorkflowId
  readonly timing: TriggerTiming
  readonly input: string
  readonly tokenBudget?: number
  readonly enabled: boolean
  /** Committed earliest unaccepted UTC target (ISO); fires when the clock passes it. */
  readonly scheduledAt: string
  /** Latest run started by this trigger, when one has fired. */
  readonly lastRunId?: string
  readonly updatedAt: string
}

/** Enable/disable request for one trigger. */
export interface SetTriggerEnabledRequest {
  readonly id: string
  readonly enabled: boolean
}

/** Enable/disable result: the updated trigger view or `missing`. */
export type SetTriggerEnabledResult =
  | { readonly outcome: 'saved'; readonly trigger: TriggerEntry }
  | { readonly outcome: 'missing' }

/** Trigger delete request. */
export interface DeleteTriggerRequest {
  readonly id: string
}

/** Trigger delete result. */
export type DeleteTriggerResult =
  | { readonly outcome: 'deleted' }
  | { readonly outcome: 'missing' }

/** List-triggers request: narrow to one workflow or list all. */
export interface ListTriggersRequest {
  readonly workflowId?: WorkflowId
}

/** List-triggers result: every stored trigger, oldest first. */
export interface ListTriggersResult {
  readonly triggers: readonly TriggerEntry[]
}

/** One selectable provider route from the host model catalog. */
export interface ModelCatalogProvider {
  readonly id: string
  readonly name: string
}

/** One selectable model from the host model catalog. */
export interface ModelCatalogModel {
  readonly provider: string
  readonly id: string
  readonly name: string
}

/**
 * Model-catalog result: registered providers and every registered adapter's
 * models. A provider whose `listModels` call fails contributes no models
 * instead of failing the whole catalog.
 */
export interface ModelCatalog {
  readonly providers: readonly ModelCatalogProvider[]
  readonly models: readonly ModelCatalogModel[]
}
