/**
 * Structural zod schemas for workflow drafts and stored records, plus the
 * storage-domain specification and the single source of truth for the value
 * types (re-exported from {@link ./types}). Semantic graph rules live in
 * validation.ts; this module enforces per-field shape and bounds so a
 * malformed record can never enter (or brick) the domain.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/domain
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Workflow identity across storage and runs; assigned by the host. */
export type WorkflowId = Branded<'WorkflowId'>

/** Node kinds v1: seven canvas kinds. `note` never executes. */
export type NodeKind = 'input' | 'agent' | 'router' | 'join' | 'loop' | 'output' | 'note'

/** Intermediate-layer representation a downstream node receives (R4). */
export type EdgeFormat = 'json' | 'md' | 'text'

/** Node ids double as template identifiers; keep them template-safe. */
const nodeIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/)

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1),
  backoffMs: z.number().int().min(0),
  fallbackModel: z.string().min(1).optional(),
}).strict()

const toolFilterSchema = z.object({
  allow: z.array(z.string().min(1)).optional(),
  deny: z.array(z.string().min(1)).optional(),
}).strict()

const nodeBaseSchema = z.object({
  id: nodeIdSchema,
  name: z.string().min(1),
  /** Canvas placement the host preserves verbatim; absent for API-authored drafts. */
  position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
}).strict()

