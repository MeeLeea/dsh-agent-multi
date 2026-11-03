/**
 * Structural zod schemas for workflow drafts and stored records, plus the
 * storage-domain specification and the single source of truth for the value
 * types (re-exported from {@link ./types}). Semantic graph rules live in
 * validation.ts; this module enforces per-field shape and bounds so a
 * malformed record can never enter (or brick) the domain.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/domain
 */
import { brandString } from '@deepseek-ai/dsh-brand';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
/** Node ids double as template identifiers; keep them template-safe. */
const nodeIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const nodeBaseSchema = z.object({
    id: nodeIdSchema,
    name: z.string().min(1),
    /** Canvas placement the host preserves verbatim; absent for API-authored drafts. */
    position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
}).strict();
/**
 * Fields removed from agent nodes after earlier releases. Records saved
 * before a removal keep the field in storage; reads tolerate and drop it,
 * and the next save persists the record without it. Node agents inherit the
 * host defaults for each removed field (run-root route, full tool set,
 * untrimmed prompt, single attempt, no node timeout).
 */
const REMOVED_AGENT_FIELDS = ['provider', 'toolFilter', 'contextBudgetTokens', 'retry', 'timeoutMs'];
/**
 * Drop the removed agent-node fields before strict parsing. Records saved
 * before the removals keep them in storage; reads tolerate and drop them.
 */
function stripAgentNodeFields(nodes) {
    if (!Array.isArray(nodes))
        return nodes;
    return nodes.map(node => {
        if (typeof node !== 'object' || node === null)
            return node;
        const record = node;
        if (record.kind !== 'agent' || !REMOVED_AGENT_FIELDS.some(field => field in record))
            return node;
        const clone = { ...record };
        for (const field of REMOVED_AGENT_FIELDS)
            delete clone[field];
        return clone;
    });
}
/** Drop the removed fields from a library-agent spec before parsing. */
function stripSpecFields(spec) {
    if (typeof spec !== 'object' || spec === null)
        return spec;
    const record = spec;
    if (!REMOVED_AGENT_FIELDS.some(field => field in record))
        return spec;
    const clone = { ...record };
    for (const field of REMOVED_AGENT_FIELDS)
        delete clone[field];
    return clone;
}
const agentNodeSchema = nodeBaseSchema.extend({
    kind: z.literal('agent'),
    systemPrompt: z.string(),
    model: z.string().min(1).optional(),
    permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    hitlEnabled: z.boolean(),
}).strict();
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
]);
const edgeSchema = z.object({
    id: z.string().min(1),
    from: nodeIdSchema,
    fromHandle: z.string().min(1).optional(),
    to: nodeIdSchema,
    toHandle: z.literal('back').optional(),
    format: z.enum(['json', 'md', 'text']),
    template: z.string().optional(),
    inContext: z.boolean().default(true),
}).strict();
/** Nodes with the removed fields stripped on the way into the strict parse. */
const nodesSchema = z.preprocess(stripAgentNodeFields, z.array(nodeSchema));
/** Editor payload: definition content without server-assigned identity. */
export const workflowDraftSchema = z.object({
    name: z.string().min(1),
    nodes: nodesSchema,
    edges: z.array(edgeSchema),
}).strict();
/** Stored workflow definition; the host assigns id and revision. */
export const workflowDefinitionSchema = z.object({
    version: z.literal(1),
    id: z.string().transform((brandString)),
    name: z.string().min(1),
    revision: z.number().int().min(1),
    nodes: nodesSchema,
    edges: z.array(edgeSchema),
}).strict();
const timestampSchema = z.iso.datetime({ precision: 3 }).refine(value => !value.startsWith('0000-'), 'timestamps must carry a real year');
/** One durable workflow record; the table key is the definition id. */
export const workflowRecordSchema = z.object({
    definition: workflowDefinitionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
}).strict();
/** One durable schedule trigger for a stored workflow (G11). */
export const triggerRecordSchema = z.object({
    id: z.string().min(1),
    workflowId: z.string().min(1).transform((brandString)),
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
}).strict();
/**
 * One library agent: the reusable execution payload of an agent node. The
 * spec mirrors `AgentNodeSpec` minus node identity (`id`, `name`, `position`);
 * inserting into a workflow copies it onto a fresh node, keeping exported
 * workflow documents self-contained.
 */
export const agentLibrarySpecSchema = z.preprocess(stripSpecFields, agentNodeSchema.omit({ id: true, name: true, position: true }));
/** One durable library-agent record; the table key is the agent id. */
export const agentLibraryRecordSchema = z.object({
    id: z.string().min(1).transform((brandString)),
    name: z.string().min(1),
    spec: agentLibrarySpecSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
}).strict();
/** Storage domain: lowercase snake names per UNIT_NAME_RE. */
export const agentMultiDomain = defineDomain({
    name: 'agent_multi',
    version: 1,
    tables: {
        workflows: domainTable(workflowRecordSchema),
        agents: domainTable(agentLibraryRecordSchema),
        triggers: domainTable(triggerRecordSchema),
    },
});