const agentNodeSchema = nodeBaseSchema.extend({
  kind: z.literal('agent'),
  systemPrompt: z.string(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  toolFilter: toolFilterSchema.optional(),
  permissionPreset: z.string().min(1).optional(),
  contextBudgetTokens: z.number().int().positive().optional(),
  retry: retryPolicySchema,
  timeoutMs: z.number().int().positive().optional(),
  hitlEnabled: z.boolean(),
}).strict()

const nodeSchema = z.discriminatedUnion('kind', [
  nodeBaseSchema.extend({ kind: z.literal('input') }).strict(),
  agentNodeSchema,
  nodeBaseSchema.extend({
    kind: z.literal('router'),
    cases: z.array(z.string()).min(1),
  }).strict(),
  nodeBaseSchema.extend({
    kind: z.literal('join'),
    strategy: z.enum(['all', 'any', 'quorum']),
    quorum: z.number().int().min(1).optional(),
  }).strict(),
  nodeBaseSchema.extend({
    kind: z.literal('loop'),
    mode: z.enum(['items', 'count', 'while']),
    itemsExpr: z.string().optional(),
    count: z.number().int().min(1).optional(),
    condition: z.string().optional(),
    maxIters: z.number().int().min(1),
    collect: z.boolean(),
  }).strict(),
  nodeBaseSchema.extend({ kind: z.literal('output') }).strict(),
  nodeBaseSchema.extend({
    kind: z.literal('note'),
    text: z.string(),
  }).strict(),
])

const edgeSchema = z.object({
  id: z.string().min(1),
  from: nodeIdSchema,
  fromHandle: z.string().min(1).optional(),
  to: nodeIdSchema,
  toHandle: z.literal('back').optional(),
  format: z.enum(['json', 'md', 'text']),
  template: z.string().optional(),
  inContext: z.boolean().default(true),
}).strict()

/** Editor payload: definition content without server-assigned identity. */
export const workflowDraftSchema = z.object({
  name: z.string().min(1),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
}).strict()

/** Stored workflow definition; the host assigns id and revision. */
export const workflowDefinitionSchema = z.object({
  version: z.literal(1),
  id: z.string().transform(brandString<WorkflowId>),
  name: z.string().min(1),
  revision: z.number().int().min(1),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
}).strict()

const timestampSchema = z.iso.datetime({ precision: 3 }).refine(
  value => !value.startsWith('0000-'),
  'timestamps must carry a real year',
)

/** One durable workflow record; the table key is the definition id. */
export const workflowRecordSchema = z.object({
  definition: workflowDefinitionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

/** Timing selectors a trigger may carry; exactly one is set (G11). */
export type TriggerTiming =
  | { readonly kind: 'cron', readonly expression: string, readonly timeZone: string }
  | { readonly kind: 'daily', readonly time: string, readonly timeZone: string }
  | { readonly kind: 'weekly', readonly time: string, readonly timeZone: string, readonly weekdays: readonly number[] }

/** One durable schedule trigger for a stored workflow (G11). */
export const triggerRecordSchema = z.object({
  id: z.string().min(1),
  workflowId: z.string().min(1).transform(brandString<WorkflowId>),
  timing: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('cron'),
      expression: z.string().min(1),
      timeZone: z.string().min(1),
    }),
    z.object({
      kind: z.literal('daily'),
      time: z.string().min(1),
      timeZone: z.string().min(1),
    }),
    z.object({
      kind: z.literal('weekly'),
      time: z.string().min(1),
      timeZone: z.string().min(1),
      weekdays: z.array(z.number().int().min(1).max(7)).min(1),
    }),
  ]),
  input: z.string(),
  tokenBudget: z.number().int().min(0).optional(),
  enabled: z.boolean(),
  /** Committed earliest unaccepted UTC target; recomputed on each fire. */
  scheduledAt: z.string().min(1),
  lastRunId: z.string().min(1).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

/** Stored trigger record; the table key is the trigger id. */
export type TriggerRecord = z.infer<typeof triggerRecordSchema>

/** Library identity; assigned by the host, distinct from node ids. */
export type AgentLibraryId = Branded<'AgentLibraryId'>

/**
 * One library agent: the reusable execution payload of an agent node. The
 * spec mirrors `AgentNodeSpec` minus node identity (`id`, `name`, `position`);
 * inserting into a workflow copies it onto a fresh node, keeping exported
 * workflow documents self-contained.
 */
export const agentLibrarySpecSchema = agentNodeSchema
  .omit({ id: true, name: true, position: true }) as z.ZodType<AgentLibrarySpec>

export interface AgentLibrarySpec {
  readonly kind: 'agent'
  readonly systemPrompt: string
  readonly provider?: string
  readonly model?: string
  readonly toolFilter?: { readonly allow?: readonly string[], readonly deny?: readonly string[] }
  readonly permissionPreset?: string
  readonly contextBudgetTokens?: number
  readonly retry: { maxAttempts: number, backoffMs: number, fallbackModel?: string }
  readonly timeoutMs?: number
  readonly hitlEnabled: boolean
}

/** One durable library-agent record; the table key is the agent id. */
export const agentLibraryRecordSchema = z.object({
  id: z.string().min(1).transform(brandString<AgentLibraryId>),
  name: z.string().min(1),
  spec: agentLibrarySpecSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

/** Storage domain: lowercase snake names per UNIT_NAME_RE. */
export const agentMultiDomain = defineDomain({
  name: 'agent_multi',
  version: 1,
  tables: {
    workflows: domainTable(workflowRecordSchema),
    agents: domainTable(agentLibraryRecordSchema),
    triggers: domainTable(triggerRecordSchema),
  },
})

/** Parsed draft as it enters semantic validation. */
export type ParsedWorkflowDraft = z.infer<typeof workflowDraftSchema>

/** Parsed stored record. */
export type WorkflowRecord = z.infer<typeof workflowRecordSchema>

/** Discriminated node union (single source of truth with the schema). */
export type NodeSpec = z.infer<typeof nodeSchema>

/** The agent variant of the node union — the only schedulable, prompt-driven node. */
export type AgentNodeSpec = Extract<NodeSpec, { kind: 'agent' }>

/** Edge between two nodes; carries the intermediate-layer contract (R4). */
export type EdgeSpec = z.infer<typeof edgeSchema>

/** Stored workflow; `revision` is the optimistic-concurrency counter. */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>

/** Editor payload: definition content without server-assigned identity. */
export type WorkflowDraft = z.infer<typeof workflowDraftSchema>
