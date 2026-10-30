import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { SessionId } from "@deepseek-ai/dsh-session";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { brandString } from "@deepseek-ai/dsh-brand";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z as z$1 } from "zod";
import { Context, Service } from "@deepseek-ai/cordis";
import { HarnessError, createUserMessage } from "@deepseek-ai/dsh-llm";
import { ScheduleId, ScheduleInputError, createCronScheduleRecord, createDailyScheduleRecord, createWeeklyScheduleRecord, resolveRecurringOccurrence } from "@deepseek-ai/dsh-schedule";
//#region lib/types/domain.js
/**
* Structural zod schemas for workflow drafts and stored records, plus the
* storage-domain specification and the single source of truth for the value
* types (re-exported from {@link ./types}). Semantic graph rules live in
* validation.ts; this module enforces per-field shape and bounds so a
* malformed record can never enter (or brick) the domain.
* @module @deepseek-ai/dsh-experimental-agent-multi/src/domain
*/
/** Node ids double as template identifiers; keep them template-safe. */
const nodeIdSchema = z$1.string().regex(/^[A-Za-z0-9_-]+$/);
const retryPolicySchema = z$1.object({
	maxAttempts: z$1.number().int().min(1),
	backoffMs: z$1.number().int().min(0),
	fallbackModel: z$1.string().min(1).optional()
}).strict();
const toolFilterSchema = z$1.object({
	allow: z$1.array(z$1.string().min(1)).optional(),
	deny: z$1.array(z$1.string().min(1)).optional()
}).strict();
const nodeBaseSchema = z$1.object({
	id: nodeIdSchema,
	name: z$1.string().min(1),
	/** Canvas placement the host preserves verbatim; absent for API-authored drafts. */
	position: z$1.object({
		x: z$1.number(),
		y: z$1.number()
	}).strict().optional()
}).strict();
const agentNodeSchema = nodeBaseSchema.extend({
	kind: z$1.literal("agent"),
	systemPrompt: z$1.string(),
	provider: z$1.string().min(1).optional(),
	model: z$1.string().min(1).optional(),
	toolFilter: toolFilterSchema.optional(),
	permissionPreset: z$1.string().min(1).optional(),
	contextBudgetTokens: z$1.number().int().positive().optional(),
	retry: retryPolicySchema,
	timeoutMs: z$1.number().int().positive().optional(),
	hitlEnabled: z$1.boolean()
}).strict();
const nodeSchema = z$1.discriminatedUnion("kind", [
	nodeBaseSchema.extend({ kind: z$1.literal("input") }).strict(),
	agentNodeSchema,
	nodeBaseSchema.extend({
		kind: z$1.literal("router"),
		cases: z$1.array(z$1.string()).min(1)
	}).strict(),
	nodeBaseSchema.extend({
		kind: z$1.literal("join"),
		strategy: z$1.enum([
			"all",
			"any",
			"quorum"
		]),
		quorum: z$1.number().int().min(1).optional()
	}).strict(),
	nodeBaseSchema.extend({
		kind: z$1.literal("loop"),
		mode: z$1.enum([
			"items",
			"count",
			"while"
		]),
		itemsExpr: z$1.string().optional(),
		count: z$1.number().int().min(1).optional(),
		condition: z$1.string().optional(),
		maxIters: z$1.number().int().min(1),
		collect: z$1.boolean()
	}).strict(),
	nodeBaseSchema.extend({ kind: z$1.literal("output") }).strict(),
	nodeBaseSchema.extend({
		kind: z$1.literal("note"),
		text: z$1.string()
	}).strict()
]);
const edgeSchema = z$1.object({
	id: z$1.string().min(1),
	from: nodeIdSchema,
	fromHandle: z$1.string().min(1).optional(),
	to: nodeIdSchema,
	toHandle: z$1.literal("back").optional(),
	format: z$1.enum([
		"json",
		"md",
		"text"
	]),
	template: z$1.string().optional(),
	inContext: z$1.boolean().default(true)
}).strict();
/** Editor payload: definition content without server-assigned identity. */
const workflowDraftSchema = z$1.object({
	name: z$1.string().min(1),
	nodes: z$1.array(nodeSchema),
	edges: z$1.array(edgeSchema)
}).strict();
/** Stored workflow definition; the host assigns id and revision. */
const workflowDefinitionSchema = z$1.object({
	version: z$1.literal(1),
	id: z$1.string().transform(brandString),
	name: z$1.string().min(1),
	revision: z$1.number().int().min(1),
	nodes: z$1.array(nodeSchema),
	edges: z$1.array(edgeSchema)
}).strict();
const timestampSchema = z$1.iso.datetime({ precision: 3 }).refine((value) => !value.startsWith("0000-"), "timestamps must carry a real year");
/** One durable workflow record; the table key is the definition id. */
const workflowRecordSchema = z$1.object({
	definition: workflowDefinitionSchema,
	createdAt: timestampSchema,
	updatedAt: timestampSchema
}).strict();
/** One durable schedule trigger for a stored workflow (G11). */
const triggerRecordSchema = z$1.object({
	id: z$1.string().min(1),
	workflowId: z$1.string().min(1).transform(brandString),
	timing: z$1.discriminatedUnion("kind", [
		z$1.object({
			kind: z$1.literal("cron"),
			expression: z$1.string().min(1),
			timeZone: z$1.string().min(1)
		}),
		z$1.object({
			kind: z$1.literal("daily"),
			time: z$1.string().min(1),
			timeZone: z$1.string().min(1)
		}),
		z$1.object({
			kind: z$1.literal("weekly"),
			time: z$1.string().min(1),
			timeZone: z$1.string().min(1),
			weekdays: z$1.array(z$1.number().int().min(1).max(7)).min(1)
		})
	]),
	input: z$1.string(),
	tokenBudget: z$1.number().int().min(0).optional(),
	enabled: z$1.boolean(),
	/** Committed earliest unaccepted UTC target; recomputed on each fire. */
	scheduledAt: z$1.string().min(1),
	lastRunId: z$1.string().min(1).optional(),
	createdAt: timestampSchema,
	updatedAt: timestampSchema
}).strict();
/**
* One library agent: the reusable execution payload of an agent node. The
* spec mirrors `AgentNodeSpec` minus node identity (`id`, `name`, `position`);
* inserting into a workflow copies it onto a fresh node, keeping exported
* workflow documents self-contained.
*/
const agentLibrarySpecSchema = agentNodeSchema.omit({
	id: true,
	name: true,
	position: true
});
/** One durable library-agent record; the table key is the agent id. */
const agentLibraryRecordSchema = z$1.object({
	id: z$1.string().min(1).transform(brandString),
	name: z$1.string().min(1),
	spec: agentLibrarySpecSchema,
	createdAt: timestampSchema,
	updatedAt: timestampSchema
}).strict();
/** Storage domain: lowercase snake names per UNIT_NAME_RE. */
const agentMultiDomain = defineDomain({
	name: "agent_multi",
	version: 1,
	tables: {
		workflows: domainTable(workflowRecordSchema),
		agents: domainTable(agentLibraryRecordSchema),
		triggers: domainTable(triggerRecordSchema)
	}
});
//#endregion
//#region lib/types/contract.js
/**
* Wire contracts shared by the host controller, the remote client, and the
* tests: validation issue vocabulary, request and result interfaces, and the
* template reference grammar.
* @module @deepseek-ai/dsh-experimental-agent-multi/src/contract
*/
/** Matches `{{nodes.<id>}}` template references (any spacing inside braces). */
const TEMPLATE_NODE_REF_RE = /\{\{\s*nodes\.([A-Za-z0-9_-]+)\s*\}\}/g;
//#endregion
//#region lib/types/validation.js
/**
* Semantic graph validation for workflow drafts. Structural shape and
* per-field bounds live in the zod domain schema; this module owns the graph
* rules: endpoint references, handle completeness, degree legality, guarded
* cycles, and template references.
* @module @deepseek-ai/dsh-experimental-agent-multi/src/validation
*/
/**
* Validate a workflow draft against the semantic graph rules. Pure: no
* context, no storage, no exceptions. Returns every issue found so the
* inspector can surface the full rejection matrix at once.
* @param draft - Draft to validate.
* @returns issues in no guaranteed order; empty means the draft is runnable.
*/
function validateWorkflow(draft) {
	const issues = [];
	const nodes = new Map(draft.nodes.map((node) => [node.id, node]));
	const nodeIds = new Set(nodes.keys());
	if (draft.name.trim().length === 0) issues.push({
		code: "name-empty",
		message: "workflow name must not be blank"
	});
	for (const node of draft.nodes) if (!NODE_ID_RE.test(node.id)) issues.push({
		code: "node-id-invalid",
		message: `node id '${node.id}' must match [A-Za-z0-9_-]+`,
		nodeId: node.id
	});
	issueDuplicateIds(draft, issues);
	const edges = draft.edges;
	const outEdges = /* @__PURE__ */ new Map();
	const inEdges = /* @__PURE__ */ new Map();
	for (const edge of edges) {
		if (edge.from === edge.to) issues.push({
			code: "edge-self",
			message: `edge '${edge.id}' connects node '${edge.from}' to itself`,
			edgeId: edge.id,
			nodeId: edge.from
		});
		const from = nodes.get(edge.from);
		const to = nodes.get(edge.to);
		if (from === void 0) issues.push({
			code: "edge-endpoint-unknown",
			message: `edge '${edge.id}' starts at unknown node '${edge.from}'`,
			edgeId: edge.id
		});
		if (to === void 0) issues.push({
			code: "edge-endpoint-unknown",
			message: `edge '${edge.id}' ends at unknown node '${edge.to}'`,
			edgeId: edge.id
		});
		if (from === void 0 || to === void 0) continue;
		if (from.kind === "note" || to.kind === "note") {
			issues.push({
				code: "edge-note",
				message: `edge '${edge.id}' touches note node '${from.kind === "note" ? from.id : to.id}'; notes never connect`,
				edgeId: edge.id
			});
			continue;
		}
		push(outEdges, edge.from, edge);
		push(inEdges, edge.to, edge);
		issueHandleLegality(edge, from, to, issues);
	}
	issueEndpointDegrees(draft, inEdges, outEdges, issues);
	issueRouterCases(draft, outEdges, issues);
	issueLoops(draft, inEdges, outEdges, issues);
	issueJoins(draft, inEdges, issues);
	issueUnguardedCycles(draft, inEdges, outEdges, issues);
	issueTemplates(draft, nodeIds, issues);
	return issues;
}
/** Node ids double as template identifiers, so restrict to a closed set. */
const NODE_ID_RE = /^[A-Za-z0-9_-]+$/;
function push(map, key, edge) {
	const list = map.get(key);
	if (list === void 0) map.set(key, [edge]);
	else list.push(edge);
}
function issueDuplicateIds(draft, issues) {
	const nodeIds = /* @__PURE__ */ new Set();
	for (const node of draft.nodes) {
		if (nodeIds.has(node.id)) issues.push({
			code: "node-id-duplicate",
			message: `duplicate node id '${node.id}'`,
			nodeId: node.id
		});
		nodeIds.add(node.id);
	}
	const edgeIds = /* @__PURE__ */ new Set();
	for (const edge of draft.edges) {
		if (edgeIds.has(edge.id)) issues.push({
			code: "edge-id-duplicate",
			message: `duplicate edge id '${edge.id}'`,
			edgeId: edge.id
		});
		edgeIds.add(edge.id);
	}
}
function issueHandleLegality(edge, from, to, issues) {
	if (from.kind === "router") {
		if (edge.fromHandle === void 0) issues.push({
			code: "router-handle-missing",
			message: `router out-edge '${edge.id}' must declare fromHandle (a case name or 'default')`,
			edgeId: edge.id,
			nodeId: from.id
		});
		else if (edge.fromHandle !== "default" && !from.cases.includes(edge.fromHandle)) issues.push({
			code: "router-handle-unknown",
			message: `edge '${edge.id}' uses fromHandle '${edge.fromHandle}' which is neither a declared case nor 'default'`,
			edgeId: edge.id,
			nodeId: from.id,
			handle: edge.fromHandle
		});
	} else if (from.kind === "loop") {
		if (edge.fromHandle !== "iterate" && edge.fromHandle !== "done") issues.push({
			code: "loop-handle-unknown",
			message: `loop out-edge '${edge.id}' must use fromHandle 'iterate' or 'done'`,
			edgeId: edge.id,
			nodeId: from.id
		});
	} else if (edge.fromHandle !== void 0) issues.push({
		code: "edge-handle-unexpected",
		message: `edge '${edge.id}' declares fromHandle '${edge.fromHandle}' but its source node has no handles`,
		edgeId: edge.id,
		nodeId: from.id
	});
	if (edge.toHandle !== void 0) {
		if (edge.toHandle !== "back" || to.kind !== "loop") issues.push({
			code: "edge-tohandle-invalid",
			message: `edge '${edge.id}' declares toHandle '${edge.toHandle ?? ""}'; only 'back' into a loop node is valid`,
			edgeId: edge.id,
			nodeId: to.id
		});
	}
}
function issueEndpointDegrees(draft, inEdges, outEdges, issues) {
	const inputs = draft.nodes.filter((node) => node.kind === "input");
	const outputs = draft.nodes.filter((node) => node.kind === "output");
	if (inputs.length !== 1) issues.push({
		code: "input-count",
		message: `expected exactly one input node, found ${inputs.length}`
	});
	if (outputs.length === 0) issues.push({
		code: "output-count",
		message: "workflow needs at least one output node"
	});
	for (const node of inputs) if ((inEdges.get(node.id) ?? []).length > 0) issues.push({
		code: "input-indegree",
		message: `input node '${node.id}' must not have incoming edges`,
		nodeId: node.id
	});
	for (const node of outputs) if ((outEdges.get(node.id) ?? []).length > 0) issues.push({
		code: "output-outdegree",
		message: `output node '${node.id}' must not have outgoing edges`,
		nodeId: node.id
	});
}
function issueRouterCases(draft, outEdges, issues) {
	for (const node of draft.nodes) {
		if (node.kind !== "router") continue;
		if (node.cases.length === 0) issues.push({
			code: "router-cases-empty",
			message: `router node '${node.id}' declares no cases`,
			nodeId: node.id
		});
		const seen = /* @__PURE__ */ new Set();
		for (const name of node.cases) {
			if (name.trim().length === 0) issues.push({
				code: "router-case-blank",
				message: `router node '${node.id}' declares a blank case name`,
				nodeId: node.id,
				handle: name
			});
			if (seen.has(name)) {
				issues.push({
					code: "router-case-duplicate",
					message: `router node '${node.id}' declares case '${name}' more than once`,
					nodeId: node.id,
					handle: name
				});
				continue;
			}
			seen.add(name);
		}
		const wired = new Set((outEdges.get(node.id) ?? []).map((edge) => edge.fromHandle));
		for (const name of node.cases) if (!wired.has(name)) issues.push({
			code: "router-case-unwired",
			message: `router case '${name}' on node '${node.id}' has no outgoing edge`,
			nodeId: node.id,
			handle: name
		});
	}
}
function issueLoops(draft, inEdges, outEdges, issues) {
	for (const node of draft.nodes) {
		if (node.kind !== "loop") continue;
		const out = outEdges.get(node.id) ?? [];
		const handles = new Set(out.map((edge) => edge.fromHandle));
		if (!handles.has("iterate")) issues.push({
			code: "loop-handle-missing",
			message: `loop node '${node.id}' lacks an 'iterate' out-edge`,
			nodeId: node.id,
			handle: "iterate"
		});
		if (!handles.has("done")) issues.push({
			code: "loop-handle-missing",
			message: `loop node '${node.id}' lacks a 'done' out-edge`,
			nodeId: node.id,
			handle: "done"
		});
		if ((inEdges.get(node.id) ?? []).filter((edge) => edge.toHandle === "back").length === 0) issues.push({
			code: "loop-handle-missing",
			message: `loop node '${node.id}' has no 'back' in-edge from its body`,
			nodeId: node.id,
			handle: "back"
		});
		if (node.mode === "items" && (node.itemsExpr ?? "").trim().length === 0) issues.push({
			code: "loop-params",
			message: `loop node '${node.id}' in items mode requires itemsExpr`,
			nodeId: node.id
		});
		if (node.mode === "count" && node.count === void 0) issues.push({
			code: "loop-params",
			message: `loop node '${node.id}' in count mode requires count`,
			nodeId: node.id
		});
		if (node.mode === "while" && (node.condition ?? "").trim().length === 0) issues.push({
			code: "loop-params",
			message: `loop node '${node.id}' in while mode requires condition`,
			nodeId: node.id
		});
	}
}
function issueJoins(draft, inEdges, issues) {
	for (const node of draft.nodes) {
		if (node.kind !== "join") continue;
		const inDegree = (inEdges.get(node.id) ?? []).length;
		if (inDegree < 2) issues.push({
			code: "join-indegree",
			message: `join node '${node.id}' needs at least two incoming edges, found ${inDegree}`,
			nodeId: node.id
		});
		if (node.strategy === "quorum") {
			if (node.quorum === void 0 || node.quorum < 1 || node.quorum > inDegree) issues.push({
				code: "join-quorum-range",
				message: `join node '${node.id}' quorum must be between 1 and its in-degree (${inDegree})`,
				nodeId: node.id
			});
		}
	}
}
/**
* A cycle is legal only when it returns through a loop node's `back` edge.
* Removing every back edge must therefore leave a DAG: run Kahn's algorithm
* over the remaining graph and report the nodes a topological order cannot
* reach.
*/
function issueUnguardedCycles(draft, inEdges, outEdges, issues) {
	const indegree = /* @__PURE__ */ new Map();
	for (const node of draft.nodes) if (node.kind !== "note") indegree.set(node.id, 0);
	for (const [target, edges] of inEdges) {
		if (!indegree.has(target)) continue;
		for (const edge of edges) if (edge.toHandle !== "back") indegree.set(target, (indegree.get(target) ?? 0) + 1);
	}
	const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
	const order = [];
	while (queue.length > 0) {
		const id = queue.shift();
		if (id === void 0) break;
		order.push(id);
		for (const edge of outEdges.get(id) ?? []) {
			if (edge.toHandle === "back") continue;
			const next = (indegree.get(edge.to) ?? 0) - 1;
			indegree.set(edge.to, next);
			if (next === 0) queue.push(edge.to);
		}
	}
	if (order.length < indegree.size) {
		const stuck = [...indegree].filter(([, degree]) => (degree ?? 0) > 0).map(([id]) => id);
		issues.push({
			code: "cycle-illegal",
			message: `cycle outside any loop node passes through: ${stuck.join(", ")}; route it through a loop node's back edge`
		});
	}
}
function issueTemplates(draft, nodeIds, issues) {
	for (const edge of draft.edges) {
		if (edge.template === void 0) continue;
		for (const ref of edge.template.matchAll(TEMPLATE_NODE_REF_RE)) {
			const id = ref[1];
			if (id === void 0) continue;
			if (!nodeIds.has(id)) issues.push({
				code: "template-node-unknown",
				message: `edge '${edge.id}' template references unknown node '{{nodes.${id}}}'`,
				edgeId: edge.id,
				nodeId: id
			});
		}
	}
}
//#endregion
//#region lib/types/projection.js
/**
* agent-multi run state projected incrementally from the run Session's
* agent-multi journal events. One run Session belongs to exactly one run
* (resume reuses both), so the state holds at most one run; the wire view is
* the kanban/canvas shape: per-node status, streaming output, HITL state,
* and the terminal failure derived from node errors.
*/
const nonNegativeSafeInteger = z$1.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const runIdSchema = z$1.string().min(1).transform((value) => brandString(value));
/** Cap on the accumulated streaming preview of one running node. */
const MAX_STREAM_CHARS = 2e4;
const nodeViewSchema = z$1.object({
	nodeId: z$1.string().min(1),
	nodeKind: z$1.string(),
	status: z$1.enum([
		"running",
		"completed",
		"failed"
	]),
	attempt: nonNegativeSafeInteger,
	prompt: z$1.string().optional(),
	streaming: z$1.string().optional(),
	output: z$1.string().optional(),
	payload: z$1.string().optional(),
	stopReason: z$1.enum([
		"completed",
		"aborted",
		"error",
		"max-tokens",
		"refusal"
	]).optional(),
	errorClass: z$1.enum([
		"transient",
		"timeout",
		"deterministic",
		"auth"
	]).optional(),
	message: z$1.string().optional(),
	attempts: nonNegativeSafeInteger.optional(),
	durationMs: nonNegativeSafeInteger.optional(),
	usage: z$1.object({
		inputTokens: nonNegativeSafeInteger,
		outputTokens: nonNegativeSafeInteger,
		cacheReadTokens: nonNegativeSafeInteger,
		cacheWriteTokens: nonNegativeSafeInteger
	}).strict().optional()
}).strict();
const hitlViewSchema = z$1.object({
	nodeId: z$1.string().min(1),
	question: z$1.string(),
	answer: z$1.string().optional()
}).strict();
const runStateSchema = z$1.object({
	runId: runIdSchema,
	workflowId: z$1.string().min(1).transform(brandString),
	workflowRevision: nonNegativeSafeInteger,
	input: z$1.string(),
	status: z$1.enum([
		"running",
		"paused",
		"completed",
		"failed",
		"cancelled"
	]),
	nodes: z$1.record(z$1.string(), nodeViewSchema),
	hitl: hitlViewSchema.optional(),
	pauseReason: z$1.enum([
		"breakpoint",
		"hitl",
		"process-restart"
	]).optional(),
	totalDurationMs: nonNegativeSafeInteger.optional()
}).strict();
const runProjectionStateSchema = z$1.object({
	run: runStateSchema.optional(),
	failure: z$1.string().optional()
}).strict();
/**
* Test whether a Session event belongs to the agent-multi domain.
* @param event - candidate Session event.
* @returns whether the event has an agent-multi-owned type.
*/
function isAgentMultiEvent(event) {
	return event.type.startsWith("agent-multi/");
}
/** Decode one persisted agent-multi payload, retaining the schema failure as cause. */
function parsePersisted(type, schema, value) {
	try {
		return schema.parse(value);
	} catch (error) {
		throw new Error(`persisted agent-multi ${type} payload is invalid`, { cause: error });
	}
}
const runStartSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	workflowId: z$1.string().min(1),
	workflowRevision: nonNegativeSafeInteger,
	input: z$1.string()
}).strict();
const selectorSchema = z$1.object({
	version: nonNegativeSafeInteger,
	runId: runIdSchema
}).loose();
const nodeStartSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	nodeId: z$1.string().min(1),
	nodeKind: z$1.string(),
	attempt: nonNegativeSafeInteger
}).strict();
const nodeInputSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	nodeId: z$1.string().min(1),
	attempt: nonNegativeSafeInteger,
	prompt: z$1.string()
}).strict();
const nodeDeltaSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	nodeId: z$1.string().min(1),
	attempt: nonNegativeSafeInteger,
	delta: z$1.string()
}).strict();
const nodeEndSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	nodeId: z$1.string().min(1),
	attempt: nonNegativeSafeInteger,
	output: z$1.string(),
	payload: z$1.string(),
	stopReason: z$1.enum([
		"completed",
		"aborted",
		"error",
		"max-tokens",
		"refusal"
	]),
	durationMs: nonNegativeSafeInteger,
	usage: z$1.object({
		inputTokens: nonNegativeSafeInteger,
		outputTokens: nonNegativeSafeInteger,
		cacheReadTokens: nonNegativeSafeInteger,
		cacheWriteTokens: nonNegativeSafeInteger
	}).strict().optional()
}).strict();
const nodeErrorSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	nodeId: z$1.string().min(1),
	attempt: nonNegativeSafeInteger,
	errorClass: z$1.enum([
		"transient",
		"timeout",
		"deterministic",
		"auth"
	]),
	message: z$1.string(),
	attempts: nonNegativeSafeInteger
}).strict();
const hitlAskedSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	nodeId: z$1.string().min(1),
	question: z$1.string()
}).strict();
const hitlAnsweredSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	nodeId: z$1.string().min(1),
	answer: z$1.string()
}).strict();
const runPausedSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	reason: z$1.enum([
		"breakpoint",
		"hitl",
		"process-restart"
	]),
	nodeId: z$1.string().min(1).optional()
}).strict();
const runEndSchema = z$1.object({
	version: z$1.literal(1),
	runId: runIdSchema,
	outcome: z$1.enum([
		"completed",
		"failed",
		"cancelled"
	]),
	totalDurationMs: nonNegativeSafeInteger
}).strict();
function applyProjectionEvent(state, event) {
	if (state.failure !== void 0) return state;
	if (!isAgentMultiEvent(event)) return state;
	try {
		if (event.type === "agent-multi/run-start") {
			const data = parsePersisted(event.type, runStartSchema, event.data);
			if (state.run === void 0) return { run: {
				runId: data.runId,
				workflowId: brandString(data.workflowId),
				workflowRevision: data.workflowRevision,
				input: data.input,
				status: "running",
				nodes: {}
			} };
			if (state.run.runId === data.runId) return state;
			throw new Error(`run Session received a second run ${data.runId} after ${state.run.runId}`);
		}
		const payload = parsePersisted(event.type, selectorSchema, event.data);
		if (state.run === void 0) throw new Error(`agent-multi ${event.type} arrived before run-start`);
		if (payload.runId !== state.run.runId) return state;
		if (payload.version !== 1) throw new Error(`unsupported agent-multi event version ${String(payload.version)}`);
		return { run: applyRunEvent(state.run, event) };
	} catch (error) {
		return {
			...state,
			failure: error instanceof Error ? error.message : String(error)
		};
	}
}
function applyRunEvent(state, event) {
	switch (event.type) {
		case "agent-multi/node-start": {
			const data = parsePersisted(event.type, nodeStartSchema, event.data);
			const prior = state.nodes[data.nodeId];
			if (prior !== void 0 && prior.status === "completed") throw new Error(`node "${data.nodeId}" restarted after completion`);
			const node = {
				nodeId: data.nodeId,
				nodeKind: data.nodeKind,
				status: "running",
				attempt: data.attempt,
				...prior?.prompt === void 0 ? {} : { prompt: prior.prompt }
			};
			return {
				...state,
				nodes: {
					...state.nodes,
					[data.nodeId]: node
				}
			};
		}
		case "agent-multi/node-input": {
			const data = parsePersisted(event.type, nodeInputSchema, event.data);
			return patchNode(state, data.nodeId, (node) => ({
				...node,
				prompt: data.prompt
			}));
		}
		case "agent-multi/node-delta": {
			const data = parsePersisted(event.type, nodeDeltaSchema, event.data);
			return patchNode(state, data.nodeId, (node) => {
				const accumulated = (node.streaming ?? "") + data.delta;
				return {
					...node,
					streaming: accumulated.length > MAX_STREAM_CHARS ? accumulated.slice(-2e4) : accumulated
				};
			});
		}
		case "agent-multi/node-end": {
			const data = parsePersisted(event.type, nodeEndSchema, event.data);
			return patchNode(state, data.nodeId, (node) => ({
				...node,
				status: "completed",
				output: data.output,
				payload: data.payload,
				stopReason: data.stopReason,
				durationMs: data.durationMs,
				...data.usage !== void 0 ? { usage: data.usage } : {}
			}));
		}
		case "agent-multi/node-error": {
			const data = parsePersisted(event.type, nodeErrorSchema, event.data);
			return patchNode(state, data.nodeId, (node) => ({
				...node,
				status: "failed",
				errorClass: data.errorClass,
				message: data.message,
				attempts: data.attempts
			}));
		}
		case "agent-multi/hitl-asked": {
			const data = parsePersisted(event.type, hitlAskedSchema, event.data);
			if (state.hitl !== void 0 && state.hitl.nodeId !== data.nodeId) throw new Error(`node "${data.nodeId}" asked while node "${state.hitl.nodeId}" question is open`);
			return {
				...state,
				hitl: {
					nodeId: data.nodeId,
					question: data.question
				}
			};
		}
		case "agent-multi/hitl-answered": {
			const data = parsePersisted(event.type, hitlAnsweredSchema, event.data);
			if (state.hitl === void 0 || state.hitl.nodeId !== data.nodeId) throw new Error(`hitl answer for node "${data.nodeId}" has no open question`);
			return {
				...state,
				hitl: {
					...state.hitl,
					answer: data.answer
				}
			};
		}
		case "agent-multi/run-paused": {
			const data = parsePersisted(event.type, runPausedSchema, event.data);
			return {
				...state,
				status: "paused",
				pauseReason: data.reason
			};
		}
		case "agent-multi/run-resumed": {
			const { pauseReason: _drop, ...rest } = state;
			return {
				...rest,
				status: "running"
			};
		}
		case "agent-multi/run-end": {
			const data = parsePersisted(event.type, runEndSchema, event.data);
			return {
				...state,
				status: data.outcome,
				totalDurationMs: data.totalDurationMs
			};
		}
		case "agent-multi/run-cancelled": return {
			...state,
			status: "cancelled"
		};
		/* v8 ignore next 2 -- AgentMultiEventType is closed and every member is handled above. */
		default: return state;
	}
}
/** Replace one node entry; a node event before node-start is a journal order violation. */
function patchNode(state, nodeId, patch) {
	const prior = state.nodes[nodeId];
	if (prior === void 0) throw new Error(`agent-multi node event for "${nodeId}" arrived before node-start`);
	return {
		...state,
		nodes: {
			...state.nodes,
			[nodeId]: patch(prior)
		}
	};
}
const runStartedViewSchema = z$1.object({
	started: z$1.literal(true),
	runId: z$1.string().min(1),
	workflowId: z$1.string().min(1).transform(brandString),
	status: z$1.enum([
		"running",
		"paused",
		"completed",
		"failed",
		"cancelled"
	]),
	nodes: z$1.array(nodeViewSchema),
	hitl: hitlViewSchema.optional(),
	totalDurationMs: nonNegativeSafeInteger.optional()
}).strict();
const runViewSchema = z$1.union([runStartedViewSchema, z$1.object({ started: z$1.literal(false) }).strict()]);
/** Client views memoized on the state reference they were derived from. */
const runViews = /* @__PURE__ */ new WeakMap();
function buildRunView(state) {
	const run = state.run;
	if (run === void 0) return { started: false };
	return {
		started: true,
		runId: run.runId,
		workflowId: run.workflowId,
		status: run.status,
		nodes: Object.values(run.nodes),
		...run.hitl === void 0 ? {} : { hitl: run.hitl },
		...run.totalDurationMs === void 0 ? {} : { totalDurationMs: run.totalDurationMs }
	};
}
/**
* Wire view of the projected run. The same state reference reuses the same
* view reference, so unchanged state publishes nothing; a projection failure
* also keeps the last derived view.
* @param state - current projection state.
* @returns the run kanban view.
*/
function runView(state) {
	const prior = runViews.get(state);
	if (prior !== void 0) return prior;
	const view = buildRunView(state);
	runViews.set(state, view);
	return view;
}
/** Empty state before the run Session's first agent-multi event. */
const EMPTY_STATE = Object.freeze({});
/** agent-multi run projection; the run Session owns exactly one run. */
const agentMultiProjectionDefinition = {
	key: "agentMulti",
	stateVersion: 1,
	stateSchema: runProjectionStateSchema,
	init: () => EMPTY_STATE,
	apply: applyProjectionEvent,
	wire: {
		viewSchema: runViewSchema,
		view: runView
	}
};
//#endregion
//#region lib/types/engine/format.js
const TEXT_BLOCK_TYPE$1 = "text";
/** Concatenate the text content of text blocks; non-text blocks contribute nothing in v1. */
function textOf$1(blocks) {
	return blocks.filter((block) => block.type === TEXT_BLOCK_TYPE$1).map((block) => block.text).join("");
}
/**
* Render a node's output as the intermediate payload for an edge of the given format.
*
* - `text`: the raw text content.
* - `md`: the raw text content (the node's output is already authored markdown).
* - `json`: when the text content is valid JSON, return it pretty-printed so the
*   downstream node receives structured data; otherwise wrap the text in an object.
*/
function renderNodeOutput(output, format) {
	const text = textOf$1(output);
	if (format === "json") try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return JSON.stringify({ text }, null, 2);
	}
	return text;
}
/**
* Apply an edge template to a rendered predecessor payload.
*
* Substitutions:
* - `{{output}}` → the rendered predecessor payload for this edge.
* - `{{nodes.<id>}}` → the text-formatted payload of any node in the ledger.
*
* Without a template the caller uses the rendered payload verbatim.
*/
function applyEdgeTemplate(template, currentOutput, ledger) {
	return template.replaceAll("{{output}}", currentOutput).replace(TEMPLATE_NODE_REF_RE, (match, id) => {
		if (id === void 0) return match;
		const output = ledger.get(id);
		if (output === void 0) return match;
		return renderNodeOutput(output, "text");
	});
}
/** Rough token estimate: ~4 characters per token. Sufficient for budget gating. */
function estimateTokens(text) {
	return Math.ceil(text.length / 4);
}
/**
* Trim an assembled prompt body to a token budget, dropping predecessor sections
* from the end (lowest priority) before the user input or system prompt.
*
* Returns the surviving body text and whether any section was dropped.
*/
function trimToBudget(systemPrompt, userInput, predecessorSections, budgetTokens) {
	const head = systemPrompt.length > 0 ? `${systemPrompt}\n\n---\n\n` : "";
	const userSection = `## User Input\n${userInput}`;
	const keep = [];
	let tokens = estimateTokens(head) + estimateTokens(userSection);
	let trimmed = false;
	for (const section of predecessorSections) {
		const block = `${section.label}\n${section.body}`;
		if (budgetTokens !== void 0 && tokens + estimateTokens(block) > budgetTokens) {
			trimmed = true;
			continue;
		}
		tokens += estimateTokens(block);
		keep.push(block);
	}
	return {
		text: `${head}${[userSection, ...keep].join("\n\n")}`,
		trimmed
	};
}
/**
* Assemble the prompt blocks for an agent node from its direct predecessors and
* the user input, applying edge formats, templates, and the context budget.
*
* Direct predecessors are rendered in edge order. An edge with `inContext: false`
* contributes nothing to the prompt but still records its payload in the ledger.
*/
function assembleAgentPrompt(node, inEdges, ledger, userInput) {
	const predecessorSections = [];
	for (const edge of inEdges) {
		if (!edge.inContext) continue;
		const output = ledger.get(edge.from);
		if (output === void 0) continue;
		const rendered = renderNodeOutput(output, edge.format);
		const body = edge.template !== void 0 ? applyEdgeTemplate(edge.template, rendered, ledger) : rendered;
		predecessorSections.push({
			label: `## ${edge.from} (${edge.format})`,
			body
		});
	}
	const { text } = trimToBudget(node.systemPrompt, userInput, predecessorSections, node.contextBudgetTokens);
	return [{
		type: "text",
		text
	}];
}
//#endregion
//#region lib/types/engine/executor.js
/**
* Per-node execution for agent-multi runs.
*
* Assembles the node prompt from the global ledger, runs a fresh subagent
* activation per attempt under the run root, retries transient and timeout
* failures (with optional fallback model), and journals every attempt to the
* run session. The run root is the parent of every activation; attempts are
* fresh activations with prior failure feedback folded into the retry prompt.
*/
/** Journal writer bound to the run session; every append is flushed durably. */
var RunJournal = class {
	ctx;
	session;
	constructor(ctx, session) {
		this.ctx = ctx;
		this.session = session;
	}
	/** Append one event and flush the session to durable storage. */
	async append(type, data) {
		this.session.append.bind(this.session)(type, data);
		await this.ctx.sessions.flush(this.session);
	}
};
/** Classify a settled subagent result into the retry decision vocabulary. */
function classifyStopReason(result, timedOut) {
	switch (result.stopReason) {
		case "error": return "transient";
		case "aborted": return timedOut ? "timeout" : "cancelled";
		case "max-tokens":
		case "refusal": return "deterministic";
		default: return "deterministic";
	}
}
/** Abort-aware backoff between retry attempts. */
function sleepBackoff(ms, signal) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}
/** Whether an error thrown by `startActivation` is retryable capacity trouble. */
function isTransientActivationError(error) {
	return error instanceof Error && /ACTIVATION_LIMIT_REACHED|capacity/i.test(error.message);
}
/**
* Fold one child's `assistant/message` usage into per-node accounting.
* The observer detaches with the activation; usage on abort- or error-settled
* attempts is retained so a retried node reports what its calls consumed.
* @param ctx - controller context seeing every child session event.
* @param childId - reserved local child session identity.
* @param activation - the managed child execution whose events are folded.
* @returns the accumulated usage once the result settles, absent when no
*   model call reported token accounting.
*/
function observeChildUsage(ctx, childId, activation) {
	const acc = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		any: false
	};
	const dispose = ctx.on("session/event", (session, event) => {
		if (session.id !== childId || event.type !== "assistant/message") return;
		const usage = event.data.usage;
		if (usage === void 0) return;
		acc.any = true;
		acc.inputTokens += usage.inputTokens;
		acc.outputTokens += usage.outputTokens;
		acc.cacheReadTokens += usage.cacheReadTokens ?? 0;
		acc.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
	});
	activation.result.finally(() => dispose());
	return acc;
}
/** Usage read out of a settled accumulator, absent when nothing reported usage. */
function readUsage(acc) {
	return acc.any ? {
		inputTokens: acc.inputTokens,
		outputTokens: acc.outputTokens,
		cacheReadTokens: acc.cacheReadTokens,
		cacheWriteTokens: acc.cacheWriteTokens
	} : void 0;
}
/**
* Run one agent node to a terminal outcome: success, exhausted retries, or
* non-retryable failure. Every attempt is journaled.
*/
async function executeAgentNode(deps, node, inEdges) {
	const started = Date.now();
	let attempt = 1;
	let promptBlocks = assembleAgentPrompt(node, inEdges, deps.ledger, deps.userInput);
	await deps.journal.append("agent-multi/node-start", {
		version: 1,
		runId: deps.runId,
		nodeId: node.id,
		nodeKind: node.kind,
		attempt
	});
	await deps.journal.append("agent-multi/node-input", {
		version: 1,
		runId: deps.runId,
		nodeId: node.id,
		attempt,
		prompt: textOf$1(promptBlocks)
	});
	while (true) {
		if (deps.signal.aborted) return {
			ok: false,
			errorClass: "transient",
			message: "run cancelled before attempt",
			attempts: attempt - 1
		};
		let timedOut = false;
		let fireAbort;
		const abortTrigger = new Promise((resolve) => {
			fireAbort = () => resolve("abort");
			if (deps.signal.aborted) fireAbort();
			else deps.signal.addEventListener("abort", fireAbort, { once: true });
		});
		const timer = node.timeoutMs === void 0 ? void 0 : setTimeout(() => {
			timedOut = true;
			fireAbort?.();
		}, node.timeoutMs);
		try {
			const useModel = attempt > 1 && node.retry.fallbackModel !== void 0 ? node.retry.fallbackModel : node.model;
			const restriction = toToolRestriction(node.toolFilter);
			const childId = SessionId(randomUUID());
			if (node.hitlEnabled) deps.hitlChildren.add(childId);
			deps.nodeOf.set(childId, node.id);
			const activation = await deps.ctx.subagents.startActivation({
				provider: "spawn",
				label: `${node.name} (attempt ${attempt})`,
				childId,
				request: {
					prompt: promptBlocks,
					parent: deps.runRoot,
					agentOptions: {
						...node.provider !== void 0 ? { provider: node.provider } : {},
						...useModel !== void 0 ? { model: useModel } : {}
					},
					...restriction !== void 0 ? { toolFilter: restriction } : {}
				},
				signal: deps.signal,
				delivery: "caller"
			});
			const usage = observeChildUsage(deps.ctx, childId, activation);
			if (await Promise.race([activation.result.then(() => "result"), abortTrigger]) === "abort") await activation.dispose();
			const result = await activation.result;
			const nodeUsage = readUsage(usage);
			if (nodeUsage !== void 0) deps.onNodeUsage?.(nodeUsage);
			if (result.stopReason === "completed") {
				const text = textOf$1(result.output);
				await deps.journal.append("agent-multi/node-delta", {
					version: 1,
					runId: deps.runId,
					nodeId: node.id,
					attempt,
					delta: text
				});
				await deps.journal.append("agent-multi/node-end", {
					version: 1,
					runId: deps.runId,
					nodeId: node.id,
					attempt,
					output: text,
					payload: text,
					stopReason: "completed",
					durationMs: Date.now() - started,
					...nodeUsage !== void 0 ? { usage: nodeUsage } : {}
				});
				return {
					ok: true,
					output: result.output
				};
			}
			const classification = classifyStopReason(result, timedOut);
			if (classification === "cancelled") return {
				ok: false,
				errorClass: "transient",
				message: "run cancelled during attempt",
				attempts: attempt
			};
			const message = result.diagnostic ?? `stop reason: ${result.stopReason}`;
			await deps.journal.append("agent-multi/node-error", {
				version: 1,
				runId: deps.runId,
				nodeId: node.id,
				attempt,
				errorClass: classification,
				message,
				attempts: attempt
			});
			if ((classification === "transient" || classification === "timeout") && attempt < node.retry.maxAttempts) {
				await sleepBackoff(node.retry.backoffMs, deps.signal);
				attempt += 1;
				promptBlocks = withRetryFeedback(promptBlocks, message);
				await deps.journal.append("agent-multi/node-start", {
					version: 1,
					runId: deps.runId,
					nodeId: node.id,
					nodeKind: node.kind,
					attempt
				});
				await deps.journal.append("agent-multi/node-input", {
					version: 1,
					runId: deps.runId,
					nodeId: node.id,
					attempt,
					prompt: textOf$1(promptBlocks)
				});
				continue;
			}
			return {
				ok: false,
				errorClass: classification,
				message,
				attempts: attempt
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const errorClass = timedOut ? "timeout" : isTransientActivationError(error) ? "transient" : "deterministic";
			if ((errorClass === "transient" || errorClass === "timeout") && attempt < node.retry.maxAttempts) {
				await deps.journal.append("agent-multi/node-error", {
					version: 1,
					runId: deps.runId,
					nodeId: node.id,
					attempt,
					errorClass,
					message,
					attempts: attempt
				});
				await sleepBackoff(node.retry.backoffMs, deps.signal);
				attempt += 1;
				promptBlocks = withRetryFeedback(promptBlocks, message);
				await deps.journal.append("agent-multi/node-start", {
					version: 1,
					runId: deps.runId,
					nodeId: node.id,
					nodeKind: node.kind,
					attempt
				});
				await deps.journal.append("agent-multi/node-input", {
					version: 1,
					runId: deps.runId,
					nodeId: node.id,
					attempt,
					prompt: textOf$1(promptBlocks)
				});
				continue;
			}
			await deps.journal.append("agent-multi/node-error", {
				version: 1,
				runId: deps.runId,
				nodeId: node.id,
				attempt,
				errorClass,
				message,
				attempts: attempt
			});
			return {
				ok: false,
				errorClass,
				message,
				attempts: attempt
			};
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			if (fireAbort !== void 0) deps.signal.removeEventListener("abort", fireAbort);
		}
	}
}
/** Append failure feedback for the next attempt to the prompt. */
function withRetryFeedback(blocks, message) {
	return [...blocks, {
		type: "text",
		text: `## Retry feedback\nYour previous attempt failed: ${message}\nCorrect the failure and complete the task.`
	}];
}
/**
* Convert the zod-inferred tool filter into the subagent tool restriction.
* The ask-user tool needs no entry here: it is installed on the child's own
* scoped layer (exempt from restrictions), and only nodes with `hitlEnabled`
* receive it at all.
* @param filter - the node's tool filter, or undefined.
* @returns the restriction, or undefined when nothing is filtered.
*/
function toToolRestriction(filter) {
	if (filter === void 0) return void 0;
	const allow = filter.allow;
	const deny = filter.deny;
	if (allow === void 0 && (deny === void 0 || deny.length === 0)) return void 0;
	return {
		...allow !== void 0 ? { allow: [...allow] } : {},
		...deny !== void 0 && deny.length > 0 ? { deny: [...deny] } : {}
	};
}
//#endregion
//#region ../../core/scope/src/store.ts
/**
* Insertion-ordered named entries with caller-owned duplicate diagnostics.
*
* Values are borrowed. Iterators are live within one nonempty table
* generation; draining the table detaches them from later insertions. Each
* successful insertion returns an idempotent undo for that exact entry.
*/
var NamedEntries = class {
	duplicateError;
	data = /* @__PURE__ */ new Map();
	constructor(duplicateError) {
		this.duplicateError = duplicateError;
	}
	/**
	* Insert one unique name.
	* @param name - name unique within this table.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo that removes only this insertion.
	*/
	insert(name, value) {
		const data = this.data;
		if (data.has(name)) throw this.duplicateError(name);
		data.set(name, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(name);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Read one named value.
	* @param name - name to resolve.
	* @returns the retained value, or `undefined` when absent.
	*/
	get(name) {
		return this.data.get(name);
	}
	/**
	* Test one name for membership.
	* @param name - name to test.
	* @returns whether the table contains that name.
	*/
	has(name) {
		return this.data.has(name);
	}
	/**
	* Iterate live names in insertion order.
	* @returns the native live key iterator.
	*/
	keys() {
		return this.data.keys();
	}
	/**
	* Iterate live entries in insertion order.
	* @returns the native live entry iterator.
	*/
	entries() {
		return this.data.entries();
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Insertion-ordered anonymous entries with independent registration identity.
*
* Equal values remain separate registrations. Values are borrowed, and
* iterators are live within one nonempty table generation; draining the table
* detaches them from later appends.
*/
var AnonymousEntries = class {
	data = /* @__PURE__ */ new Map();
	/**
	* Append one independently owned value.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo for this exact append.
	*/
	append(value) {
		const data = this.data;
		const key = Symbol();
		data.set(key, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(key);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Own the global and exact-scope layers for one registry.
*
* Reads never create scoped layers. Registrations derive both visibility and
* effect ownership from the supplied Cordis context, collect undo before
* notification, and reclaim only a completely empty aggregate layer.
*/
var ScopedLayers = class {
	createLayer;
	onChange;
	/** The eagerly constructed context-global layer. */
	global;
	scoped = /* @__PURE__ */ new Map();
	constructor(createLayer, onChange) {
		this.createLayer = createLayer;
		this.onChange = onChange;
		this.global = createLayer(void 0);
	}
	/**
	* Read an existing exact-scope overlay. Deliberately chain-blind: callers
	* addressing one scope's OWN contributions (its restrictions, its guards)
	* must not silently pick up an ancestor's — use {@link chainLayers} where
	* inheritance is the point.
	* @param scope - exact scope key; `undefined` denotes no overlay.
	* @returns the existing scoped layer, or `undefined` without creating one.
	*/
	peek(scope) {
		if (scope === void 0) return void 0;
		return this.scoped.get(scope);
	}
	/**
	* Existing overlays along the scope's parent chain ({@link scopeChainOf}),
	* farthest ancestor first and the exact scope last, so a caller layering
	* them in order gives the nearest scope the final word.
	* @param scope - viewing scope, or `undefined` for no overlays.
	* @returns the existing layers, nearest last; absent overlays are skipped.
	*/
	chainLayers(scope) {
		const layers = [];
		for (const key of scopeChainOf(scope).reverse()) {
			const layer = this.scoped.get(key);
			if (layer !== void 0) layers.push(layer);
		}
		return layers;
	}
	/**
	* Materialize global named entries followed by scope-chain shadows,
	* farthest ancestor first, so the nearest scope's entry wins a name.
	* @param scope - viewing scope, or `undefined` for the global view.
	* @param pick - select the named table from a layer.
	* @returns an insertion-ordered effective map.
	*/
	merge(scope, pick) {
		const merged = new Map(pick(this.global).entries());
		for (const layer of this.chainLayers(scope)) for (const [name, value] of pick(layer).entries()) merged.set(name, value);
		return merged;
	}
	/**
	* Attach one synchronous layer mutation to its registration context.
	* @param ctx - context that determines both scope visibility and effect ownership.
	* @param action - atomic mutation returning its synchronous undo.
	* @param options - Cordis effect label and optional change notification.
	* @returns the exact disposer returned by `ctx.effect()`.
	*/
	effect(ctx, action, options) {
		const scope = scopeOf(ctx);
		const notify = options.notify ?? true;
		return ctx.effect(function* () {
			let layer;
			let created = false;
			if (scope === void 0) layer = this.global;
			else {
				const existing = this.scoped.get(scope);
				if (existing === void 0) {
					layer = this.createLayer(scope);
					this.scoped.set(scope, layer);
					created = true;
				} else layer = existing;
			}
			let undo;
			try {
				undo = action(layer);
			} catch (error) {
				if (scope !== void 0 && created && layer.isEmpty()) this.scoped.delete(scope);
				throw error;
			}
			yield () => {
				undo();
				if (scope !== void 0 && layer.isEmpty()) this.scoped.delete(scope);
				if (notify) this.onChange();
			};
			if (notify) this.onChange();
		}.bind(this), options.label);
	}
};
//#endregion
//#region ../../core/scope/src/index.ts
/** Context tag written by {@link createScope}. */
const kScope = Symbol("dsh.scope");
/** The key associated with each carrier. Presence distinguishes an unkeyed carrier from a non-carrier. */
const carrierKeys = /* @__PURE__ */ new WeakMap();
/**
* The enclosing scope of each key. One relation powers both directions of
* scope nesting: registration views inherit DOWN the chain (a child scope
* sees its ancestors' layers — {@link ScopedLayers}), and event admission
* extends UP it (a listener tagged with an ancestor receives events dispatched
* to a descendant key — {@link scopeTarget}).
*/
const scopeParents = /* @__PURE__ */ new WeakMap();
/**
* The chain from a key to its root ancestor.
* @param key - the starting key, or `undefined` for the empty chain.
* @returns keys nearest-first: `[key, parent, grandparent, …]`.
*/
function scopeChainOf(key) {
	const chain = [];
	for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) chain.push(cursor);
	return chain;
}
/**
* Read the nearest scope tag inherited by a context.
* @param ctx - context to inspect.
* @returns its scope key, or `undefined` for an unscoped context.
*/
function scopeOf(ctx) {
	return ctx[kScope];
}
/**
* Build an opaque receiver that preserves the base filter, admits untagged
* listeners globally, and admits tagged listeners for a matching key or any
* of its ancestors ({@link bindScopeParent}): a listener owned by an enclosing
* scope receives every descendant scope's events, which is what lets one
* standing composition observe each of the agents composed under it. A tag
* BELOW the dispatch key stays excluded — events flow up the chain, never
* down.
* @param base - subject or service whose existing Cordis filter is preserved.
* @param key - routed scope identity, or `undefined` for an unscoped subject.
* @returns a carrier whose subject remains available only through event arguments.
*/
function scopeTarget(base, key) {
	const baseFilter = base[Context.filter];
	const carrier = { [Context.filter](ctx) {
		if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
		const tag = scopeOf(ctx);
		if (tag === void 0) return true;
		for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
		return false;
	} };
	carrierKeys.set(carrier, key);
	return carrier;
}
//#endregion
//#region ../../util/values/src/partial-json.ts
/**
* Lazily scanned view of one JSON object's top-level fields, built from text
* that may still be streaming or from an already parsed object. Nothing is
* scanned until a reader asks; the view remembers every question it answered
* and reports changed answers when the owner refreshes for publication.
* Used for model tool-call arguments: a row reads the fields it
* cares about at whatever granularity it displays, at every stage of the call.
* @module @deepseek-ai/dsh-util-values/src/partial-json
*/
const SIMPLE_ESCAPES = {
	"\"": "\"",
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	"
};
const CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
function isWhitespace(c) {
	return c === " " || c === "\n" || c === "\r" || c === "	";
}
function isHex(c) {
	return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
}
(class PartialArguments {
	/** The view of a call with no arguments available. */
	static EMPTY = PartialArguments.fromObject({});
	/**
	* View finished argument text without scanning it until a reader asks.
	* @param text - the complete argument JSON text.
	* @returns a sealed view.
	*/
	static fromText(text) {
		const view = new PartialArguments();
		view.append(text);
		view.sealed = true;
		return view;
	}
	/**
	* View an already parsed argument payload, such as a PTC dispatch object.
	* @param value - the parsed argument value.
	* @returns a sealed view; a non-object payload has no fields.
	*/
	static fromObject(value) {
		const view = new PartialArguments();
		view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
		view.sealed = true;
		return view;
	}
	/**
	* The source: text so far or a parsed object, plus whether it can still grow.
	* These are the only enumerable fields, so two views over the same source
	* compare equal structurally however far each has been read.
	*/
	chunks = [];
	object;
	sealed = false;
	#ends = [];
	#size = 0;
	#consumed = 0;
	#mode = "root";
	#escape = false;
	#keyStart = 0;
	#keyEscaped = false;
	#key = "";
	#current = null;
	#nestedEnds = [];
	#nestedInString = false;
	#invalidAt;
	#invalidValue = false;
	#entries = /* @__PURE__ */ new Map();
	#order = [];
	#reads = /* @__PURE__ */ new Map();
	/** Whether this view rejects further appends; does not scan text or register reads. */
	get isSealed() {
		return this.sealed;
	}
	/** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
	get invalid() {
		this.scan();
		return this.#mode === "invalid" || this.#invalidValue;
	}
	/**
	* Retain streamed argument text without scanning or comparing observed answers.
	* @param fragment - the text following every fragment appended before.
	*/
	append(fragment) {
		if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
		if (fragment.length === 0) return;
		this.chunks.push(fragment);
		this.#size += fragment.length;
		this.#ends.push(this.#size);
	}
	/**
	* Reconcile a streamed prefix with authoritative complete text without joining the fragments.
	* @param text - the final argument text, which replaces missing or conflicting deltas.
	* @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
	*/
	settle(text) {
		if (this.object !== void 0 || text.length !== this.#size) return PartialArguments.fromText(text);
		let offset = 0;
		for (const chunk of this.chunks) {
			if (!text.startsWith(chunk, offset)) return PartialArguments.fromText(text);
			offset += chunk.length;
		}
		this.chunks = text.length === 0 ? [] : [text];
		this.#ends = text.length === 0 ? [] : [text.length];
		this.sealed = true;
		return this;
	}
	/**
	* Compare observed answers and advance their publication baseline. Unread views remain unscanned.
	* @returns whether any observed answer changed since its first read or the preceding refresh.
	*/
	refresh() {
		if (this.#reads.size === 0) return false;
		this.scan();
		let changed = false;
		let completions = false;
		for (const read of this.#reads.values()) {
			if (read.completion) {
				completions = true;
				continue;
			}
			changed = this.refreshRead(read) || changed;
		}
		if (completions) {
			for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
		}
		if (this.sealed) this.#reads.clear();
		return changed;
	}
	refreshRead(read) {
		const now = read.answer();
		if (Object.is(now, read.last)) return false;
		read.last = now;
		return true;
	}
	/**
	* Check whether no further fields can arrive.
	* @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
	*/
	closed() {
		return this.remember("closed", "", () => this.closedNow());
	}
	/**
	* List discovered fields in first-appearance order.
	* @returns top-level keys seen so far, in first-appearance order.
	*/
	keys() {
		return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
	}
	/**
	* Check whether a top-level field has appeared.
	* @param key - argument name.
	* @returns whether the field has appeared (a string opened or another value began).
	*/
	has(key) {
		return this.remember("has", key, () => this.hasNow(key));
	}
	/**
	* Check whether a field's closing delimiter has arrived, without validating its contents.
	* @param key - argument name.
	* @returns whether its delimiter arrived and no content reader has reported an error for this value.
	*/
	complete(key) {
		return this.remember("complete", key, () => this.completeNow(key));
	}
	/**
	* Read string length without materializing its text.
	* @param key - argument name.
	* @param options - change granularity for a streaming string.
	* @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
	*/
	stringLength(key, options) {
		const step = Math.max(1, Math.floor(options?.step ?? 1));
		const offset = options?.offset ?? 0;
		return this.remember(`length:${step}:${offset}`, key, () => this.lengthNow(key), (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step));
	}
	/**
	* Check a string against a decoded UTF-16 length limit without materializing it.
	* @param key - argument name.
	* @param maxLength - decoded UTF-16 limit, floored to at least zero.
	* @returns whether the string is longer than the limit; false when absent or not a string.
	*/
	stringExceeds(key, maxLength) {
		const limit = Math.max(0, Math.floor(maxLength));
		return this.remember(`exceeds:${limit}`, key, () => (this.lengthNow(key, limit + 1) ?? 0) > limit);
	}
	/**
	* Read a decoded string, including a streaming prefix.
	* @param key - argument name.
	* @returns the string field's decoded text so far; undefined when absent or not a string.
	*/
	text(key) {
		return this.remember("text", key, () => this.textNow(key));
	}
	/**
	* Read at most the first decoded UTF-16 units of a string.
	* @param key - argument name.
	* @param maxLength - maximum decoded UTF-16 length, floored to at least one.
	* @returns the bounded string prefix; undefined when absent or not a string.
	*/
	textPrefix(key, maxLength) {
		const limit = Math.max(1, Math.floor(maxLength));
		return this.remember(`prefix:${limit}`, key, () => this.textPrefixNow(key, limit));
	}
	/**
	* Read a completed non-string argument.
	* @param key - argument name.
	* @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
	*/
	value(key) {
		return this.remember("value", key, () => this.valueNow(key));
	}
	/** Answer a question and, on a streaming view, remember it for change detection. */
	remember(kind, key, read, comparison) {
		this.scan();
		const result = read();
		if (!this.sealed) {
			const id = `${kind}/${key}`;
			if (!this.#reads.has(id)) this.#reads.set(id, {
				completion: kind === "complete",
				answer: comparison === void 0 ? read : () => comparison(read()),
				last: comparison === void 0 ? result : comparison(result)
			});
		}
		return result;
	}
	closedNow() {
		return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
	}
	keysNow() {
		return this.object === void 0 ? this.#order : Object.keys(this.object);
	}
	hasNow(key) {
		return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
	}
	completeNow(key) {
		if (this.object !== void 0) return Object.hasOwn(this.object, key);
		const entry = this.#entries.get(key);
		return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
	}
	lengthNow(key, limit = Number.POSITIVE_INFINITY) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.length : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
		const read = entry.length ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, limit, false);
		return read.length;
	}
	textNow(key) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
			let text;
			try {
				text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
			} catch (_error) {}
			if (text !== void 0) entry.text = {
				at: entry.end,
				length: text.length,
				text
			};
		}
		const read = entry.text ??= {
			at: entry.start,
			length: 0,
			text: ""
		};
		this.readString(entry, read, Number.POSITIVE_INFINITY, true);
		return read.text;
	}
	textPrefixNow(key, maxLength) {
		if (this.object !== void 0) {
			const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
			return typeof field === "string" ? field.slice(0, maxLength) : void 0;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "string") return void 0;
		const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
		let read = prefixes.get(maxLength);
		if (read === void 0) {
			read = {
				at: entry.start,
				length: 0,
				text: ""
			};
			prefixes.set(maxLength, read);
		}
		this.readString(entry, read, maxLength, true);
		return read.text;
	}
	valueNow(key) {
		if (this.object !== void 0) {
			if (!Object.hasOwn(this.object, key)) return void 0;
			const field = this.object[key];
			return typeof field === "string" ? void 0 : field;
		}
		const entry = this.#entries.get(key);
		if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
		if (entry.parsed === void 0) try {
			entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
		} catch (_error) {
			entry.invalid = true;
			this.#invalidValue = true;
		}
		return entry.parsed;
	}
	chunkAt(at) {
		let low = 0;
		let high = this.#ends.length;
		while (low < high) {
			const mid = low + high >>> 1;
			if (this.#ends[mid] <= at) low = mid + 1;
			else high = mid;
		}
		return low;
	}
	/** Materialize only a requested range, never the cumulative source. */
	slice(start, end) {
		if (start >= end) return "";
		const first = this.chunkAt(start);
		const last = this.chunkAt(end - 1);
		const base = first === 0 ? 0 : this.#ends[first - 1];
		if (first === last) return this.chunks[first].slice(start - base, end - base);
		const parts = [this.chunks[first].slice(start - base)];
		for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
		parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
		return parts.join("");
	}
	readString(entry, read, limit, materialize) {
		const end = Math.min(entry.end < 0 ? this.#consumed : entry.end, entry.invalidAt ?? Number.POSITIVE_INFINITY, this.#invalidAt ?? Number.POSITIVE_INFINITY);
		if (!entry.needsDecoding) {
			const length = Math.min(end - read.at, limit - read.length);
			if (length <= 0) return;
			if (materialize) read.text += this.slice(read.at, read.at + length);
			read.at += length;
			read.length += length;
			return;
		}
		let chunkIndex = this.chunkAt(read.at);
		while (read.at < end && read.length < limit) {
			const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
			const chunk = this.chunks[chunkIndex];
			const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
			const boundary = remaining.search(CONTENT_ESCAPE);
			const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
			if (length > 0) {
				if (materialize) read.text += remaining.slice(0, length);
				read.at += length;
				read.length += length;
				if (read.at === base + chunk.length) chunkIndex++;
				continue;
			}
			const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
			let decoded;
			let width = 2;
			if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
			if (remaining[0] === "\\" && type === "u") {
				const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
				let valid = true;
				for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
				if (valid) {
					if (hex.length < 4 && entry.end < 0) return;
					if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
				}
				width = 6;
			} else if (remaining[0] === "\\" && type !== void 0) decoded = SIMPLE_ESCAPES[type];
			if (decoded === void 0) {
				entry.invalidAt = read.at;
				this.#invalidValue = true;
				return;
			}
			if (materialize) read.text += decoded;
			read.length++;
			read.at += width;
			while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
		}
	}
	/** Locate new field ranges without decoding or parsing their contents. */
	scan() {
		if (this.object !== void 0 || this.#consumed === this.#size) return;
		for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
			const pending = this.chunks[i];
			const base = i === 0 ? 0 : this.#ends[i - 1];
			for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
				if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
					const end = this.stringBoundary(pending, index);
					this.#consumed += end - index;
					index = end;
					if (index === pending.length) break;
				}
				this.step(pending[index], this.#consumed);
				this.#consumed++;
			}
		}
	}
	/** Only raw quotes and their preceding backslash runs can terminate a string. */
	stringBoundary(fragment, start) {
		let at = start;
		while (true) {
			const quote = fragment.indexOf("\"", at);
			const end = quote < 0 ? fragment.length : quote;
			if (this.#mode === "string") {
				const entry = this.#current;
				if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
			}
			let slashStart = end;
			while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
			const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
			this.#escape = quote < 0 && escaped;
			if (quote < 0 || !escaped) return end;
			at = quote + 1;
		}
	}
	step(c, at) {
		switch (this.#mode) {
			case "root":
				if (isWhitespace(c)) return;
				if (c === "{") {
					this.#mode = "key-or-end";
					return;
				}
				this.fail();
				return;
			case "key-or-end":
				if (isWhitespace(c)) return;
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key-only":
				if (isWhitespace(c)) return;
				if (c === "\"") {
					this.beginKey(at);
					return;
				}
				this.fail();
				return;
			case "key":
				this.stepKey(c, at);
				return;
			case "colon":
				if (isWhitespace(c)) return;
				if (c === ":") {
					this.#mode = "value";
					return;
				}
				this.fail();
				return;
			case "value":
				this.beginValue(c, at);
				return;
			case "string": {
				const entry = this.#current;
				entry.end = at;
				this.#current = null;
				this.#mode = "comma-or-end";
				return;
			}
			case "scalar":
				this.stepScalar(c, at);
				return;
			case "nested":
				this.stepNested(c, at);
				return;
			case "comma-or-end":
				if (isWhitespace(c)) return;
				if (c === ",") {
					this.#mode = "key-only";
					return;
				}
				if (c === "}") {
					this.#mode = "closed";
					return;
				}
				this.fail();
				return;
			case "closed":
				if (isWhitespace(c)) return;
				this.fail();
				return;
			/* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
			case "invalid": return;
			/* v8 ignore next 2 -- Every scanner mode has a handler above. */
			default: assertNever(this.#mode);
		}
	}
	fail() {
		this.#invalidAt = this.#consumed;
		this.#mode = "invalid";
		this.#current = null;
	}
	beginKey(at) {
		this.#mode = "key";
		this.#keyStart = at + 1;
		this.#keyEscaped = false;
		this.#escape = false;
	}
	stepKey(c, at) {
		if (c < " ") {
			this.fail();
			return;
		}
		if (this.#escape) {
			this.#escape = false;
			return;
		}
		if (c === "\\") {
			this.#escape = true;
			this.#keyEscaped = true;
			return;
		}
		if (c !== "\"") return;
		const raw = this.slice(this.#keyStart, at);
		if (this.#keyEscaped) try {
			this.#key = JSON.parse(`"${raw}"`);
		} catch (_error) {
			this.fail();
			return;
		}
		else this.#key = raw;
		this.#mode = "colon";
	}
	open(entry) {
		if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
		this.#entries.set(this.#key, entry);
		this.#current = entry;
	}
	beginValue(c, at) {
		if (isWhitespace(c)) return;
		if (c === "\"") {
			this.open({
				kind: "string",
				start: at + 1,
				end: -1,
				needsDecoding: false,
				invalidAt: void 0,
				length: void 0,
				text: void 0,
				prefixes: void 0
			});
			this.#escape = false;
			this.#mode = "string";
			return;
		}
		if (c === "}" || c === "," || c === ":" || c === "]") {
			this.fail();
			return;
		}
		this.open({
			kind: "value",
			start: at,
			end: -1,
			parsed: void 0,
			invalid: false
		});
		if (c === "{" || c === "[") {
			this.#mode = "nested";
			this.#nestedEnds = [c === "{" ? "}" : "]"];
			this.#nestedInString = false;
			this.#escape = false;
			return;
		}
		this.#mode = "scalar";
	}
	stepScalar(c, at) {
		if (c !== "," && c !== "}" && !isWhitespace(c)) return;
		this.closeValue(at);
		this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
	}
	stepNested(c, at) {
		if (this.#nestedInString) {
			this.#nestedInString = false;
			return;
		}
		if (c === "\"") {
			this.#nestedInString = true;
			return;
		}
		if (c === "{" || c === "[") {
			this.#nestedEnds.push(c === "{" ? "}" : "]");
			return;
		}
		if (c === "}" || c === "]") {
			if (this.#nestedEnds.pop() !== c) {
				this.fail();
				return;
			}
			if (this.#nestedEnds.length === 0) {
				this.closeValue(at + 1);
				this.#mode = "comma-or-end";
			}
		}
	}
	closeValue(end) {
		const entry = this.#current;
		entry.end = end;
		this.#current = null;
	}
});
//#endregion
//#region ../../util/values/src/index.ts
/**
* Mark an unreachable closed-union branch.
* @param value - impossible value; an unhandled typed variant fails at the call site.
* @param context - optional switch-site label included in the failure message.
* @returns never; a runtime value that escaped its type always throws.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
/** Whether a realm-owned intrinsic prototype has a native constructor matching this engine's representation. */
function hasIntrinsicConstructor$1(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === "Array" ? Array : Object);
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype$1(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor$1(value, "Object");
}
/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype$1(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor$1(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype$1(objectPrototype);
}
/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype$1(prototype);
}
/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value) {
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) return void 0;
	return keys;
}
/** Validate lossless JSON iteratively, optionally materializing a detached snapshot. */
function walkJsonValue(value, detach) {
	const ancestors = /* @__PURE__ */ new Set();
	let root;
	const assign = (destination, item) => {
		if (destination === void 0) return;
		if (destination.kind === "root") root = item;
		else if (destination.kind === "array") destination.target[destination.index] = item;
		else Object.defineProperty(destination.target, destination.key, {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true
		});
	};
	const tasks = [{
		kind: "visit",
		value,
		...detach ? { destination: { kind: "root" } } : {}
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			ancestors.delete(task.source);
			continue;
		}
		if (task.kind === "array-item") {
			if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return void 0;
			tasks.push({
				kind: "visit",
				value: task.source[task.index],
				...task.target === void 0 ? {} : { destination: {
					kind: "array",
					target: task.target,
					index: task.index
				} }
			});
			continue;
		}
		if (task.kind === "object-property") {
			tasks.push({
				kind: "visit",
				value: task.source[task.key],
				...task.target === void 0 ? {} : { destination: {
					kind: "object",
					target: task.target,
					key: task.key
				} }
			});
			continue;
		}
		const current = task.value;
		if (current === null) {
			assign(task.destination, null);
			continue;
		}
		if (typeof current === "boolean" || typeof current === "string") {
			assign(task.destination, current);
			continue;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) return void 0;
			assign(task.destination, current);
			continue;
		}
		if (typeof current !== "object") return void 0;
		if (ancestors.has(current)) return void 0;
		if (Array.isArray(current)) {
			if (!hasPlainArrayPrototype$1(current)) return void 0;
			const length = current.length;
			if (Reflect.ownKeys(current).length !== length + 1) return void 0;
			const target = detach ? [] : void 0;
			if (target !== void 0) assign(task.destination, target);
			ancestors.add(current);
			tasks.push({
				kind: "leave",
				source: current
			});
			for (let index = length - 1; index >= 0; index--) tasks.push({
				kind: "array-item",
				source: current,
				index,
				...target === void 0 ? {} : { target }
			});
			continue;
		}
		if (!hasPlainObjectPrototype(current)) return void 0;
		const keys = enumerableStringKeys(current);
		if (keys === void 0) return void 0;
		const target = detach ? {} : void 0;
		if (target !== void 0) assign(task.destination, target);
		ancestors.add(current);
		tasks.push({
			kind: "leave",
			source: current
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) return void 0;
			tasks.push({
				kind: "object-property",
				source: current,
				key,
				...target === void 0 ? {} : { target }
			});
		}
	}
	return detach ? root : true;
}
/**
* Validate and detach lossless JSON in one read per property.
* @param value - candidate value to validate and detach.
* @returns the detached snapshot, or `undefined` when the value is not losslessly JSON-serializable.
*/
function snapshotJsonValue(value) {
	return walkJsonValue(value, true);
}
/**
* Test the same lossless JSON rules as {@link snapshotJsonValue} without detaching the value.
* @param value - candidate value to test.
* @returns whether the value survives a JSON round trip without loss.
*/
function isJsonValue(value) {
	return walkJsonValue(value, false) === true;
}
/**
* Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
* @param value - value to freeze.
* @returns the same value after every reachable enumerable child is frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
//#endregion
//#region ../../core/tools/src/json-schema.ts
/**
* Enforced JSON Schema subset shared by tool outputs, generated PTC mode
* types, subagents, and workflows. The subset accepts any JSON root, an
* annotation-only schema for unconstrained JSON, one scalar `type`, object
* `properties`/`required`/boolean `additionalProperties`, array `items`,
* type-correct scalar `enum`/`const`, and exact-one `oneOf`.
*
* Unsupported or misplaced keywords reject rather than being accepted without
* enforcement. Consumers that require an object root apply
* {@link assertObjectJsonSchema} before accepting input.
* @module dsh-tools/json-schema
*/
/**
* Thrown when a raw schema falls outside the enforced subset. `violations`
* lists every offending path instead of stopping at the first author error.
*/
var JsonSchemaError = class extends HarnessError {
	/** Individual schema violations in walk order. */
	violations;
	constructor(violations) {
		super(`unsupported JSON schema: ${violations.join("; ")}`, "UNSUPPORTED_SCHEMA");
		this.name = "JsonSchemaError";
		this.violations = violations;
	}
};
const CONSTRAINT_KEYWORDS = new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
]);
const ANNOTATION_KEYWORDS = new Set([
	"description",
	"title",
	"default",
	"examples"
]);
const SCHEMA_TYPES = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null"
];
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
/**
* Test for a realm-agnostic plain JSON record without accepting arrays or
* exotic objects.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the value has a plain-object prototype chain.
*/
function isPlainJsonRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
	} catch {
		return false;
	}
}
/** Whether an array uses one realm's intrinsic `Array.prototype`. */
function hasPlainArrayPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
/** Return whether a record contains only own enumerable string keys. */
function hasOnlyEnumerableStringKeys(value) {
	try {
		return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key));
	} catch {
		return false;
	}
}
/**
* Test for an ordinary schema record whose keys survive JSON projection.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the record has an intrinsic prototype and only own enumerable string keys.
*/
function isJsonSchemaRecord(value) {
	return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value);
}
/**
* Test for a dense ordinary array with no JSON-invisible decorations.
* @param value - candidate array from any JavaScript realm.
* @returns Whether the array is intrinsic, dense, and undecorated.
*/
function isPlainJsonArray(value) {
	if (!Array.isArray(value)) return false;
	try {
		if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
		for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
		return true;
	} catch {
		return false;
	}
}
/** Lossless finite JSON number, excluding negative zero. */
function isJsonNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}
/** Whether a scalar is valid for one declared schema type. */
function scalarMatches(type, value) {
	switch (type) {
		case "string": return typeof value === "string";
		case "number": return isJsonNumber(value);
		case "integer": return isJsonNumber(value) && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		/* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
		default: return assertNever(type, "JsonSchemaType");
	}
}
/** Keywords that are invalid beside `oneOf`. */
const ONE_OF_SIBLING_KEYWORDS = [
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
];
/** Validate object-only fields after its property schemas have been visited. */
function checkObjectSchemaTail(node, path, properties, violations) {
	const hasRequired = Object.hasOwn(node, "required");
	const required = hasRequired ? node.required : void 0;
	if (hasRequired) if (!isPlainJsonArray(required) || required.some((entry) => typeof entry !== "string")) violations.push(`${path}.required must be an array of strings`);
	else {
		const declared = isJsonSchemaRecord(properties) ? properties : {};
		for (const key of required) if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
	}
	if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") violations.push(`${path}.additionalProperties must be a boolean`);
}
/** Collect every violation for one raw schema tree without using the JavaScript call stack. */
function checkSchemaNode(root, rootPath, violations, seen) {
	const tasks = [{
		kind: "enter",
		node: root,
		path: rootPath
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.node);
			continue;
		}
		if (task.kind === "one-of-tail") {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
			continue;
		}
		if (task.kind === "object-tail") {
			checkObjectSchemaTail(task.node, task.path, task.properties, violations);
			continue;
		}
		const { node, path } = task;
		if (!isJsonSchemaRecord(node)) {
			violations.push(`${path} must be a schema object`);
			continue;
		}
		if (seen.has(node)) {
			violations.push(`${path} is circular`);
			continue;
		}
		seen.add(node);
		tasks.push({
			kind: "leave",
			node
		});
		for (const key of Object.keys(node)) {
			if (CONSTRAINT_KEYWORDS.has(key)) continue;
			if (ANNOTATION_KEYWORDS.has(key)) {
				try {
					if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
				} catch {
					violations.push(`${path}.${key} annotation must be lossless JSON data`);
				}
				continue;
			}
			violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
		}
		if (Object.hasOwn(node, "description") && typeof node.description !== "string") violations.push(`${path}.description must be a string`);
		if (Object.hasOwn(node, "title") && typeof node.title !== "string") violations.push(`${path}.title must be a string`);
		const hasType = Object.hasOwn(node, "type");
		const hasOneOf = Object.hasOwn(node, "oneOf");
		if (hasType && hasOneOf) {
			violations.push(`${path} cannot declare both type and oneOf`);
			continue;
		}
		if (!hasType && !hasOneOf) {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
			continue;
		}
		if (hasOneOf) {
			const oneOf = node.oneOf;
			tasks.push({
				kind: "one-of-tail",
				node,
				path
			});
			if (!isPlainJsonArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
			else for (let index = oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "enter",
				node: oneOf[index],
				path: `${path}.oneOf[${index}]`
			});
			continue;
		}
		const type = node.type;
		if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
			violations.push(Array.isArray(type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`);
			continue;
		}
		const schemaType = type;
		for (const [key, types] of Object.entries({
			properties: ["object"],
			required: ["object"],
			additionalProperties: ["object"],
			items: ["array"],
			enum: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			],
			const: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			]
		})) if (Object.hasOwn(node, key) && !types.includes(schemaType)) violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
		switch (schemaType) {
			case "object": {
				const properties = Object.hasOwn(node, "properties") ? node.properties : void 0;
				tasks.push({
					kind: "object-tail",
					node,
					path,
					properties
				});
				if (Object.hasOwn(node, "properties")) if (!isJsonSchemaRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
				else {
					const entries = Object.entries(properties);
					for (let index = entries.length - 1; index >= 0; index--) {
						const entry = entries[index];
						/* v8 ignore next -- the loop is bounded by the captured entry count. */
						if (entry === void 0) continue;
						tasks.push({
							kind: "enter",
							node: entry[1],
							path: `${path}.properties.${entry[0]}`
						});
					}
				}
				break;
			}
			case "array":
				if (Object.hasOwn(node, "items")) tasks.push({
					kind: "enter",
					node: node.items,
					path: `${path}.items`
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null": {
				const hasEnum = Object.hasOwn(node, "enum");
				const allowed = hasEnum ? node.enum : void 0;
				const enumValid = isPlainJsonArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(schemaType, entry));
				if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`);
				const hasConst = Object.hasOwn(node, "const");
				const declaredConst = hasConst ? node.const : void 0;
				const constValid = scalarMatches(schemaType, declaredConst);
				if (hasConst) {
					if (!constValid) violations.push(`${path}.const must be a ${schemaType} value`);
					else if (enumValid && !allowed.includes(declaredConst)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
				}
				break;
			}
			/* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
			default: assertNever(schemaType, "JsonSchemaType");
		}
	}
}
/**
* Assert that an arbitrary raw schema uses only the enforced subset.
* Annotation-only schemas are accepted as the standard unconstrained-JSON
* form; callers that require an object root use {@link assertObjectJsonSchema}.
* @param schema - untrusted raw JSON Schema.
* @returns Assertion that the schema belongs to the supported subset.
*/
function assertSupportedJsonSchema(schema) {
	const violations = [];
	checkSchemaNode(schema, "schema", violations, /* @__PURE__ */ new Set());
	if (violations.length > 0) throw new JsonSchemaError(violations);
}
/** Safely test the lossless JSON boundary when a getter may throw. */
function safelyIsJsonValue(value) {
	try {
		return isJsonValue(value);
	} catch {
		return false;
	}
}
/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
function diagnosticPath(path) {
	return path === "" ? "arguments" : path;
}
/** Append one object property without a leading dot at an implicit root. */
function propertyPath(path, key) {
	return path === "" ? key : `${path}.${key}`;
}
/** The generic exception-containment diagnostic owned by one valid schema node. */
function losslessValueViolation(path) {
	return [`"${diagnosticPath(path)}" must be a lossless JSON value`];
}
/** Append diagnostics without spreading a potentially wide child result as call arguments. */
function appendViolations(target, source) {
	for (const violation of source) target.push(violation);
}
/** Initialize one validation frame with empty aggregation state. */
function valueFrame(node, value, path) {
	return {
		node,
		value,
		path,
		catches: false,
		phase: "start",
		children: [],
		childIndex: 0,
		violations: [],
		tailViolations: [],
		matches: 0
	};
}
/** Validate one scalar node after its primitive type check. */
function checkScalarValue(node, value, path) {
	const allowed = Object.hasOwn(node, "enum") ? node.enum : void 0;
	if (allowed !== void 0 && !allowed.includes(value)) return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`];
	if (Object.hasOwn(node, "const") && value !== node.const) return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`];
	return [];
}
/** Validate one trusted schema/value pair with explicit frames rather than recursive calls. */
function checkValue(schema, value, path) {
	const frames = [valueFrame(schema, value, path)];
	let rootResult;
	const receive = (result) => {
		const parent = frames.at(-1);
		if (parent === void 0) {
			rootResult = result;
			return;
		}
		if (parent.kind === "oneOf") {
			if (result.length === 0) parent.matches++;
		} else appendViolations(parent.violations, result);
	};
	const finish = (result) => {
		frames.pop();
		receive(result);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		try {
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing schema-value child frame");
					frame.childIndex++;
					frames.push(valueFrame(child.node, child.value, child.path));
					continue;
				}
				if (frame.kind === "oneOf") {
					finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`]);
					continue;
				}
				appendViolations(frame.violations, frame.tailViolations);
				if (frame.violations.length > 0) finish(frame.violations);
				else if (frame.kind === "object") finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`]);
				else finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`]);
				continue;
			}
			const nodeType = Object.hasOwn(frame.node, "type") ? frame.node.type : void 0;
			frame.catches = !(nodeType !== void 0 && !SCHEMA_TYPES.includes(nodeType));
			const oneOf = Object.hasOwn(frame.node, "oneOf") ? frame.node.oneOf : void 0;
			if (oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = Array.from(oneOf, (branch) => ({
					node: branch,
					value: frame.value,
					path: frame.path
				}));
				frame.childIndex = 0;
				frame.matches = 0;
				frame.phase = "children";
				continue;
			}
			if (nodeType === void 0) {
				finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path));
				continue;
			}
			switch (nodeType) {
				case "object": {
					if (!isPlainJsonRecord(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an object`]);
						break;
					}
					const properties = Object.hasOwn(frame.node, "properties") ? frame.node.properties ?? {} : {};
					const violations = [];
					const required = Object.hasOwn(frame.node, "required") ? frame.node.required ?? [] : [];
					for (const key of required) if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) violations.push(`missing required property "${propertyPath(frame.path, key)}"`);
					const children = [];
					for (const [key, child] of Object.entries(properties)) {
						if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) continue;
						children.push({
							node: child,
							value: frame.value[key],
							path: propertyPath(frame.path, key)
						});
					}
					const tailViolations = [];
					if (Object.hasOwn(frame.node, "additionalProperties") && frame.node.additionalProperties === false) {
						for (const key of Object.keys(frame.value)) if (!Object.hasOwn(properties, key)) tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`);
					}
					frame.kind = "object";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = violations;
					frame.tailViolations = tailViolations;
					frame.phase = "children";
					break;
				}
				case "array": {
					if (!Array.isArray(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an array`]);
						break;
					}
					const items = Object.hasOwn(frame.node, "items") ? frame.node.items : void 0;
					const children = items === void 0 ? [] : frame.value.flatMap((entry, index) => [{
						node: items,
						value: entry,
						path: `${frame.path}[${index}]`
					}]);
					frame.kind = "array";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = [];
					frame.phase = "children";
					break;
				}
				case "string":
					finish(typeof frame.value === "string" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a string`]);
					break;
				case "number":
					finish(typeof frame.value !== "number" ? [`"${diagnosticPath(frame.path)}" must be a number`] : !isJsonNumber(frame.value) ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "integer":
					finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value) ? [`"${diagnosticPath(frame.path)}" must be an integer`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "boolean":
					finish(typeof frame.value === "boolean" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a boolean`]);
					break;
				case "null":
					finish(frame.value === null ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be null`]);
					break;
				default: finish(assertNever(nodeType, "JsonSchemaType"));
			}
		} catch (error) {
			let failed = frames.pop();
			while (failed !== void 0 && !failed.catches) failed = frames.pop();
			if (failed === void 0) throw error;
			receive(losslessValueViolation(failed.path));
		}
	}
	/* v8 ignore next -- every root frame finishes or throws. */
	return rootResult ?? losslessValueViolation(path);
}
/**
* Validate a candidate value against an asserted raw schema. The function is
* total for arbitrary values and returns path-qualified violations.
* @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
* @param value - the candidate JSON value.
* @param path - root label used in diagnostics.
* @returns All violations in walk order; empty means valid.
*/
function validateJsonSchemaValue(schema, value, path = "value") {
	return checkValue(schema, value, path);
}
//#endregion
//#region ../../sandbox/sandbox/src/escalation.ts
/**
* The escalation vocabulary and choreography shared by every sandbox-enforcing
* tool family (`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-fs`): the
* strictly-wider ladder, the argument-pairing validation, the model-facing
* denial/hint markers, and {@link approveEscalation} — the ordered fail-closed
* sequence that resolves a `sandbox_permissions` request through a
* user-approval channel BEFORE anything executes. One home keeps the two
* families' approval ordering and verbatim error texts from drifting apart.
*
* The channel is a minimal STRUCTURAL function shape ({@link EscalationAsk}),
* not the approval service type: the tool layer — which owns the agent, the
* call id, and the tool name — closes over `ctx.approval.request(...)` and
* hands the closure down, so this package never depends on the approval or
* agent packages.
*
* @module dsh-sandbox/escalation
*/
/**
* The strictly-wider table: what a call whose effective mode is the key may
* escalate TO. Checked at EXECUTION, never baked into a tool schema — the
* schema's enum is {@link ESCALATION_TARGETS}, because schemas are
* registry-global while the effective mode is per-call truth.
*/
const WIDER_MODES = {
	"read-only": ["workspace-write", "danger-full-access"],
	"workspace-write": ["danger-full-access"]
};
/**
* The closed escalation-target vocabulary — every mode a call could ever
* escalate TO (`read-only` is the floor; nothing escalates to it). Advertised
* whenever the mounted capability confines: cutting the enum down to the modes
* wider than the composition's DEFAULT would strand a session whose effective
* mode sits below it (a `danger-full-access` default would advertise nothing
* while a narrower-switched session stays confined with no lever).
*/
const ESCALATION_TARGETS = ["workspace-write", "danger-full-access"];
/**
* Validate the escalation argument pairing a tool schema cannot express:
* `sandbox_permissions` and `justification` travel together — an approval
* prompt without a reason, or a reason driving nothing, is a malformed ask —
* and the justification must be a non-empty sentence.
* @param sandboxPermissions - the raw `sandbox_permissions` argument, if given.
* @param justification - the raw `justification` argument, if given.
*/
function validateEscalationArgs(sandboxPermissions, justification) {
	if (sandboxPermissions !== void 0 && justification === void 0) throw new Error("invalid escalation: sandbox_permissions requires a justification");
	if (justification !== void 0 && sandboxPermissions === void 0) throw new Error("invalid escalation: justification is only valid together with sandbox_permissions");
	if (justification !== void 0 && justification.trim().length === 0) throw new Error("invalid justification: expected a non-empty sentence");
}
/**
* Resolve a sandbox permission request before execution. Repeating the call's
* effective mode returns it without approval. A strictly wider mode requires
* approval and applies only to this call. Narrower or unsupported targets,
* missing approval services or agents for widening, and non-grant outcomes
* throw before execution.
* @param request - the escalation to judge (see {@link EscalationRequest}).
* @param approval - the approval ingredients the tool holds (see {@link EscalationApproval}).
* @returns the granted mode, consumed by the one call that asked.
*/
async function approveEscalation(request, approval) {
	const { requestedMode: mode, effectiveMode, justification, subject } = request;
	if (mode === effectiveMode) return effectiveMode;
	if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode)) throw new Error(`sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`);
	if (approval.approver === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval service is composed`);
	if (approval.agent === void 0) throw new Error(`sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`);
	const outcome = await approval.approver.request({
		agent: approval.agent,
		toolName: approval.toolName,
		callId: approval.callId,
		reason: `escalate sandbox to ${mode}: ${justification}`,
		displayReason: {
			en: `Allow this operation with ${mode} permissions: ${justification}`,
			zh: `允许本次操作使用 ${mode} 权限：${justification}`
		},
		...approval.signal ? { signal: approval.signal } : {}
	});
	switch (outcome) {
		case "allowed-once": return mode;
		case "rejected": throw new Error(`the user rejected escalating this ${subject} to "${mode}"; it stays denied, so stop and explain instead of working around it`);
		case "cancelled": throw new Error(`approval for escalating to "${mode}" was cancelled`);
		case "unavailable": throw new Error(`sandbox escalation to "${mode}" requires approval, but no approval channel is available`);
		default: return assertNever(outcome, "EscalationOutcome");
	}
}
//#endregion
//#region ../../core/tools/src/schema.ts
/** Unified JSON-value schema DSL, inference, compilation, and typed tool helper. @module dsh-tools/schema */
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
/** Throw one author-schema violation through the shared schema error type. */
function authorError(message) {
	throw new JsonSchemaError([message]);
}
/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source, target) {
	if (Object.hasOwn(source, "description")) target.description = source.description;
	if (Object.hasOwn(source, "title")) target.title = source.title;
	if (Object.hasOwn(source, "default")) target.default = source.default;
	if (Object.hasOwn(source, "examples")) target.examples = source.examples;
}
/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source, path, allowed) {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
/** Install a compiled node without giving `__proto__` assignment semantics. */
function assignCompiledNode(destination, node) {
	switch (destination.kind) {
		case "root":
			destination.holder.value = node;
			break;
		case "property":
			Object.defineProperty(destination.target, destination.key, {
				value: node,
				enumerable: true,
				configurable: true,
				writable: true
			});
			break;
		case "item":
			destination.target.items = node;
			break;
		case "one-of":
			destination.target[destination.index] = node;
			break;
	}
}
/** Install a compiled property map at its root or containing object node. */
function assignCompiledPropertyMap(destination, compiled) {
	if (destination.kind === "root") destination.holder.value = compiled;
	else destination.target.properties = compiled.properties;
}
/** Execute an author-schema compilation task graph without recursive descent. */
function runSchemaCompiler(initial) {
	const seen = /* @__PURE__ */ new Set();
	const tasks = [initial];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.input);
			continue;
		}
		if (task.kind === "property-map-tail") {
			if (task.required.length > 0) {
				task.compiled.required = task.required;
				if (task.destination.kind === "object") task.destination.target.required = task.required;
			}
			continue;
		}
		if (task.kind === "property") {
			if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
			if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
			if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
			tasks.push({
				kind: "value",
				input: task.property,
				path: task.path,
				allowRequired: true,
				destination: {
					kind: "property",
					target: task.properties,
					key: task.key
				}
			});
			continue;
		}
		if (task.kind === "property-map") {
			if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`);
			if (seen.has(task.input)) authorError(`${task.path} is circular`);
			seen.add(task.input);
			const compiled = { properties: {} };
			const required = [];
			assignCompiledPropertyMap(task.destination, compiled);
			tasks.push({
				kind: "leave",
				input: task.input
			});
			tasks.push({
				kind: "property-map-tail",
				compiled,
				required,
				destination: task.destination
			});
			const entries = Object.entries(task.input);
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				/* v8 ignore next -- the loop is bounded by the captured entry count. */
				if (entry === void 0) continue;
				tasks.push({
					kind: "property",
					property: entry[1],
					path: `${task.path}.${entry[0]}`,
					key: entry[0],
					properties: compiled.properties,
					required
				});
			}
			continue;
		}
		const { input, path } = task;
		if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`);
		if (seen.has(input)) authorError(`${path} is circular`);
		seen.add(input);
		const authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];
		const node = {};
		assignCompiledNode(task.destination, node);
		tasks.push({
			kind: "leave",
			input
		});
		if (Object.hasOwn(input, "oneOf")) {
			assertAuthorKeys(input, path, [
				...authorKeys,
				"oneOf",
				"type"
			]);
			if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
			if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`);
			const branches = [];
			node.oneOf = branches;
			copyAnnotations(input, node);
			for (let index = input.oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "value",
				input: input.oneOf[index],
				path: `${path}.oneOf[${index}]`,
				allowRequired: false,
				destination: {
					kind: "one-of",
					target: branches,
					index
				}
			});
			continue;
		}
		const inputType = Object.hasOwn(input, "type") ? input.type : void 0;
		switch (inputType) {
			case "json":
				assertAuthorKeys(input, path, [...authorKeys, "type"]);
				copyAnnotations(input, node);
				break;
			case "object":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"properties",
					"additionalProperties"
				]);
				if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties must be explicitly true or false`);
				node.type = "object";
				copyAnnotations(input, node);
				node.additionalProperties = input.additionalProperties;
				if (Object.hasOwn(input, "properties")) tasks.push({
					kind: "property-map",
					input: input.properties,
					path: `${path}.properties`,
					destination: {
						kind: "object",
						target: node
					}
				});
				break;
			case "array":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"items"
				]);
				node.type = "array";
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "items")) tasks.push({
					kind: "value",
					input: input.items,
					path: `${path}.items`,
					allowRequired: false,
					destination: {
						kind: "item",
						target: node
					}
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"enum",
					"const"
				]);
				node.type = inputType;
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "enum")) {
					if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`);
					node.enum = Array.from(input.enum, (entry) => entry);
				}
				if (Object.hasOwn(input, "const")) node.const = input.const;
				break;
			default: authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
		}
	}
}
/** Compile one implicit property map, collecting per-property requiredness. */
function compilePropertyMap(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "property-map",
		input,
		path,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/** Compile one author node without applying any consumer root restriction. */
function compileValueSchema(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "value",
		input,
		path,
		allowRequired: false,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/**
* Compile one author-facing value schema to the enforced raw JSON Schema
* subset. The author-only `json` node becomes an annotation-only schema.
* @param spec - schema for any JSON-value root.
* @returns The asserted raw schema projection.
*/
function valueSchemaSpecToJsonSchema(spec) {
	const schema = compileValueSchema(spec, "schema");
	assertSupportedJsonSchema(schema);
	return schema;
}
/**
* Compile the implicit open parameter object into raw JSON Schema.
* @param spec - per-property parameter definitions.
* @returns An object-rooted raw schema with no implicit-root openness override.
*/
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = {
		type: "object",
		properties: compiled.properties,
		...compiled.required === void 0 ? {} : { required: compiled.required }
	};
	assertSupportedJsonSchema(schema);
	return schema;
}
/** Invalid model-generated arguments for a typed tool. */
var ToolArgsError = class extends HarnessError {
	/** Individual violations in schema-walk order. */
	violations;
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
};
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userProjectContent = options.projectContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.deferLoading === true ? { deferLoading: options.deferLoading } : {},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userProjectContent) tool.projectContent = (exec, result) => userProjectContent(exec, result);
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
//#endregion
//#region ../../core/tools/src/ptc.ts
/**
* PTC mode `run_code` transport. Programs call the registry's agent-visible
* tools through nested executions scheduled under the native concurrency
* contract; each sub-dispatch is logged for reconstruction, while only the
* outer curated result enters model history.
* @module @deepseek-ai/dsh-tools/src/ptc
*/
/** The model-facing name of the PTC mode tool. */
const RUN_CODE_NAME = "run_code";
/**
* The TypeScript flavor: the fallback for a schema read with no runtime
* mounted ({@link resolveFlavor} owns which readers reach that). A real
* assembly always resolves a runtime first, so the model never sees this
* fallback outside its own language.
*/
const TYPESCRIPT_FLAVOR = {
	description: "Execute a TypeScript program against the available tools. Takes two required arguments: `description`, a short summary of what the program does, and `code`, the BODY of an async function (erasable syntax only; top-level `await` and `return` work). Call tools as `await tools.name(args)` per the declarations in the system prompt. Only what you print or return is program output — curate it. Image-bearing subtool results are attached after the run.",
	codeDescription: "The program: the body of an async TypeScript function."
};
/** Per-language `run_code` schema flavors (see {@link RunCodeFlavor}); one entry per {@link PtcSdkLanguage}. */
const RUN_CODE_FLAVORS = {
	typescript: TYPESCRIPT_FLAVOR,
	python: {
		description: "Execute a Python program against the available tools. Takes two required arguments: `description`, a short summary of what the program does, and `code`, the BODY of an async function (top-level `await` and `return` work). Call tools as `await tools.name(args)` per the declarations in the system prompt. Use `print(...)` and/or `return <value>` for program output — curate it. Image-bearing subtool results are attached after the run.",
		codeDescription: "The program: the body of an async Python function."
	}
};
/**
* The `description` parameter's model-facing description: language-independent
* (the UI label contract is the same for every runtime), shared between the
* static spec and the language-aware `parameters` getter so the two emissions
* can never drift.
*/
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION = "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Provide `description` before `code` in the arguments. Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\".";
const RUN_CODE_CONTROLS = {
	timeoutMs: {
		type: "number",
		description: "Positive elapsed-time budget in milliseconds, capped by the deployment maximum."
	},
	sandbox_permissions: {
		type: "string",
		enum: [...ESCALATION_TARGETS],
		description: "Wider sandbox mode for this complete program execution; requires justification and approval."
	},
	justification: {
		type: "string",
		description: "Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request."
	}
};
function controlParameters(runtime) {
	if (runtime === void 0) return RUN_CODE_CONTROLS;
	return {
		...runtime.timeout === void 0 ? {} : { timeoutMs: {
			...RUN_CODE_CONTROLS.timeoutMs,
			description: `Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default ${runtime.timeout.defaultMs}; capped at ${runtime.timeout.maxMs}. Zero does not disable the deadline.`
		} },
		...runtime.sandboxMode === void 0 ? {} : {
			sandbox_permissions: RUN_CODE_CONTROLS.sandbox_permissions,
			justification: RUN_CODE_CONTROLS.justification
		}
	};
}
function escalationGuidance(runtime) {
	return runtime?.sandboxMode === void 0 ? "" : " A sandbox escalation approves this complete program for one execution only. Nested tools retain their own policies and approvals. Request wider access only after evidence of a denial. Earlier effects may already have completed: inspect them before explicitly retrying. Programs are never replayed automatically.";
}
/**
* Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
* schema-emission time so the model-visible `run_code` schema always matches
* the SDK section's language. `peekRuntime` returns `undefined` only when no
* runtime is mounted, which reaches this function through definition readers
* and `schemas()` — the doc-catalog harvest is the only shipped one, and none
* of them feeds a model, because `wireSchemas` calls `requirePtcRuntime`
* before projecting — so that path degrades to {@link TYPESCRIPT_FLAVOR}. A
* mounted runtime whose language has no flavor entry fails loud, exactly as
* `requirePtcRuntime` rejects it at assembly. Keeping this table in step with
* `SDK_RENDERERS` is the compiler's job ({@link PtcSdkLanguage}); what this
* guard owns is the runtime-supplied language neither table knows, which never
* yields a wrong-language schema for a real runtime.
*/
function resolveFlavor(peekRuntime) {
	const runtime = peekRuntime();
	if (runtime === void 0) return TYPESCRIPT_FLAVOR;
	const flavor = RUN_CODE_FLAVORS[runtime.language];
	if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === void 0) {
		const known = Object.keys(RUN_CODE_FLAVORS).map((name) => JSON.stringify(name)).join(", ");
		throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
	}
	return flavor;
}
/**
* Thrown by `run_code` when the program run itself failed — a program
* exception, a budget expiry, an abort, or substrate death. Extends
* {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
* pipeline converts it into a structured `isError` result whose text carries
* the failure kind plus the captured logs, so the model can self-correct.
*/
var CodeRunFailedError = class extends HarnessError {
	constructor(message) {
		super(message, "CODE_RUN_FAILED");
		this.name = "CodeRunFailedError";
	}
};
/**
* Snapshot one binding call's argument as lossless JSON, then snapshot that
* detached value again so dispatch and logging stay independent without
* reintroducing structured-clone's platform-specific nesting limit.
*/
function jsonNormalizeArgs(value) {
	let snapshot;
	try {
		snapshot = snapshotJsonValue(value);
	} catch (error) {
		throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (snapshot === void 0) throw new Error("tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)");
	const logged = snapshotJsonValue(snapshot);
	/* v8 ignore next -- snapshot is already a detached lossless JSON value. */
	if (logged === void 0) throw new Error("tool arguments could not be detached for durable logging");
	return {
		dispatched: snapshot,
		logged
	};
}
/** Two-space JSON presentation, matching the existing shallow `run_code` text contract. */
const JSON_INDENT = "  ";
/**
* ECMAScript caps `JSON.stringify`'s `space` string at ten characters. The
* renderer also caps TOTAL indentation there, compacting deeper subtrees, so
* formatted output remains linear in the canonical JSON size.
*/
const MAX_JSON_INDENT_CHARS = 10;
/** Render one non-string JSON root without recursive traversal or unbounded indentation growth. */
function renderJsonValue(value) {
	const chunks = [];
	const tasks = [{
		kind: "value",
		value,
		depth: 0,
		compact: false
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "text") {
			chunks.push(task.text);
			continue;
		}
		const current = task.value;
		if (current === null || typeof current === "boolean" || typeof current === "number") {
			chunks.push(String(current));
			continue;
		}
		if (typeof current === "string") {
			chunks.push(JSON.stringify(current));
			continue;
		}
		const compact = task.compact || (task.depth + 1) * 2 > MAX_JSON_INDENT_CHARS;
		const childDepth = task.depth + 1;
		if (Array.isArray(current)) {
			chunks.push("[");
			if (current.length === 0) {
				chunks.push("]");
				continue;
			}
			tasks.push({
				kind: "text",
				text: compact ? "]" : `\n${JSON_INDENT.repeat(task.depth)}]`
			});
			for (let index = current.length - 1; index >= 0; index--) {
				const item = current[index];
				/* v8 ignore next -- canonical JsonValue arrays are dense. */
				if (item === void 0) throw new Error("cannot render a sparse JSON array");
				tasks.push({
					kind: "value",
					value: item,
					depth: childDepth,
					compact
				});
				tasks.push({
					kind: "text",
					text: compact ? index === 0 ? "" : "," : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}`
				});
			}
			continue;
		}
		const keys = Object.keys(current);
		chunks.push("{");
		if (keys.length === 0) {
			chunks.push("}");
			continue;
		}
		tasks.push({
			kind: "text",
			text: compact ? "}" : `\n${JSON_INDENT.repeat(task.depth)}}`
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) throw new Error("cannot render a missing JSON object key");
			const item = current[key];
			/* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
			if (item === void 0) throw new Error("cannot render an undefined JSON object property");
			tasks.push({
				kind: "value",
				value: item,
				depth: childDepth,
				compact
			});
			tasks.push({
				kind: "text",
				text: compact ? `${index === 0 ? "" : ","}${JSON.stringify(key)}:` : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `
			});
		}
	}
	return chunks.join("");
}
/** Render one present program completion value for the model-facing result text. */
function renderValue(value) {
	return typeof value === "string" ? value : renderJsonValue(value);
}
/**
* Build the `run_code` {@link ToolDefinition}: required `description` and
* `code` parameters, executed through the dispatch bridge described
* above. The
* registry reserves it as presentation infrastructure under non-native modes,
* outside the filterable global/scoped capability layers.
* @param registry - the owning registry (sub-calls go through its `execute`,
*   bindings cover its registered tools).
* @param options - the registry-private capabilities described above.
* @returns the registry-ready definition.
*/
function createRunCodeTool(registry, options) {
	const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options;
	const definition = defineTool({
		name: RUN_CODE_NAME,
		description: TYPESCRIPT_FLAVOR.description,
		parameters: {
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			},
			code: {
				type: "string",
				required: true,
				description: TYPESCRIPT_FLAVOR.codeDescription
			},
			...RUN_CODE_CONTROLS
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					logs: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					result: { type: "json" },
					sandbox: {
						type: "object",
						additionalProperties: false,
						properties: {
							mode: {
								type: "string",
								required: true,
								enum: [
									"read-only",
									"workspace-write",
									"danger-full-access"
								]
							},
							denied: {
								type: "boolean",
								required: true
							},
							enforcement: {
								type: "string",
								enum: ["full", "partial"]
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const rendered = value.result === void 0 ? "" : renderValue(value.result);
				const parts = [value.logs.join("\n"), rendered].filter((part) => part.length > 0);
				if (value.sandbox?.enforcement === "partial") parts.push("File sandbox enforcement is partial on this host.");
				if (value.sandbox?.denied) parts.push(`The ${value.sandbox.mode} file sandbox denied an operation.${escalationGuidance(peekRuntime())}`);
				return [{
					type: "text",
					text: parts.length > 0 ? parts.join("\n") : "(run_code completed with no output)"
				}];
			}
		},
		async execute(args, exec) {
			if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
			const runtime = requireRuntime();
			validateEscalationArgs(args.sandbox_permissions, args.justification);
			if (args.timeoutMs !== void 0 && runtime.timeout === void 0) throw new Error("timeoutMs is not available for this PTC runtime");
			if (args.timeoutMs !== void 0 && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) throw new Error("invalid timeoutMs: expected a positive finite number");
			const standingPolicy = runtime.sandboxMode === void 0 ? void 0 : options.resolveSandboxPolicy(exec);
			let policy = standingPolicy;
			if (args.sandbox_permissions !== void 0 && args.justification !== void 0) {
				if (standingPolicy === void 0) throw new Error("sandbox_permissions is not available for this PTC runtime");
				const approvedMode = await approveEscalation({
					requestedMode: args.sandbox_permissions,
					justification: args.justification,
					effectiveMode: standingPolicy.mode,
					subject: "program"
				}, {
					approver: options.peekApprover(),
					agent: exec.agent,
					callId: exec.callId,
					toolName: RUN_CODE_NAME,
					signal: exec.signal
				});
				policy = {
					...standingPolicy,
					mode: approvedMode
				};
			}
			const cwd = await options.resolveWorkingDirectory(exec);
			exec.signal.throwIfAborted();
			const runController = new AbortController();
			const onOuterAbort = () => {
				runController.abort(exec.signal.reason);
			};
			exec.signal.addEventListener("abort", onOuterAbort, { once: true });
			let dispatches = 0;
			const pendingQueue = [];
			const inFlight = /* @__PURE__ */ new Set();
			/** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
			const logWork = /* @__PURE__ */ new Set();
			const commitQueue = [];
			let exclusiveActive = false;
			let driving = false;
			let driverRun = Promise.resolve();
			let wake;
			const wakeup = () => {
				const release = wake;
				wake = void 0;
				release?.();
			};
			/**
			* The single ordered lane. Each pass commits the head-of-line settled
			* dispatch (ordered post-execute), then starts the next queued entry if
			* its slot is free (ordered pre-execute), and otherwise sleeps until a
			* body settles or a new submission arrives. One run reaching the
			* empty-queues/empty-pool state is quiescence.
			*/
			const drive = () => {
				if (driving) return driverRun;
				driving = true;
				driverRun = (async () => {
					try {
						for (;;) {
							const signal = new Promise((resolve) => {
								wake = resolve;
							});
							const commitHead = commitQueue[0];
							if (commitHead !== void 0 && commitHead.settled) {
								commitQueue.shift();
								await commitHead.commit();
								if (commitHead.mode === "exclusive") exclusiveActive = false;
								continue;
							}
							const head = pendingQueue[0];
							if (head !== void 0) {
								if (runController.signal.aborted) {
									pendingQueue.shift();
									head.abandon();
									continue;
								}
								const mode = head.classify();
								if (!exclusiveActive && (mode === "exclusive" ? inFlight.size === 0 : inFlight.size < maxParallel)) {
									if (mode === "exclusive") exclusiveActive = true;
									head.mode = mode;
									pendingQueue.shift();
									commitQueue.push(head);
									await head.start();
									const flight = head.flight.finally(() => {
										inFlight.delete(flight);
										wakeup();
									});
									inFlight.add(flight);
									continue;
								}
							}
							if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return;
							await signal;
						}
					} finally {
						driving = false;
						wake = void 0;
					}
				})();
				return driverRun;
			};
			/** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
			const drainDispatches = async () => {
				await drive();
				while (logWork.size > 0) await Promise.allSettled([...logWork]);
			};
			const runOver = () => runController.signal.aborted;
			const binding = (schema) => async (rawArgs) => {
				const { name } = schema;
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`);
				const normalized = jsonNormalizeArgs(rawArgs);
				const n = ++dispatches;
				const subCallId = brandString(`${String(exec.callId)}:ptc:${n}`);
				const input = {
					callId: subCallId,
					rootCallId: exec.rootCallId,
					name,
					schema,
					arguments: normalized.dispatched,
					...exec.agent ? { agent: exec.agent } : {},
					parent: exec.token,
					signal: runController.signal
				};
				const scheduler = registry[TOOL_RUNTIME_SCHEDULER];
				const outcome = await new Promise((resolve, reject) => {
					let parked;
					const settle = (result) => {
						resolve(result.isError ? {
							isError: true,
							message: result.error.message
						} : {
							isError: false,
							value: result.value
						});
						const agent = exec.agent;
						if (agent === void 0) return;
						const task = (async () => {
							const logged = await shapeDispatchLog({
								exec,
								agent,
								subCallId,
								name,
								isError: result.isError,
								content: result.content
							});
							agent.session.append("tool/ptc-dispatch", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged,
								isError: result.isError,
								...result.error?.info === void 0 ? {} : { error: result.error.info },
								content: logged,
								...result.meta === void 0 ? {} : { meta: result.meta }
							});
						})().finally(() => {
							logWork.delete(task);
						});
						logWork.add(task);
					};
					pendingQueue.push({
						flight: Promise.resolve(),
						settled: false,
						classify: () => registry.executionMode(input).kind,
						abandon: () => {
							reject(/* @__PURE__ */ new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`));
						},
						async start() {
							exec.agent?.session.append("tool/ptc-dispatch-start", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged
							});
							const prepared = await scheduler.prepare(input);
							if (prepared.kind === "dispatch") {
								this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
									parked = {
										kind: dispatchOutcome.kind,
										exec: prepared.exec,
										result: dispatchOutcome.result
									};
									this.settled = true;
								});
								return;
							}
							parked = {
								kind: prepared.kind,
								exec: prepared.exec,
								result: prepared.result
							};
							this.settled = true;
						},
						async commit() {
							/* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
							if (parked === void 0) return;
							const result = parked.kind === "post-result" ? await scheduler.finalize(parked.exec, parked.result) : scheduler.finish(parked.exec, parked.result);
							if (!result.isError && result.content.some((block) => block.type === "image")) exec.deferContext(createUserMessage({
								content: result.content,
								source: { kind: "ptc-mode" }
							}));
							for (const context of result.additionalContexts ?? []) exec.deferContext(context);
							if (result.concludesTurn) exec.concludeTurn();
							settle(result);
							while (logWork.size > maxParallel) await Promise.race(logWork);
						}
					});
					wakeup();
					drive();
				});
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} result discarded`);
				if (outcome.isError) throw new Error(outcome.message);
				return outcome.value;
			};
			const functions = Object.create(null);
			for (const schema of registry.schemas(exec.agent)) {
				if (schema.name === "run_code") continue;
				Object.defineProperty(functions, schema.name, {
					enumerable: true,
					value: binding(deepFreeze(schema))
				});
			}
			try {
				let result;
				try {
					result = await runtime.run(runtime.resolve({
						program: args.code,
						bindings: [{
							global: "tools",
							functions,
							errorClass: {
								name: "ToolCallError",
								memberNameProperty: "toolName"
							}
						}],
						signal: runController.signal,
						...cwd !== void 0 ? { cwd } : {},
						...policy !== void 0 ? { sandboxPolicy: policy } : {},
						...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {}
					}));
				} finally {
					runController.abort("run_code settled");
					await drainDispatches();
				}
				if (result.error) {
					const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join("\n")}` : "";
					const sandboxText = result.sandbox === void 0 ? "" : `\nFile sandbox: ${result.sandbox.mode}${result.sandbox.enforcement === void 0 ? "" : `; enforcement: ${result.sandbox.enforcement}`}${result.sandbox.denied ? "; operation denied" : ""}.`;
					throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}${sandboxText}${result.sandbox?.denied ? escalationGuidance(runtime) : ""}`);
				}
				return {
					logs: result.logs,
					...result.sandbox === void 0 ? {} : { sandbox: result.sandbox },
					...result.value !== void 0 ? { result: result.value } : {}
				};
			} finally {
				exec.signal.removeEventListener("abort", onOuterAbort);
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.description,
			kind: "execute",
			rawInput: args.code
		})
	});
	Object.defineProperty(definition, "description", {
		enumerable: true,
		get: () => {
			const runtime = peekRuntime();
			const instructions = runtime?.executionInstructions;
			return resolveFlavor(peekRuntime).description + (instructions ? ` ${instructions}` : "") + (runtime === void 0 ? "" : " Each program starts in the Session's current directory. Running programs keep their initial directory.") + escalationGuidance(runtime);
		}
	});
	Object.defineProperty(definition, "parameters", {
		enumerable: true,
		get: () => parameterSchemaSpecToJsonSchema({
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			},
			code: {
				type: "string",
				required: true,
				description: resolveFlavor(peekRuntime).codeDescription
			},
			...controlParameters(peekRuntime())
		})
	});
	return definition;
}
//#endregion
//#region ../../core/tools/src/ts-types.ts
/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER$1 = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name) {
	return IDENTIFIER$1.test(name) ? name : JSON.stringify(name);
}
/** One `indent`-deep line prefix (two spaces per level). */
function pad$1(indent) {
	return "  ".repeat(indent);
}
/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines$1(description, indent) {
	if (typeof description !== "string" || description.length === 0) return [];
	const collapsed = description.replace(/\s+/g, " ").trim();
	return [`${pad$1(indent)}/** ${collapsed.replaceAll("*/", String.raw`*\/`)} */`];
}
/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value) {
	return JSON.stringify(value);
}
/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar$1(node, type) {
	const broad = type === "integer" ? "number" : type;
	if (Object.hasOwn(node, "const")) return renderScalar(node.const);
	if (Object.hasOwn(node, "enum")) return node.enum.map(renderScalar).join(" | ");
	return broad;
}
/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
function typeDocumentFrom(parts) {
	return {
		parts,
		containsUnionOrIntersection: parts.some((part) => typeof part === "string" ? part.includes("|") || part.includes("&") : part.containsUnionOrIntersection)
	};
}
/** Build a small document without an intermediate array at each call site. */
function typeDocument(...parts) {
	return typeDocumentFrom(parts);
}
/** Flatten a nested document with an explicit work stack. */
function flattenTypeDocument(document) {
	const chunks = [];
	const tasks = [document];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (typeof task === "string") {
			chunks.push(task);
			continue;
		}
		for (let index = task.parts.length - 1; index >= 0; index--) {
			const part = task.parts[index];
			/* v8 ignore next -- the loop is bounded by the captured part count. */
			if (part !== void 0) tasks.push(part);
		}
	}
	return chunks.join("");
}
/** Initialize one schema-render frame with empty aggregation state. */
function schemaRenderFrame(node, indent) {
	return {
		node,
		indent,
		phase: "start",
		children: [],
		childIndex: 0,
		childDocuments: [],
		entries: []
	};
}
/** Render an already asserted schema to a composable document. */
function renderSupportedSchema(schema, indent) {
	const frames = [schemaRenderFrame(schema, indent)];
	let rootDocument;
	const finish = (document) => {
		frames.pop();
		const parent = frames.at(-1);
		if (parent === void 0) rootDocument = document;
		else parent.childDocuments.push(document);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		if (frame.phase === "children") {
			if (frame.childIndex < frame.children.length) {
				const child = frame.children[frame.childIndex];
				/* v8 ignore next -- childIndex is bounded by children.length. */
				if (child === void 0) throw new Error("missing schema render child");
				frame.childIndex++;
				frames.push(schemaRenderFrame(child.node, child.indent));
				continue;
			}
			if (frame.kind === "oneOf") {
				const parts = [];
				for (let index = 0; index < frame.childDocuments.length; index++) {
					if (index > 0) parts.push(" | ");
					const child = frame.childDocuments[index];
					/* v8 ignore next -- child documents correspond one-to-one with children. */
					if (child !== void 0) parts.push(child);
				}
				finish(typeDocumentFrom(parts));
				continue;
			}
			if (frame.kind === "array") {
				const child = frame.childDocuments[0];
				/* v8 ignore next -- array frames always schedule exactly one child. */
				if (child === void 0) throw new Error("missing array item type");
				finish(child.containsUnionOrIntersection ? typeDocument("(", child, ")[]") : typeDocument(child, "[]"));
				continue;
			}
			const required = new Set(frame.node.required);
			const parts = ["{"];
			for (let index = 0; index < frame.entries.length; index++) {
				const entry = frame.entries[index];
				const child = frame.childDocuments[index];
				/* v8 ignore next -- object entries and child documents have the same length. */
				if (entry === void 0 || child === void 0) throw new Error("missing object property type");
				const [name, prop] = entry;
				for (const line of docLines$1(prop.description, frame.indent + 1)) parts.push("\n", line);
				parts.push("\n", `${pad$1(frame.indent + 1)}${renderKey(name)}${required.has(name) ? "" : "?"}: `, child, ";");
			}
			parts.push("\n", `${pad$1(frame.indent)}}`);
			const declared = typeDocumentFrom(parts);
			finish(frame.node.additionalProperties === false ? declared : typeDocument(declared, " & Record<string, JsonValue>"));
			continue;
		}
		const node = frame.node;
		if (node.oneOf !== void 0) {
			frame.kind = "oneOf";
			frame.children = Array.from(node.oneOf, (child) => ({
				node: child,
				indent: frame.indent
			}));
			frame.childIndex = 0;
			frame.childDocuments = [];
			frame.phase = "children";
			continue;
		}
		if (node.type === void 0) {
			finish(typeDocument("JsonValue"));
			continue;
		}
		switch (node.type) {
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				finish(typeDocument(renderConstrainedScalar$1(node, node.type)));
				break;
			case "array":
				if (node.items === void 0) finish(typeDocument("JsonValue[]"));
				else {
					frame.kind = "array";
					frame.children = [{
						node: node.items,
						indent: frame.indent
					}];
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			case "object": {
				const open = node.additionalProperties !== false;
				const entries = Object.entries(node.properties ?? {});
				if (entries.length === 0) finish(typeDocument(open ? "Record<string, JsonValue>" : "Record<string, never>"));
				else {
					frame.kind = "object";
					frame.entries = entries;
					frame.children = entries.map(([, child]) => ({
						node: child,
						indent: frame.indent + 1
					}));
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			}
			/* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
			default: finish(typeDocument("unknown"));
		}
	}
	/* v8 ignore next -- every root frame produces one document. */
	return rootDocument ?? typeDocument("unknown");
}
/**
* Map one enforced JSON-Schema node to a TypeScript type literal. Supports
* every unified schema construct and returns `unknown` for malformed or
* unsupported inputs without throwing.
* @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
* @param indent - the indentation level for nested object members.
* @returns the TS type text (multi-line for objects with properties).
*/
function jsonSchemaToTs(schema, indent = 0) {
	try {
		assertSupportedJsonSchema(schema);
		return flattenTypeDocument(renderSupportedSchema(schema, indent));
	} catch {
		return "unknown";
	}
}
/** The fixed model-facing usage contract rendered above the declarations (see the PTC mode Agent Note's "What the model sees"). */
const SDK_INSTRUCTIONS$1 = `## Writing code for run_code

\`run_code\` takes two required arguments: \`description\`, a short summary of what the program does, and \`code\` — the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped). The declarations below are SDK bindings for this program. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly.`;
const SDK_PROGRAM_INSTRUCTIONS = `Inside the program:

- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. Only what you print or return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

Program-only SDK bindings:`;
/** Whether one string schema accepts the literal used by the bash example. */
function acceptsExampleString(schema, value) {
	return schema?.type === "string" && (schema.const === void 0 || schema.const === value) && (schema.enum === void 0 || schema.enum.includes(value));
}
/** Render the bash example only when its literal arguments satisfy the current parameter schema. */
function renderBashExample(schemas) {
	const bash = schemas.find((schema) => schema.name === "bash");
	if (bash === void 0) return "";
	const parameters = bash.parameters;
	if (parameters.type !== "object") return "";
	const required = parameters.required ?? [];
	if (required.some((name) => name !== "command" && name !== "description")) return "";
	if (!acceptsExampleString(parameters.properties?.command, "pwd")) return "";
	const needsDescription = required.includes("description");
	if (needsDescription && !acceptsExampleString(parameters.properties?.description, "Show current directory")) return "";
	return ` When no separate \`bash\` schema is supplied, invoke a declared \`bash\` binding inside \`run_code\`:\n\n\`run_code({ description: "Show current directory", code: "return await tools.bash({ ${needsDescription ? "description: 'Show current directory', " : ""}command: 'pwd' })" })\``;
}
/**
* Render the full `tools:sdk` prompt section: the fixed usage instructions
* plus one `declare const tools` interface covering every given tool.
* Deterministic — tools are emitted in lexicographic name order, so an
* unchanged tool set produces byte-identical text across assemblies. The sort
* is not a total order on byte-equal names, so two schemas sharing a name
* would render in argument order; the caller's visible-capability map is keyed
* by name, so the input never carries a duplicate.
* @param schemas - the tool schemas to declare (the caller excludes
*   `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdk(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const argsMembers = [];
	const outputMembers = [];
	for (const schema of sorted) {
		argsMembers.push(...docLines$1(schema.description, 1));
		argsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);
		outputMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`);
	}
	const declaration = [
		`interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join("\n")}\n` : ""}}`,
		`interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join("\n")}\n` : ""}}`,
		"type ToolName = keyof ToolOutputMap",
		[
			"declare class ToolCallError extends Error {",
			"  readonly name: \"ToolCallError\";",
			"  readonly toolName: ToolName;",
			"}"
		].join("\n"),
		[
			"declare const tools: {",
			"  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;",
			"}"
		].join("\n")
	].join("\n\n");
	return `${SDK_INSTRUCTIONS$1}${renderBashExample(sorted)}\n\n${SDK_PROGRAM_INSTRUCTIONS}\n\n\`\`\`ts\ntype JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }\n\n${declaration}\n\`\`\``;
}
//#endregion
//#region ../../core/tools/src/py-types.ts
/**
* PTC mode codegen — Python flavor. The pure projection from registered tool schemas to the
* Python SDK text the model programs against under `runtime.language === 'python'`. Sibling of
* {@link ./ts-types.ts | ts-types.ts}; the two files are two projections of the same registry
* store, keyed by the loaded {@link @deepseek-ai/dsh-ptc-runtime#PtcRuntime.language | PTC
* runtime's language}.
*
* Under `mode: 'ptc'` the native tool schemas are omitted from the request, so this generated
* SDK is the model's ONLY source for each tool's argument names, required fields, types,
* descriptions, and canonical output types. Object-shaped arguments and outputs render as one
* named `TypedDict` per tool (and per nested object), not an opaque `dict[str, Any]`, so the
* shape survives into the program under the mode that has nothing else to carry it.
* @module @deepseek-ai/dsh-tools/src/py-types
*/
/**
* The reference grammar's `xid_start xid_continue*` — the set
* `str.isidentifier()` accepts on a CPython whose Unicode tables match the
* engine's. See {@link isBareIdentifier} for what a version skew does.
*/
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
/**
* Whether a name can be emitted as a bare Python identifier rather than
* routed to the subscript/`dict[str, Any]` path.
*
* Python identifiers are not ASCII: `路径` is as legal a field name as `path`,
* and rejecting it would degrade the whole enclosing object, dropping every
* field's name, requiredness, and type — information whose only source under
* `mode: 'ptc'` is this generated text.
*
* NFKC stability is a second and separate condition, because CPython
* normalizes identifiers at compile time while JSON keys are compared as
* written: `ﬁeld` would be declared and reachable as `field`, so the SDK would
* advertise a key under a spelling the harness never accepts, and two keys
* that normalize together would collapse into one declaration. Those names
* take the subscript path, which carries their exact bytes.
*
* `IDENTIFIER` matches `str.isidentifier()` (measured on Node 22.23.1 vs
* CPython 3.9.6 tables): the equivalence holds inside the two versions' shared
* tables, and the skew characters below are exactly where that pair diverges.
* The predicate as a whole is deliberately stricter than `isidentifier()`,
* which does not test NFKC stability: `'ﬁeld'.isidentifier()` is True and
* this returns false.
*
* Both conditions are evaluated against the ENGINE's Unicode tables, and the
* two sides are versioned independently — `\p{XID_Start}`/`\p{XID_Continue}`
* follow the running engine (Node 22.23.1 reports Unicode 17.0) while CPython
* follows its own (3.9.6 reports 13.0.0). The skew is not symmetric. A CPython
* older than the engine is the dangerous direction: a character added to either
* property since its tables (U+10570 Vithkuqi and U+1E290 Toto, 14.0; U+1E4D0
* Nag Mundari, 15.0; U+1C89 Cyrillic TJE, 16.0 — ages per `DerivedAge.txt`; all
* four are NFKC-stable and accepted here, and all four are `Cn` on that 3.9.6,
* which rejects them) is emitted bare and its tokenizer refuses the character,
* taking the whole SDK block down — the same parseability invariant
* {@link UNPRINTABLE}, {@link LONE_SURROGATE} and {@link MAX_LIST_NESTING}
* exist for. Both properties carry it: a character added only to `XID_Continue`
* passes the trailing `\p{XID_Continue}*` in a tail position and fails the same
* way — U+200C ZWNJ and U+200D ZWJ are that case, gaining `XID_Continue` in UCD
* 15.1 and absent from it in 13.0.0, 14.0.0 and 15.0.0, so `a\u{200C}b` is
* emitted bare here while `isidentifier()` is False on 3.9.6 and on 3.12.13
* (15.0.0). A CPython newer than the engine only routes a legal name to the
* subscript/`dict[str, Any]` path: less readable, still correct. The NFKC
* condition reduces to the same skew, since normalization stability guarantees
* an assigned character's normalization never changes afterwards.
*
* This predicate is not the only reader of engine tables. {@link camelCase}
* reads them at three further points — its split set, its head test, and its
* `toUpperCase()` case mapping — and this predicate's verdict gates none of
* them: a class name derived there reaches emitted text whenever any object
* shape in the tool's schema declares a `TypedDict`, including for a tool this
* predicate rejected. A tool named `zz-\u{1E4D0}x` with such parameters never
* reaches the skew here (the `-` rejects it outright) yet emits `class
* Zz\u{1E4D0}xArgs`, which that same 3.9.6 refuses — Nag Mundari arrived two
* releases after its tables. The case mapping is a separate table rather than
* an XID membership test, and it fails on names both conditions above accept:
* `\u{019B}` is XID_Start and NFKC-stable, so this predicate accepts it and
* `async def \u{019B}` compiles on 3.9.6, but Node uppercases it to
* `\u{A7DC}` — unassigned in that CPython, whose own `.upper()` is the identity
* here — and the declared `class \u{A7DC}Args` fails with `invalid
* non-printable character U+A7DC`. Closing the exposure therefore covers all
* four read points, not this predicate alone; it needs the target interpreter's
* version, which the backend reporting `language: 'python'` owns; the
* language-dispatch Agent Note records the deferral.
*
* The `ts-types` sibling keeps its own ASCII rule rather than sharing this
* one: ECMAScript identifiers are a different set (`$`) and are never
* normalized, so one predicate cannot be correct for both. ZWJ/ZWNJ are not
* part of that difference — both sets carry them on the engine's tables; what
* separates the two there is the CPython table version above.
* @param name - the raw schema field or tool name.
* @returns whether the name can be emitted bare.
*/
function isBareIdentifier(name) {
	return IDENTIFIER.test(name) && name.normalize("NFKC") === name;
}
/**
* Python hard keywords: reserved everywhere, so a tool or field named
* ``class`` or ``lambda`` is legal on the wire but not as an attribute
* (``tools.class`` would be a SyntaxError in the model program) and not as a
* class-syntax `TypedDict` field. Such a tool renders under subscript access
* and such an object degrades to ``dict[str, Any]`` — the model still reaches
* every tool and field without collisions.
* Soft keywords (``match``, ``case``, ``type``, ``_`` — the language
* reference's whole set) are deliberately ABSENT: each is special in exactly
* one syntactic position — a statement head (``match``, ``type``), a ``match``
* statement's clause head (``case``), or a pattern (``_``) — so ``match: str``
* as a field and ``async def match(...)`` as a method are both legal, and
* including them would needlessly degrade common search/regex tool fields to
* ``dict[str, Any]``. Underscore-leading names are handled separately, not
* here: a non-dunder ``__token`` name-mangles, a dunder present on
* ``object``/``type`` resolves before the proxy hook, and implicit
* special-method lookup bypasses the hook.
*/
const RESERVED = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	"__debug__"
]);
/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = [
	"Any",
	"Literal",
	"NotRequired",
	"Protocol",
	"TypedDict"
];
/** `indent`-deep line prefix (four spaces per level to match PEP 8 output). */
function pad(indent) {
	return "    ".repeat(indent);
}
/**
* The `Cc` code points that survive the whitespace collapse in {@link describe}
* and have no printable form: the C0 controls, DEL, and the C1 controls. Only
* U+0009 to U+000D are absent, because ECMAScript `\s` already collapsed them —
* `\s` is TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus LF/CR/LS/PS, so no C1 code point is
* in it and the whole U+0080 to U+009F block reaches this rule intact. Those
* are not hypothetical input: they are what Windows-1252 bytes 0x80 to 0x9F
* (smart quotes, em dash) become when decoded as Latin-1.
* CPython rejects source containing a NUL outright
* (`SyntaxError: source code string cannot contain null bytes`), whether it
* sits in a docstring or in a comment, so one such byte anywhere in a schema
* description would make the whole generated SDK unparseable — under
* `mode: 'ptc'`, the model's only declaration of the tools. The rest are
* legal but invisible; escaping them with the same rule keeps the emitted text
* readable and the treatment uniform.
*
* The boundary is the category, not per-code-point addressability: `\xNN`
* addresses U+0000 to U+00FF, so one escape form covers `Cc` exactly. The
* invisible `Cf` formatting characters pass through by design — of them only
* U+00AD soft hyphen would fit `\xNN` at all, and escaping that one while
* U+200B ZWSP, U+200E/U+200F bidi marks, and U+2060 word joiner passed through
* would leave a rule that is neither category- nor addressability-shaped. The
* whole family is legal in both consumers, since only LF and CR terminate a
* Python string literal or a `#` comment. That set is the tokenizer's, not
* `str.splitlines()`': NEL (U+0085), LS (U+2028), and PS (U+2029) split a
* string at run time but do not end a physical line in source — measured on
* CPython 3.9.6 and 3.12.13, each accepted in both positions with the value
* round-tripping — so they are safe raw wherever they reach emitted text
* unescaped, which for all three is `JSON.stringify`, at two call sites:
* {@link pyScalar}'s literal path, and the subscript tool-name comment's own
* call, which a name carrying any of them always reaches, none being
* `XID_Continue`. The `description` path escapes NEL under the class above and
* folds LS and PS in {@link describe}'s `\s+` collapse, both being `\s`.
*/
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
/**
* Unpaired surrogate code points, escaped by {@link describe} as `\uNNNN` —
* its own form, since `\xNN` stops at U+00FF. The `u` flag is what makes this
* the LONE ones: in Unicode mode a well-formed pair is a single astral code
* point outside D800 to DFFF, so an emoji in a description survives untouched.
*
* This is the NUL case from {@link UNPRINTABLE}, not the invisible-character
* case. Python source must be UTF-8-encodable and a lone surrogate is not, so
* `compile()` raises `UnicodeEncodeError: surrogates not allowed` for one
* anywhere in the text — measured on 3.9 for a string literal and for a `#`
* comment alike. A raw or MCP tool description reaches this: `JSON.parse` on a
* wire `"\ud800"` escape yields exactly such a code point.
*/
const LONE_SURROGATE = /[\ud800-\udfff]/gu;
/**
* The collapsed one-line `description` of a schema node (byte-stable across
* formatting churn), or `undefined` when the node carries none. Every caller
* passes an object — a validated property node, the `ToolSdkSchema` itself, or
* the `{ description }` wrapper {@link docLines} synthesizes — so only the
* description field needs guarding. A description that collapses
* to nothing (empty, or whitespace only) is `undefined` too: it documents the
* node no better than an absent one, and emitting it would leave an empty
* `"""` docstring or a bare `#   ` line in the SDK. Only ECMAScript whitespace
* folds, so a description of whitespace plus one surviving control character is
* NOT absent: it collapses to that character's visible escape.
*
* Control characters left over after the whitespace collapse are rendered as
* their `\xNN` escapes (see {@link UNPRINTABLE}) and unpaired surrogates as
* their `\uNNNN` escapes (see {@link LONE_SURROGATE}); the escape's own backslash is
* emitted literally by both consumers, since {@link docLines} doubles it into a
* Python source escape and a `#` comment carries it verbatim.
*/
function describe(schema) {
	const description = schema.description;
	if (typeof description !== "string") return void 0;
	const collapsed = description.replace(/\s+/g, " ").replace(UNPRINTABLE, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`).replace(LONE_SURROGATE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).trim();
	return collapsed.length === 0 ? void 0 : collapsed;
}
/**
* One-line docstring for a tool `description`, or no lines when there is none.
* Backslashes are doubled first, every quote is escaped, and a trailing
* backslash cannot survive: a description ending in `"` or an odd backslash
* would otherwise merge with (or escape) the closing triple quote and make
* the generated block — PTC mode's only SDK — syntactically invalid Python.
*/
function docLines(description, indent) {
	const collapsed = describe({ description });
	if (collapsed === void 0) return [];
	const escaped = collapsed.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
	return [`${pad(indent)}"""${escaped}"""`];
}
/**
* CamelCase a name into a Python type identifier: non-identifier characters
* split words, `_` splits too (it is `XID_Continue`, so the split set names it
* explicitly), and a head that cannot start an identifier takes a `Tool`
* prefix. Unicode survives, so a `路径` field yields `路径`-based class names
* instead of collapsing to the bare prefix. A character that is not
* `XID_Continue` splits even when it is a letter, so a name whose NFKC folding
* would leave the identifier set is not carried through — the split set is the
* grammar's, not an ASCII approximation of it.
*
* The result is NFKC-normalized: these names are generated, never matched
* against a JSON key, so normalizing is free here and keeps what CPython
* compiles identical to what is emitted — unlike {@link isBareIdentifier},
* which must reject unstable names outright. Normalizing AFTER the prefix
* decision is what makes that hold at the seam the prefix creates: `Tool` +
* a combining-mark head composes there (`U+0301` gives `Tooĺ`, U+013A), so
* normalizing only the un-prefixed part would emit a name CPython compiles to
* a different symbol. The second call is idempotent on the un-prefixed arm.
*
* The split set, the head test, and `toUpperCase()` all read the engine's
* Unicode tables, so this function carries the same version skew
* {@link isBareIdentifier} documents, by paths independent of it: a class name
* derived here reaches emitted text whenever any object shape in the tool's
* schema declares a `TypedDict`, and the predicate's verdict on the tool name
* does not gate that. The case mapping is the one that can fail on a name the
* predicate accepted; the worked example is there.
* @param raw - the schema field or tool name to derive from.
* @returns a class-name segment safe to emit.
*/
function camelCase(raw) {
	const joined = raw.split(/[^\p{XID_Continue}]+|_+/u).filter((part) => part.length > 0).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("").normalize("NFKC");
	return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize("NFKC");
}
/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120;
/**
* Deepest `list[…]` nesting emitted into one annotation before the item type
* degrades to `Any`. CPython's tokenizer rejects a logical line holding more
* than 200 simultaneously-open brackets (`MAXLEVEL`, `SyntaxError: too many
* nested parentheses`), so an array chain deeper than that would render an SDK
* block that is not valid Python at all — the same failure the docstring
* escaping in {@link docLines} exists to prevent. 180 leaves headroom for the
* few brackets an annotation can add around the chain, all of which count
* toward the same limit. Per emission site, counting brackets open at the
* chain's innermost point:
*
* - Return annotation, `async def f(self, args: X) -> chain:` — 180 `list[`
*   plus an innermost `Literal[`. The parameter list's `(` closed at the `)`
*   before the `->`, so it is NOT open here: 181.
* - TypedDict field, `field: NotRequired[chain]` — a class-body line with no
*   other open bracket, and its children start at `listDepth: 1` to reserve
*   the `NotRequired[`, so 179 `list[` plus `Literal[`: 181. Required fields
*   share that start for uniformity, spending one level of representable depth
*   on a bracket they never emit.
* - Argument annotation, `async def f(self, args: chain) -> Y:` — the `(` IS
*   still open around it: 180 `list[` plus `Literal[` plus the paren, 182, the
*   worst case. Reachable only through a raw `register()` whose `parameters`
*   is an array reached from the root through `oneOf` arms alone — the root
*   array itself, or one nested under any depth of unions, since an arm
*   inherits the enclosing depth unchanged (`A | B` opens no bracket). An
*   object ancestor takes it out of this case: its fields restart the chain at
*   the 181 site. `defineTool` compiles an object root, so the annotation is a
*   bare TypedDict class name or a one-bracket `dict[str, Any]` when that
*   object degrades — never a chain.
*
* A CPython grammar limit, not a deployment choice, so it is fixed rather than
* configurable. The sibling `ts-types` renderer needs no counterpart: nothing
* in the TypeScript grammar bounds nesting, and its SDK block is never type-
* checked. Only bracket nesting counts — a `oneOf` renders as a flat `A | B`
* chain and nested objects render as separate `class` statements, so neither
* accumulates open brackets at any depth. The invariant this cap serves is
* grammatical validity; see the `oneOf` arm in {@link renderType} for the one
* interpreter limit deliberately left uncapped.
*/
const MAX_LIST_NESTING = 180;
/**
* Cap a class-name base at {@link MAX_CLASS_NAME_BASE} (see the callers for
* why capping keeps the render linear). `slice` counts UTF-16 code units, so
* an astral character straddling the boundary would be cut in half and leave a
* lone surrogate — not an identifier character, and not even well-formed text;
* drop it rather than emit it.
*/
function capClassNameBase(base) {
	if (base.length <= MAX_CLASS_NAME_BASE) return base;
	const capped = base.slice(0, MAX_CLASS_NAME_BASE);
	return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped;
}
/**
* Reserve a unique class name from a base, suffixing `2`, `3`, … on collision.
* The base is capped at {@link MAX_CLASS_NAME_BASE} first: child class names
* derive from their parent's allocated name (`ParentChild`), so an unbounded
* schema of single-field objects would otherwise grow each name by one field
* per level and the sum of all names to Θ(depth²). Capping the base keeps each
* name — and the total emitted text — linear in depth. Collisions resume from
* the per-base counter in `state.nextClassCounter` rather than rescanning from
* `2`, so a deep chain sharing one capped base stays O(1) per allocation
* (amortized) instead of Θ(depth²) in time.
*/
function allocateClassName(base, state) {
	const capped = capClassNameBase(base);
	let name = capped;
	if (state.usedClassNames.has(name)) {
		let n = state.nextClassCounter.get(capped) ?? 2;
		while (state.usedClassNames.has(`${capped}${n}`)) n++;
		name = `${capped}${n}`;
		state.nextClassCounter.set(capped, n + 1);
	}
	state.usedClassNames.add(name);
	return name;
}
/**
* Append a child-name segment to a parent class-name base, capping the result
* at {@link MAX_CLASS_NAME_BASE}. Capping AT PROPAGATION (not only inside
* {@link allocateClassName}) keeps each level O(1): a deep `oneOf`- or
* object-chain would otherwise carry an ever-growing ConsString down the tree
* and re-materialize it (via `.length`/`.slice`) at every level — Θ(depth²).
* The bounded base plus the collision counter still yields unique names.
*
* The join is NFKC-normalized because both sides are separately normalized yet
* their concatenation need not be: a base ending in a Hangul L jamo or LV
* syllable composes with a following V or T jamo head (`가` + `ᆨ` gives `각`),
* so the emitted class name would differ from the symbol CPython compiles, and
* two byte-distinct names could fold onto one — `usedClassNames` dedupes by the
* raw bytes, so the collision counter would not see it. Normalizing costs
* O(cap + segment) per level, the same order as the `slice` it feeds. The other
* two join points need no counterpart: `Args`/`Output` start with `A`/`O` and
* {@link allocateClassName}'s suffix is digits, none of which compose backwards.
*/
function childClassName(base, segment) {
	return capClassNameBase(`${base}${segment}`.normalize("NFKC"));
}
/**
* Render one validated scalar as Python literal text (`True`/`False`,
* JSON-quoted strings, bare numbers). `null` cannot reach here: the `null`
* type renders directly as `None`, and the unified validator rejects a null
* `const`/`enum` entry on every other scalar type.
*
* A beyond-safe-range integral number takes `BigInt` digits rather than
* `String`: Python integers are arbitrary-precision, so the emitted digits ARE
* the value the model programs against, and `String` can give a different
* integer than the double holds (`2 ** 60` prints the rounded `...847000`, not
* the exact `...846976`) or no integer literal at all (`1e21` prints `1e+21`).
* `String`'s rounding is not a bug in it: `Number::toString` emits the shortest
* decimal string that re-reads to the same double, then pads to the exponent
* with zeros (1 significant digit for `1e20`, 16 for `2 ** 60`) — and when the
* shortest string is shorter than the double's exact value, those padded digits
* name an integer no double holds. Passing one back would have to cross the
* argument boundary as a JSON number — a double again — so the SDK would
* document a value no program can pass. `BigInt` needs no case split: where
* `String` is already exact (`2 ** 53`, `1e20`) the two agree byte for byte,
* and where it is not, `BigInt` is the exact one. The TS flavor needs no
* counterpart at all: its literal is re-read by a JS parser back into the same
* double.
*
* `JSON.stringify` is also what keeps this path's output parseable, and it is
* the only thing that does. It covers both classes of hazard: the two kinds of
* code point CPython refuses anywhere in source — NUL among the C0 controls,
* and the whole D800–DFFF unpaired-surrogate block, escaped under ES2019
* well-formed stringification, which the engines range guarantees — and the
* ones that break this line in particular, a bare `"` closing the literal
* early, a trailing odd backslash eating the closing quote, and a bare LF/CR
* ending it before its terminator. The `description` path carries
* {@link UNPRINTABLE} and {@link LONE_SURROGATE} because nothing quotes it,
* and folds newlines in {@link describe}.
*
* That leans on a coincidence worth naming: every escape `JSON.stringify` can
* emit (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) is also a Python
* escape denoting the same character, so the emitted `Literal[...]` both
* parses and decodes back to the value the schema declared. DEL, the C1
* controls (NEL among them), and LS/PS (U+2028/U+2029) do reach it raw —
* legal but invisible, byte-for-byte as in the TS flavor; escaping them is a
* both-flavors change. Those last three are legal here for the reason
* {@link UNPRINTABLE} records: they are `str.splitlines()` boundaries, not
* tokenizer line terminators. The subscript tool-name comment quotes its name
* through its own call to the same `JSON.stringify`, never through this
* function, and inherits both halves — escapes and pass-throughs alike.
*/
function pyScalar(value) {
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return BigInt(value).toString();
	return String(value);
}
/**
* Render a validated scalar `const`/`enum` as `Literal[...]`, falling back to
* the broad type. Deliberately deviates from PEP 586, which restricts `Literal`
* parameters to int/bool/str/bytes/enum/None: a non-integral number
* `const`/`enum` emits a float literal (`Literal[1.5]`) a strict checker would
* reject. An integral one does not deviate — {@link pyScalar} emits int digits,
* including for the beyond-safe-range values it widens through `BigInt`, and
* PEP 586 admits int parameters. Harmless either way — the stub is advisory
* prompt text, only required to parse — and keeping the exact value
* communicates the constraint to the model.
*/
function renderConstrainedScalar(node, broad, state) {
	if (node.const !== void 0) {
		state.typing.add("Literal");
		return `Literal[${pyScalar(node.const)}]`;
	}
	if (node.enum !== void 0) {
		state.typing.add("Literal");
		return `Literal[${node.enum.map(pyScalar).join(", ")}]`;
	}
	return broad;
}
/**
* Map one JSON-Schema node to a Python type expression, threading `state` to
* collect the `TypedDict` declarations and `typing` symbols a full render
* needs. `className` is the name to give an object node with properties (and
* the prefix for its nested objects). Handles every unified schema construct —
* `oneOf` (→ `X | Y`), `const`/`enum` (→ `Literal[...]`), `integer` (→ `int`),
* `null` (→ `None`) — and degrades an unsupported or malformed schema to `Any`
* without throwing, the same trusted-after-validation stance as the sibling
* {@link ./ts-types.ts | ts-types} renderer. {@link jsonSchemaToPy} is the
* context-free entry point; this is the collecting core.
*/
function renderType(schema, className, state) {
	const newFrame = (schema, className, listDepth) => ({
		schema,
		className,
		phase: "start",
		listDepth,
		children: [],
		childIndex: 0,
		childTypes: [],
		entries: []
	});
	try {
		assertSupportedJsonSchema(schema);
		const frames = [newFrame(schema, className, 0)];
		let result;
		const finish = (type) => {
			frames.pop();
			const parent = frames.at(-1);
			if (parent === void 0) result = type;
			else parent.childTypes.push(type);
		};
		while (frames.length > 0) {
			const frame = frames.at(-1);
			/* v8 ignore next -- the loop condition guarantees a current frame. */
			if (frame === void 0) break;
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing python render child");
					frame.childIndex++;
					frames.push(newFrame(child.schema, child.className, child.listDepth));
					continue;
				}
				if (frame.kind === "oneOf") {
					let union = "";
					for (const [index, childType] of frame.childTypes.entries()) union = index === 0 ? childType : `${union} | ${childType}`;
					finish(union);
					continue;
				}
				if (frame.kind === "array") {
					/* v8 ignore next -- the ?? arm needs a childless array frame, which start never builds. */
					finish(`list[${frame.childTypes[0] ?? "Any"}]`);
					continue;
				}
				const node = frame.node;
				const name = frame.allocated;
				/* v8 ignore next -- typeddict frames always set node and allocated at start. */
				if (node === void 0 || name === void 0) throw new Error("missing typeddict frame state");
				const required = new Set(node.required);
				const lines = [`class ${name}(TypedDict):`];
				for (let index = 0; index < frame.entries.length; index++) {
					const entry = frame.entries[index];
					const fieldType = frame.childTypes[index];
					/* v8 ignore next -- entries and childTypes correspond one-to-one. */
					if (entry === void 0 || fieldType === void 0) throw new Error("missing typeddict field type");
					const [field, fieldSchema] = entry;
					const description = describe(fieldSchema);
					if (description !== void 0) lines.push(`${pad(1)}# ${description}`);
					if (required.has(field)) lines.push(`${pad(1)}${field}: ${fieldType}`);
					else {
						state.typing.add("NotRequired");
						lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`);
					}
				}
				if (node.additionalProperties !== false) lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`);
				if (lines.length === 1) lines.push(`${pad(1)}pass`);
				state.classes.push(lines.join("\n"));
				finish(name);
				continue;
			}
			frame.phase = "children";
			const node = frame.schema;
			if (node.oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = node.oneOf.map((branch, index) => ({
					schema: branch,
					className: childClassName(frame.className, `${index + 1}`),
					listDepth: frame.listDepth
				}));
				continue;
			}
			if (node.type === void 0) {
				state.typing.add("Any");
				finish("Any");
				continue;
			}
			switch (node.type) {
				case "string":
					finish(renderConstrainedScalar(node, "str", state));
					break;
				case "number":
					finish(renderConstrainedScalar(node, "float", state));
					break;
				case "integer":
					finish(renderConstrainedScalar(node, "int", state));
					break;
				case "boolean":
					finish(renderConstrainedScalar(node, "bool", state));
					break;
				case "null":
					finish("None");
					break;
				case "array":
					if (node.items === void 0) {
						state.typing.add("Any");
						finish("list[Any]");
						break;
					}
					if (frame.listDepth >= MAX_LIST_NESTING) {
						state.typing.add("Any");
						finish("Any");
						break;
					}
					frame.kind = "array";
					frame.children = [{
						schema: node.items,
						className: frame.className,
						listDepth: frame.listDepth + 1
					}];
					break;
				case "object": {
					const entries = Object.entries(node.properties ?? {});
					if (className === "" || !entries.every(([name]) => isBareIdentifier(name) && !RESERVED.has(name) && !(name.startsWith("__") && !name.endsWith("__")))) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					if (entries.length === 0 && node.additionalProperties !== false) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					frame.kind = "typeddict";
					frame.node = node;
					frame.allocated = allocateClassName(frame.className, state);
					state.typing.add("TypedDict");
					frame.entries = entries;
					/* v8 ignore next -- allocated is always set before children are built. */
					frame.children = entries.map(([field, child]) => ({
						schema: child,
						className: childClassName(frame.allocated ?? "", camelCase(field)),
						listDepth: 1
					}));
					break;
				}
				/* v8 ignore next 4 -- assertSupportedJsonSchema narrowed this closed type union. */
				default:
					state.typing.add("Any");
					finish("Any");
			}
		}
		/* v8 ignore next -- every root frame produces one expression. */
		return result ?? "Any";
	} catch {
		state.typing.add("Any");
		return "Any";
	}
}
/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` takes two required arguments: \`description\`, a short summary of what the program does, and \`code\` — the body of an async Python function (top-level \`await\` and \`return\` both work). At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. Only what you print and return is program output. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section under `runtime.language ===
* 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
* per tool argument or output object (and per nested object) and one awaitable
* method per visible tool on a `Tools` protocol — typed args in, the tool's
* canonical output value out — with a `tools: Tools` singleton the model calls
* into. The `typing` import line lists exactly the symbols the render used.
* Deterministic — tools are emitted in lexicographic name order, and class
* declarations precede the protocol in that same order (nested classes before
* the parent that references them), so an unchanged tool set produces
* byte-identical text across assemblies. The sort is not a total order on
* byte-equal names, so two schemas sharing a name would render in argument
* order; the caller's visible-capability map is keyed by name, so the input
* never carries a duplicate.
* @param schemas - the tool schemas plus canonical output schemas to declare
*   (the caller excludes `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdkPy(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const state = {
		classes: [],
		usedClassNames: /* @__PURE__ */ new Set(),
		nextClassCounter: /* @__PURE__ */ new Map(),
		typing: new Set(["Protocol"])
	};
	const members = [];
	let statements = 0;
	for (const schema of sorted) {
		const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state);
		const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state);
		if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith("_")) {
			const doc = docLines(schema.description, 2);
			members.push(doc.length > 0 ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:` : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`);
			members.push(...doc);
			statements += 1;
		} else {
			members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`);
			const description = describe(schema);
			if (description !== void 0) members.push(`${pad(1)}#   ${description}`);
		}
	}
	const body = (statements > 0 ? members : [`${pad(1)}pass`, ...members]).join("\n");
	const imports = TYPING_ORDER.filter((symbol) => state.typing.has(symbol));
	const classBlock = state.classes.length > 0 ? `${state.classes.join("\n\n")}\n\n` : "";
	return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${`from typing import ${imports.join(", ")}\n\nclass ToolCallError(Exception):
    toolName: str\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`}\n\`\`\``;
}
//#endregion
//#region ../../core/tools/src/index.ts
/**
* Language → SDK-section renderer. The registry looks up the loaded
* `ctx.ptcRuntime.language` in this table when assembling the `tools:sdk`
* section under a non-native mode; a runtime whose language is not a key
* fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
* new backend language is three parallel edits — a {@link PtcSdkLanguage}
* member, an entry here, and a `RUN_CODE_FLAVORS` entry in `ptc.ts` for
* its `run_code` schema strings — plus the renderer function this table points
* at. The `satisfies` clause pins this table's key set to that union, which
* the flavor table is checked against too, so any of the three left out is a
* typecheck failure. What no check reaches is the prose that names the values
* instead of deriving them: the seam's `dsh-ptc-runtime` README pair, its
* `PtcRuntime.language` JSDoc, and `docs/subsystems/ptc-runtime.md`
* with its zh pair, plus this package's own README pair and the
* {@link Config.mode} JSDoc.
*/
/**
* The model-facing statement of the `ptc` collapse. Names the consequence
* (the call fails) and the route (inside the program), because a rule the
* model can only discover by being denied is one it corrects too late.
*/
const PTC_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`;
const SDK_RENDERERS = {
	typescript: renderToolsSdk,
	python: renderToolsSdkPy
};
/**
* Scheduler entry point omitted from the generated named service API.
* @internal
*/
const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler");
/** Canonical error code for cancellation after a tool body was invoked. */
const TOOL_ABORTED = "ABORTED";
/** Canonical error code for cancellation before a tool body was invoked. */
const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";
/**
* Thrown (internally) when the model requests a tool that isn't registered.
* Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
* failure is as routable as a tool-thrown one — retry/sandbox/replay code can
* distinguish it from a tool body's own error.
*/
var ToolNotFoundError = class extends HarnessError {
	/**
	* @param toolName - the name the caller asked for.
	* @param reachableFrom - how the model reaches this tool instead, when the
	*   name IS visible and only the presentation denies calling it directly.
	*   Omitted for a name that is registered nowhere.
	*/
	constructor(toolName, reachableFrom) {
		super(reachableFrom === void 0 ? `unknown tool "${toolName}"` : `unknown tool "${toolName}": ${reachableFrom}`, "UNKNOWN_TOOL");
		this.name = "ToolNotFoundError";
	}
};
/** Thrown when a tool body or post-policy value violates its declared output. */
var ToolOutputError = class extends HarnessError {
	/** Schema/value violations in validation order. */
	violations;
	constructor(toolName, violations) {
		super(`tool "${toolName}" returned invalid output: ${violations.join("; ")}`, "INVALID_TOOL_OUTPUT");
		this.name = "ToolOutputError";
		this.violations = violations;
	}
};
/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName, projector, error) {
	return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw projectionError(toolName, projector, error);
	}
}
/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`]);
	}
}
/**
* Best-effort human-readable message from an arbitrary thrown value: Error
* instances use `.message`; non-Error objects with a string `message`
* property (e.g. `throw { message: 'denied' }`) use it too; everything else
* is stringified.
*/
function errorMessage(error) {
	try {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
		return String(error);
	} catch {
		return "<unprintable thrown value>";
	}
}
/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content) {
	const text = content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n");
	return text.length > 0 ? text : "tool result blocked by post-execute policy";
}
/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation(candidate) {
	const detached = snapshotJsonValue(candidate);
	if (detached === void 0) throw new TypeError("tool result must be losslessly JSON-serializable");
	return deepFreeze(detached);
}
/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error) {
	try {
		return error instanceof HarnessError ? {
			name: error.name,
			code: error.code
		} : void 0;
	} catch {
		return;
	}
}
/** One scope's complete tool-registry contribution. */
var ToolLayer = class {
	tools;
	restrictions = new AnonymousEntries();
	guards = new AnonymousEntries();
	/**
	* Presentation this scope's agent declared for itself, shadowing the
	* deployment default. One cell rather than an entry table: two answers to
	* "which form does the model see" is a contradiction, not a merge.
	*/
	mode;
	constructor(scope) {
		this.tools = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
	}
	/** Whether every contribution table in this aggregate layer is empty. */
	isEmpty() {
		return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty() && this.mode === void 0;
	}
	/** Whether every compiled restriction in this layer admits a global tool name. */
	admits(name) {
		for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name) || filter.deny !== void 0 && filter.deny.has(name)) return false;
		return true;
	}
	/** First monotonic denial from this layer's live guard registrations. */
	guardReason(exec) {
		for (const guard of this.guards.values()) {
			const reason = guard(exec);
			if (reason !== void 0) return reason;
		}
	}
};
/** Resolve the run_code overlap cap at the owning config boundary (direct construction bypasses the Loader schema). */
function resolveMaxParallelSubCalls(value) {
	const maxParallelSubCalls = value ?? 10;
	if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) throw new Error("maxParallelSubCalls must be a positive integer");
	return maxParallelSubCalls;
}
(class extends Service {
	static inject = ["systemPrompt"];
	static Config = z.object({
		mode: z.union(["native", "ptc"]).default("native"),
		maxParallelSubCalls: z.natural().min(1).default(10)
	});
	/** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
	[TOOL_RUNTIME_SCHEDULER] = {
		prepare: (exec) => this.prepareScheduledExecution(exec),
		dispatch: (exec) => this.dispatchScheduledExecution(exec),
		finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
		finish: (exec, result) => this.finishScheduledExecution(exec, result)
	};
	/** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
	deferredContexts = /* @__PURE__ */ new WeakMap();
	/** Executions whose tool body declared the current turn complete. */
	concludingExecutions = /* @__PURE__ */ new WeakSet();
	/** Original caller cancellation, kept outside the wrapper-mutable execution object. */
	cancellationStates = /* @__PURE__ */ new WeakMap();
	/** Definition-owned final content transform snapshotted before policy begins. */
	contentFinalizers = /* @__PURE__ */ new WeakMap();
	/** Execution-prepared content installed before post-execute policy. */
	contentProjectors = /* @__PURE__ */ new WeakMap();
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
	/** Presentation for scopes that declare none; {@link presentAs} shadows it per scope. */
	defaultMode;
	maxParallelSubCalls;
	/**
	* Reserved presentation transport, kept outside the filterable registration
	* layers. Built on first need rather than at construction: which agents run
	* a PTC mode is no longer known when the service is constructed, and the
	* transport is stateless beyond its closures over `this`.
	*/
	ptcTransport;
	constructor(ctx, config = {}) {
		super(ctx, "tools");
		this.defaultMode = config.mode ?? "native";
		this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);
		ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
		if (this.defaultMode !== "native") {
			ctx.systemPrompt.section(this.collapseSection());
			ctx.systemPrompt.section(this.sdkSection());
		}
	}
	/**
	* The prompt statement of the `ptc` executor collapse, registered wherever
	* {@link sdkSection} is and rendering empty outside an effective `ptc`.
	*
	* Every tool contributes its own guidance section naming its tool, none of
	* them qualify how that tool is reached, and they all render before the SDK.
	* Without this the model reads a catalog of tools it is told to use and no
	* statement that only `run_code` may be called, so it emits a native call,
	* receives `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes
	* the deployment is inconsistent. Its order places the rule before that
	* guidance rather than after it.
	*
	* Native scopes render no instruction.
	* @returns the section registration.
	*/
	collapseSection() {
		return {
			name: "tools:ptc-only",
			order: this.ctx.systemPrompt.getSectionOrder("PTC_ONLY"),
			text: (context) => this.modeFor(context.scope) === "ptc" ? PTC_ONLY_INSTRUCTION : ""
		};
	}
	/**
	* The generated-SDK prompt section, registered globally by a PTC mode
	* deployment and per scope by {@link presentAs}.
	*
	* The body regenerates from the CALLING scope, and renders empty for an
	* agent presenting natively — an agent that opted out under a PTC mode
	* deployment still sees the global registration, and an empty section is
	* dropped from the rendered prompt.
	* @returns the section registration.
	*/
	sdkSection() {
		return {
			name: "tools:sdk",
			order: this.ctx.systemPrompt.getSectionOrder("TOOLS_SDK"),
			interpolate: false,
			text: (context) => {
				const mode = this.modeFor(context.scope);
				if (mode === "native") return "";
				const runtime = this.requirePtcRuntime(mode);
				const render = SDK_RENDERERS[runtime.language];
				/* v8 ignore next -- requirePtcRuntime rejects an unknown language before this runs. */
				if (render === void 0) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`);
				return render(this.sdkSchemas(context.scope));
			}
		};
	}
	/**
	* The presentation one scope's agent sees: its own declaration, else the
	* deployment default.
	* @param scope - the calling agent, or undefined for the global view.
	* @returns the resolved presentation mode.
	*/
	modeFor(scope) {
		const layers = this.layers.chainLayers(scope);
		for (let index = layers.length - 1; index >= 0; index -= 1) {
			const mode = layers[index]?.mode;
			if (mode !== void 0) return mode;
		}
		return this.defaultMode;
	}
	/**
	* The reserved `run_code` transport, built on first need.
	*
	* It never enters the global layer: per-agent restrictions must not remove
	* it, and a scoped registration must not shadow it. The visibility resolver
	* appends it after resolving the filterable global/scoped capability layers,
	* and only for scopes whose mode actually presents it.
	* @returns the shared transport definition.
	*/
	requirePtcTransport() {
		this.ptcTransport ??= createRunCodeTool(this, {
			resolveWorkingDirectory: async (exec) => {
				if (exec.agent === void 0) return void 0;
				const directories = this.ctx.get("workingDirectory");
				if (directories === void 0) throw new Error("dsh-tools: run_code with an Agent requires workingDirectory");
				return directories.ensure(exec.agent, exec.signal);
			},
			requireRuntime: () => this.requirePtcRuntime(this.defaultMode),
			peekApprover: () => this.ctx.get("approval"),
			resolveSandboxPolicy: (exec) => {
				const policy = this.ctx.get("sandboxPolicy");
				if (policy === void 0) throw new Error("dsh-tools: confined PTC runtime requires sandboxPolicy");
				return policy.resolve(exec.agent === void 0 ? {} : { session: exec.agent.session });
			},
			peekRuntime: () => this.ctx.get("ptcRuntime"),
			maxParallel: this.maxParallelSubCalls,
			shapeDispatchLog: (dispatch) => this.shapeDispatchLog(dispatch)
		});
		return this.ptcTransport;
	}
	/**
	* Present the calling scope's tools in `mode` instead of the deployment
	* default. Nearest scope on the chain wins, so a preset's standing
	* declaration covers every agent joined under it.
	*
	* Scoped only, and one declaration per scope: this is how an agent preset
	* composes PTC mode agents beside native ones in the same process, and a
	* process-global override would be the `mode` config field instead.
	* @param mode - the presentation the covered agents' models see.
	* @returns the exact disposer that restores the deployment default.
	*/
	presentAs(mode) {
		const ctx = this.ctx;
		if (scopeOf(ctx) === void 0) throw new Error("tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row");
		return ctx.effect(function* () {
			yield this.layers.effect(ctx, (layer) => {
				if (layer.mode !== void 0) throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this scope; one composition selects one presentation`);
				layer.mode = mode;
				return () => {
					layer.mode = void 0;
				};
			}, { label: "tools.presentAs()" });
			if (mode !== "native") {
				yield ctx.systemPrompt.section(this.collapseSection());
				yield ctx.systemPrompt.section(this.sdkSection());
			}
		}.bind(this), "tools.presentAs()");
	}
	/**
	* Build one scope's wire schemas and names for prompt-order validation.
	* Restrictions do not make known tools invalid, but a mode collapse does.
	*/
	wireSchemas(scope) {
		const view = this.view(scope);
		const mode = this.modeFor(scope);
		if (mode === "native") return {
			schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),
			knownNames: [...view.knownNames]
		};
		this.requirePtcRuntime(mode);
		return {
			schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)).filter((schema) => schema.name === RUN_CODE_NAME),
			knownNames: [RUN_CODE_NAME]
		};
	}
	/**
	* Resolve the PTC runtime or throw the actionable misconfiguration error.
	* Read at use time (assembly / run_code execution), NOT via static
	* `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
	* behind it — hostage to a PTC runtime existing even under `mode:
	* 'native'`.
	*
	* Assembly and `run_code` execution read separately, so the language is not
	* bound to a request. Harmless while one published backend exists — both
	* reads return the same flavor — but a reload that swapped in a second
	* language between them would hand a program written against one SDK to the
	* other. Binding it is deferred until a second backend ships (the first
	* point it is testable).
	*/
	requirePtcRuntime(mode) {
		const runtime = this.ctx.get("ptcRuntime");
		if (!runtime) throw new Error(`dsh-tools: mode "${mode}" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or set tools mode to "native"`);
		if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
			const known = Object.keys(SDK_RENDERERS).map((name) => JSON.stringify(name)).join(", ");
			throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
		}
		return runtime;
	}
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
	}
	/**
	* Restrict global tools for the calling agent scope. Empty filters, unknown
	* names, scope-local names, and reserved transport names fail. Restrictions
	* intersect; scoped registrations remain visible.
	* @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
	* @returns the exact disposer that lifts this restriction.
	*/
	restrict(filter) {
		const scope = scopeOf(this.ctx);
		if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
		const allow = filter.allow;
		const deny = filter.deny;
		if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
		const compiled = {
			...allow !== void 0 ? { allow: new Set(allow) } : {},
			...deny !== void 0 ? { deny: new Set(deny) } : {}
		};
		if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved PTC mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
		const known = this.view(scope).restrictableNames;
		const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
		if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; known global tools: ${[...known].sort().join(", ") || "(none)"}`);
		return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
	}
	/**
	* Register a monotonic guard after the extensible `tools/pre-execute`
	* waterfall. A plain-context guard applies globally; one registered through
	* `agent.ctx` applies only to that agent. Any matching guard may deny by
	* returning a reason, while no guard can force-allow a call another guard
	* denied. The exact effect disposer is returned for ordered ownership and
	* HMR cleanup.
	* @param guard - synchronous check; a returned string denies the execution.
	* @returns the exact disposer that unregisters the guard.
	*/
	guard(guard) {
		return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), {
			label: "tools.guard()",
			notify: false
		});
	}
	/** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
	guardReason(exec) {
		const globalReason = this.layers.global.guardReason(exec);
		if (globalReason !== void 0) return globalReason;
		if (exec.agent === void 0) return void 0;
		for (const layer of this.layers.chainLayers(exec.agent)) {
			const reason = layer.guardReason(exec);
			if (reason !== void 0) return reason;
		}
	}
	/**
	* Resolve every registry fact one scope needs in one layer traversal. The
	* visible map applies restrictions to the INHERITED surface, then the
	* scope's own registrations and the reserved presentation transport; the
	* other sets retain the pre-restriction facts needed by restriction and
	* prompt-order validation.
	*
	* A restriction filters what a scope inherits — the global layer and every
	* ancestor layer on its chain — and never what its OWN layer registers.
	* That exemption is what a per-child capability filter has to keep intact:
	* the delegation runtime registers a child's structured-output tool into the
	* child's own layer, and a filter naming the capabilities the child may use
	* must not strip the machinery it answers through.
	*
	* Reading the exempt set as "the global layer" instead of "not mine" held
	* only while every model-facing tool sat in the host composition. Once
	* presets moved them onto the agent plane they became an ANCESTOR
	* contribution, so a child's filter silently stopped constraining anything
	* it was given.
	* @param scope - the viewing scope (the agent), or undefined for the global view.
	* @returns the complete derived view for that scope.
	*/
	view(scope) {
		const layers = this.layers.chainLayers(scope);
		const own = this.layers.peek(scope);
		const inherited = new Map(this.layers.global.tools.entries());
		for (const layer of layers) {
			if (layer === own) continue;
			for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition);
		}
		const visible = /* @__PURE__ */ new Map();
		const knownNames = /* @__PURE__ */ new Set();
		const restrictableNames = /* @__PURE__ */ new Set();
		for (const [name, definition] of inherited) {
			knownNames.add(name);
			restrictableNames.add(name);
			if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
		}
		if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
			knownNames.add(name);
			visible.set(name, definition);
		}
		if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requirePtcTransport());
		return {
			visible,
			knownNames,
			restrictableNames
		};
	}
	/**
	* Look up a tool as one scope sees it (scoped
	* shadows global; a restricted-away global reads as absent). Presenters pass
	* the calling agent so the rendered card matches the definition that
	* actually executed.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns the definition the scope resolves, or undefined when none is visible.
	*/
	get(name, scope) {
		return this.view(scope).visible.get(name);
	}
	/**
	* Resolve the definition that MAY EXECUTE for a call, applying the mode
	* collapse at the operation boundary that owns it. The registry view
	* (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `ptc`
	* may only name the reserved `run_code` transport, while a nested
	* sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
	* it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
	* through the executor, matching an absent definition.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	* @returns the definition that may run, or undefined when the call must be rejected.
	*/
	resolveExecution(name, scope, nested) {
		const tool = this.get(name, scope);
		if (tool === void 0) return void 0;
		if (this.collapses(name, scope, nested)) return void 0;
		return tool;
	}
	/**
	* Project visible definitions onto the allowlisted model-facing schema fields,
	* excluding execution and presentation callbacks.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns one deep-cloned schema per visible tool.
	*/
	schemas(scope) {
		return [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition, true));
	}
	/** Project visible callable tools onto the generated PTC mode SDK contract. */
	sdkSchemas(scope) {
		return [...this.view(scope).visible.values()].filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {
			const output = snapshotJsonValue(definition.output.schema);
			/* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
			if (output === void 0) throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`);
			return {
				...this.schemaOf(definition, true),
				output
			};
		});
	}
	/** Project one definition onto the model-facing schema fields. */
	schemaOf(definition, detachParameters) {
		const { name, description, parameters, deferLoading } = definition;
		const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
		if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
		return {
			name,
			description,
			parameters: detached,
			...deferLoading === true ? { deferLoading } : {}
		};
	}
	/**
	* Classify a pending call through the caller's visible tool definition. Only
	* an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
	* throwing classifiers are exclusive.
	* @param exec - call name, parsed arguments, and optional agent scope.
	* @returns the fail-closed scheduling mode.
	*/
	executionMode(exec) {
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
		try {
			return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" };
		} catch {
			return { kind: "exclusive" };
		}
	}
	/**
	* Run the `tools/ptc-dispatch-log` waterfall over one settled sub-dispatch
	* and return the content the bridge should log on `tool/ptc-dispatch`.
	* Contained: when a listener throws, the method logs the original settled
	* content; that failure must not fail the dispatch or omit the settle event. Private:
	* the ONE consumer is the `run_code` bridge this registry constructs, which
	* receives it as a capability parameter (the `requireRuntime` idiom) — the
	* waterfall, not this invoker, is the public extension point.
	*/
	async shapeDispatchLog(dispatch) {
		try {
			return await this.ctx.waterfall(scopeTarget(this, dispatch.agent), "tools/ptc-dispatch-log", dispatch, () => Promise.resolve(dispatch.content));
		} catch (error) {
			this.ctx.logger.warn(`tools: ptc-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`);
			return dispatch.content;
		}
	}
	/**
	* Whether the `ptc` mode collapse denies a model-direct call: only the
	* reserved `run_code` transport may be named. Nested sub-dispatches (a
	* `parent` token set) bypass the collapse. One home for the
	* security-relevant predicate, shared by {@link resolveExecution} and
	* {@link createExecution} so the two can never drift apart.
	*
	* Resolved through {@link modeFor}, NOT `defaultMode`: an agent given `ptc`
	* by an agent preset under a native deployment is the composition
	* `dsh-agent-tool-presentation` exists for, and reading the deployment default would
	* leave exactly that agent uncollapsed — announcing one surface while
	* executing another, which is the bypass this collapse closes.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope whose effective presentation mode applies.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	*/
	collapses(name, scope, nested) {
		return !nested && this.modeFor(scope) === "ptc" && name !== "run_code";
	}
	/**
	* Execute through pre-policy, guards, around-dispatch, post-policy,
	* definition-owned content finalization, and final notification. Tool and
	* listener failures resolve as materialized error results; an invisible tool
	* reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
	* snapshot final observers receive. Cancellation
	* arriving after entry and before final result materialization skips a
	* not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
	* successful started outcome with `ABORTED`; already-started work is still
	* drained and may retain a tool-owned structured error.
	* @param exec - the typed same-process call input. The registry assigns its
	*   correlation token before policy begins.
	* @returns the materialized final result.
	*/
	async execute(exec) {
		return this.prepareExecution(exec, (prepared) => this.completeScheduledExecution(prepared));
	}
	async completeScheduledExecution(prepared) {
		switch (prepared.kind) {
			case "dispatch": {
				const dispatched = await this.dispatchScheduledExecution(prepared.exec);
				return dispatched.kind === "post-result" ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result) : this.finishScheduledExecution(prepared.exec, dispatched.result);
			}
			case "post-result": return await this.finalizeScheduledExecution(prepared.exec, prepared.result);
			case "final-result": return this.finishScheduledExecution(prepared.exec, prepared.result);
			/* v8 ignore next -- closed-union exhaustiveness guard */
			default: return assertNever(prepared, "scheduled tool preparation");
		}
	}
	createExecution(exec) {
		const deferredContexts = [];
		const token = createExecutionToken();
		const callId = exec.callId;
		const rootCallId = exec.rootCallId ?? callId;
		const name = exec.name;
		const agent = exec.agent;
		const parent = exec.parent;
		const signal = exec.signal;
		const visible = this.get(name, agent);
		const collapsed = visible !== void 0 && this.collapses(name, agent, parent !== void 0);
		const concludingExecutions = this.concludingExecutions;
		const base = {
			token,
			callId,
			rootCallId,
			name,
			signal,
			...agent !== void 0 ? { agent } : {},
			...parent !== void 0 ? { parent } : {},
			...exec.schema !== void 0 ? { schema: exec.schema } : {},
			deferContext(context) {
				deferredContexts.push(context);
			},
			concludeTurn() {
				concludingExecutions.add(this);
			}
		};
		const capturedFinalizer = visible?.finalizeContent?.bind(visible);
		const capturedProjector = visible?.projectContent?.bind(visible);
		const finalizerFor = () => collapsed && !signal.aborted ? void 0 : capturedFinalizer;
		try {
			const detached = snapshotJsonValue(exec.arguments);
			if (detached === void 0) throw new TypeError("tool execution arguments must be losslessly JSON-serializable");
			const execution = {
				...base,
				arguments: deepFreeze(detached)
			};
			this.deferredContexts.set(execution, deferredContexts);
			this.contentFinalizers.set(execution, finalizerFor());
			if (!collapsed) this.contentProjectors.set(execution, capturedProjector);
			this.cancellationStates.set(execution, {
				callerSignal: signal,
				bodyInvoked: false
			});
			if (collapsed) {
				if (signal.aborted) return {
					kind: "final-result",
					exec: execution,
					result: toolAbortedBeforeDispatchResult()
				};
				return {
					kind: "final-result",
					exec: execution,
					result: toolErrorResult(new ToolNotFoundError(name, `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`))
				};
			}
			return {
				kind: "ready",
				exec: execution
			};
		} catch (error) {
			const execution = {
				...base,
				arguments: void 0
			};
			this.contentFinalizers.set(execution, finalizerFor());
			return {
				kind: "final-result",
				exec: execution,
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run the ordered pre-execute and monotonic guard stages for the scheduler.
	* @param input - the caller-supplied execution input.
	* @returns the prepared execution plus the next scheduler stage.
	* @internal
	*/
	async prepareScheduledExecution(input) {
		return this.prepareExecution(input, (prepared) => prepared);
	}
	async prepareExecution(input, next) {
		const created = this.createExecution(input);
		if (created.kind !== "ready") return next(created);
		const exec = created.exec;
		if (this.callerCancelled(exec)) return next({
			kind: "final-result",
			exec,
			result: toolAbortedBeforeDispatchResult()
		});
		try {
			const carrier = scopeTarget(this, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
			const { decision } = askResolution;
			if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			if (decision.kind === "cancel") return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			const denialInfo = decision.kind === "deny" ? decision.info : void 0;
			if (denialReason !== void 0) return await next({
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: {
						message: denialReason,
						...denialInfo === void 0 ? {} : { info: denialInfo }
					}
				})
			});
			if (this.callerCancelled(exec)) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			return await next({
				kind: "dispatch",
				exec
			});
		} catch (error) {
			return next({
				kind: "final-result",
				exec,
				result: toolErrorResult(error)
			});
		}
	}
	/** Whether the original caller signal is currently aborted. */
	callerCancelled(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.callerSignal.aborted;
	}
	/** Canonical cancellation outcome selected by whether the tool body started. */
	cancellationResult(exec, prior) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.bodyInvoked ? toolAbortedResult(prior) : toolAbortedBeforeDispatchResult(prior);
	}
	/**
	* Dispatch the registered body with the original caller signal fused back
	* into any around-wrapper replacement. Cancellation never abandons the body:
	* a started promise reaches quiescence before its outcome becomes `ABORTED`.
	*/
	async dispatchToolBody(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		const wrapperSignal = exec.signal;
		const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
		const signal = fused.signal;
		if (isAborted(signal)) {
			fused.dispose();
			return toolAbortedBeforeDispatchResult();
		}
		exec.signal = signal;
		try {
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (!tool) throw new ToolNotFoundError(exec.name);
			state.bodyInvoked = true;
			const returned = await tool.execute(exec.arguments, exec);
			const result = this.createSuccessResult(exec, tool, returned);
			return isAborted(signal) ? toolAbortedResult(result) : result;
		} catch (error) {
			return toolErrorResult(error);
		} finally {
			fused.dispose();
			exec.signal = wrapperSignal;
		}
	}
	/**
	* Run around-dispatch and the tool body. Tool and unknown-tool failures still
	* receive post-execute; pipeline failures are already final.
	* @param exec - the prepared execution.
	* @returns whether the result still needs post-execute.
	* @internal
	*/
	async dispatchScheduledExecution(exec) {
		try {
			const mutableExec = exec;
			const carrier = scopeTarget(this, exec.agent);
			const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
			const normalized = this.normalizeDispatchResult(exec, result);
			const deferredContexts = this.deferredContexts.get(exec);
			/* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
			if (deferredContexts === void 0) throw new Error("tool registry scheduler invariant violated: unprepared execution");
			const resultWithDeferredContexts = deferredContexts.length === 0 ? normalized : this.markCanonical(exec, {
				...normalized,
				additionalContexts: [...deferredContexts, ...normalized.additionalContexts ?? []]
			});
			return {
				kind: "post-result",
				result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError ? this.cancellationResult(exec, resultWithDeferredContexts) : resultWithDeferredContexts
			};
		} catch (error) {
			return {
				kind: "final-result",
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run ordered post-execute, then apply definition-owned content finalization,
	* materialize, and notify the final outcome.
	* @param exec - the prepared execution.
	* @param result - dispatch/pre result that still needs post-execute.
	* @returns the materialized final result.
	* @internal
	*/
	async finalizeScheduledExecution(exec, result) {
		try {
			const project = this.contentProjectors.get(exec);
			this.contentProjectors.delete(exec);
			const content = project?.(exec, result);
			const projected = content === void 0 ? result : this.markCanonical(exec, this.materializeFinalResult({
				...result,
				content
			}));
			const postResult = await this.postExecute(exec, projected);
			return this.finishScheduledExecution(exec, this.callerCancelled(exec) && !postResult.isError ? this.cancellationResult(exec, postResult) : postResult);
		} catch (error) {
			return this.finishScheduledExecution(exec, toolErrorResult(error));
		}
	}
	/**
	* Materialize the candidate, apply definition-owned content finalization,
	* then materialize and notify the authoritative result.
	* @param exec - the prepared execution.
	* @param result - final result.
	* @returns the materialized final result.
	* @internal
	*/
	finishScheduledExecution(exec, result) {
		let materializedResult;
		try {
			materializedResult = this.materializeFinalResult(result);
		} catch (error) {
			materializedResult = this.materializeFinalResult(toolErrorResult(error));
		}
		let finalResult;
		try {
			finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
		} catch (error) {
			finalResult = this.materializeFinalResult(toolErrorResult(error));
		}
		this.notifyResult(exec, finalResult);
		return finalResult;
	}
	/** Apply the snapshotted tool-owned content transform without exposing other result fields. */
	applyFinalContent(exec, result) {
		const finalizeContent = this.contentFinalizers.get(exec);
		if (finalizeContent === void 0) return result;
		const content = finalizeContent(exec, result);
		return content === void 0 ? result : {
			...result,
			content
		};
	}
	/** Notify observers without exposing a mutation or error channel into the outcome. */
	notifyResult(exec, result) {
		Object.freeze(exec);
		const { name: toolName, callId } = exec;
		const reportFailure = (error) => {
			this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`);
		};
		const callbacks = this.ctx.events.dispatch("emit", [
			scopeTarget(this, exec.agent),
			"tools/result",
			exec,
			result
		]);
		for (const callback of callbacks) try {
			const returned = callback(exec, result);
			Promise.resolve(returned).catch(reportFailure);
		} catch (error) {
			reportFailure(error);
		}
	}
	/**
	* Resolve an `ask` decision to allow/deny through the approval seam. The
	* seam is consumed opportunistically with `ctx.get('approval')` — a
	* deployment that composes no ApprovalService keeps the historical degrade
	* to deny, and an unmount mid-session degrades the same way on the next ask.
	* An agent-less execution also degrades: without an agent there is no
	* session to audit to and no UI to route to. Otherwise the outcome maps
	* one-to-one — `allowed-once` proceeds; the three non-grants deny with
	* distinct reasons so the model can tell a human "no" from an absent
	* approval channel.
	*/
	async serviceAsk(exec, ask) {
		const approval = this.ctx.get("approval");
		if (approval === void 0) return {
			decision: {
				kind: "deny",
				reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
			},
			approvalCancelled: false
		};
		if (exec.agent === void 0) return {
			decision: {
				kind: "deny",
				reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through`
			},
			approvalCancelled: false
		};
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			...ask.reason !== void 0 ? { reason: ask.reason } : {},
			...ask.displayReason !== void 0 ? { displayReason: ask.displayReason } : {},
			signal: exec.signal
		});
		switch (outcome) {
			case "allowed-once": return {
				decision: { kind: "allow" },
				approvalCancelled: false
			};
			case "rejected": return {
				decision: {
					kind: "deny",
					reason: `the user rejected tool "${exec.name}"`
				},
				approvalCancelled: false
			};
			case "cancelled": return {
				decision: {
					kind: "deny",
					reason: `approval for tool "${exec.name}" was cancelled`
				},
				approvalCancelled: true
			};
			case "unavailable": return {
				decision: {
					kind: "deny",
					reason: `tool "${exec.name}" requires approval, but no approval channel is available`
				},
				approvalCancelled: false
			};
			default: return assertNever(outcome, "ApprovalOutcome");
		}
	}
	/**
	* Run the `tools/post-execute` waterfall over a dispatched `result` and apply
	* its {@link PostToolDecision}: `accept` keeps the call successful (replacing
	* `content` when given), `block` turns it into an `isError` whose content is
	* the corrective `feedback`. Either decision may attach `additionalContexts`,
	* which are ferried on the returned result for the loop's active-batch FIFO.
	* Context deferred by the tool body survives an accepted result but is
	* discarded when the outer call is blocked; a block exposes only context the
	* blocking decision explicitly supplied.
	* Runs inside `execute`'s outer try/catch (a throwing listener → isError).
	*/
	async postExecute(exec, result) {
		const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
		const decisionContexts = decision.additionalContexts ?? [];
		if (decision.kind === "block") {
			const message = failureMessageFromContent(decision.feedback);
			return this.markCanonical(exec, {
				content: decision.feedback,
				isError: true,
				error: { message },
				...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
			});
		}
		if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
		const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
		if (Object.hasOwn(decision, "value")) {
			if (result.isError) throw new TypeError("tools/post-execute cannot replace the value of a failed result");
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (tool === void 0) throw new ToolNotFoundError(exec.name);
			const replaced = this.createSuccessResult(exec, tool, decision.value);
			return this.markCanonical(exec, {
				...replaced,
				...additionalContexts.length > 0 ? { additionalContexts } : {}
			});
		}
		return this.markCanonical(exec, {
			...result,
			...decision.content !== void 0 ? { content: decision.content } : {},
			...additionalContexts.length > 0 ? { additionalContexts } : {}
		});
	}
	/** Registry-normalized results and the exact dispatch that validated each value. */
	canonicalResults = /* @__PURE__ */ new WeakMap();
	/** Mark one registry-normalized result as canonical only for its owning dispatch. */
	markCanonical(exec, result) {
		this.canonicalResults.set(result, exec.token);
		return result;
	}
	/** Snapshot, validate, render, and optionally project one successful body value. */
	createSuccessResult(exec, tool, candidate) {
		const detached = snapshotToolValue(tool.name, candidate);
		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
		const value = deepFreeze(detached);
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		const content = snapshotProjection(tool.name, "render", rendered);
		let meta;
		if (tool.output.presentationMeta !== void 0) {
			let projected;
			try {
				projected = tool.output.presentationMeta(exec.arguments, value);
			} catch (error) {
				throw projectionError(tool.name, "presentationMeta", error);
			}
			meta = snapshotProjection(tool.name, "presentationMeta", projected);
		}
		const concludesTurn = this.concludingExecutions.has(exec);
		return this.markCanonical(exec, this.materializeFinalResult({
			isError: false,
			value,
			content,
			...meta !== void 0 ? { meta } : {},
			...concludesTurn ? { concludesTurn: true } : {}
		}));
	}
	/** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
	normalizeDispatchResult(exec, result) {
		if (this.canonicalResults.get(result) === exec.token) return result;
		if (result.isError) return this.markCanonical(exec, {
			isError: true,
			error: result.error,
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (tool === void 0) throw new ToolNotFoundError(exec.name);
		const normalized = this.createSuccessResult(exec, tool, result.value);
		return this.markCanonical(exec, {
			...normalized,
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
	}
	/** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
	materializeFinalResult(result) {
		const presentation = {
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		};
		if (result.isError) return materializePresentation({
			isError: true,
			error: result.error,
			...presentation
		});
		return deepFreeze({
			...materializePresentation({
				isError: false,
				...presentation,
				...result.concludesTurn === true ? { concludesTurn: true } : {}
			}),
			value: result.value
		});
	}
});
/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken() {
	return Symbol("dsh.tool.execution");
}
function toolErrorResult(error) {
	const info = errorInfo(error);
	const message = errorMessage(error);
	return {
		content: [{
			type: "text",
			text: `Error: ${message}`
		}],
		isError: true,
		error: {
			message,
			...info ? { info } : {}
		}
	};
}
/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal) {
	return signal.aborted;
}
/**
* Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
* Keeping the relay dispatch-scoped also removes listeners when work settles.
*/
function fuseToolSignals(caller, wrapper) {
	if (caller === wrapper) return {
		signal: caller,
		dispose() {}
	};
	const controller = new AbortController();
	let listening = false;
	const dispose = () => {
		if (!listening) return;
		listening = false;
		caller.removeEventListener("abort", abortFromCaller);
		wrapper.removeEventListener("abort", abortFromWrapper);
	};
	const abortFrom = (source) => {
		const reason = source.reason;
		controller.abort(reason);
		dispose();
	};
	const abortFromCaller = () => {
		abortFrom(caller);
	};
	const abortFromWrapper = () => {
		abortFrom(wrapper);
	};
	if (wrapper.aborted) abortFromWrapper();
	else if (caller.aborted) abortFromCaller();
	else {
		listening = true;
		caller.addEventListener("abort", abortFromCaller, { once: true });
		wrapper.addEventListener("abort", abortFromWrapper, { once: true });
	}
	return {
		signal: controller.signal,
		dispose
	};
}
/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted"
		}],
		isError: true,
		error: {
			message: "tool call aborted",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted before dispatch"
		}],
		isError: true,
		error: {
			message: "tool call aborted before dispatch",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED_BEFORE_DISPATCH
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
//#endregion
//#region lib/types/engine/hitl.js
/** Model-facing name of the ask-user tool. */
const HITL_TOOL_NAME = "agent-multi-ask-user";
const HITL_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { answer: {
		type: "string",
		required: true
	} }
};
/**
* Install the ask-user tool on every HITL-enabled run child as it is
* created. The executor pre-assigns each activation's child session id and
* records it in `hitlChildren` before starting the activation, so the
* `agent/created` listener resolves membership without ordering assumptions.
* @param deps - run-wide installation dependencies.
* @returns the disposer removing the listener and every tool registration.
*/
function installHitlTool(deps) {
	const disposers = [];
	const listener = ({ agent }) => {
		if (!deps.hitlChildren.has(agent.id)) return;
		disposers.push(agent.ctx.tools.register(defineTool({
			name: HITL_TOOL_NAME,
			description: "Ask the human user one question when the task needs a decision or clarification.",
			parameters: {
				question: {
					type: "string",
					required: true,
					description: "The question to ask."
				},
				detail: {
					type: "string",
					description: "Optional context shown under the question."
				},
				options: {
					type: "array",
					items: { type: "string" },
					description: "Optional answer labels to choose from."
				},
				multiSelect: {
					type: "boolean",
					description: "Whether the user may select several options."
				}
			},
			output: {
				schema: HITL_VALUE_SCHEMA,
				render: (_args, value) => [{
					type: "text",
					text: JSON.stringify(value)
				}]
			},
			async execute(args, exec) {
				const nodeId = deps.nodeOf.get(agent.id) ?? "unknown";
				const item = {
					id: "agent-multi-hitl",
					question: args.question,
					...args.detail !== void 0 ? { detail: args.detail } : {},
					...args.options !== void 0 && args.options.length > 0 ? { options: args.options.map((label) => ({ label })) } : {},
					...args.multiSelect !== void 0 ? { multiSelect: args.multiSelect } : {}
				};
				await deps.journal.append("agent-multi/hitl-asked", {
					version: 1,
					runId: deps.runId,
					nodeId,
					question: args.question
				});
				const first = (await deps.ctx.userQuestions.ask({
					agent: deps.runRoot,
					questions: [item],
					signal: exec.signal
				})).answers[0];
				const selected = first === void 0 ? "" : [...first.selected, ...first.custom === void 0 ? [] : [first.custom]].join(", ");
				await deps.journal.append("agent-multi/hitl-answered", {
					version: 1,
					runId: deps.runId,
					nodeId,
					answer: selected
				});
				return { answer: selected };
			}
		})));
	};
	const off = deps.ctx.on("agent/created", listener);
	return { dispose() {
		off();
		for (const dispose of disposers.splice(0)) dispose();
	} };
}
//#endregion
//#region lib/types/engine/scheduler.js
const TEXT_BLOCK_TYPE = "text";
function textOf(blocks) {
	return blocks.filter((block) => block.type === TEXT_BLOCK_TYPE).map((block) => block.text).join("");
}
var Scheduler = class {
	definition;
	nodes;
	outEdges;
	inEdges;
	status = /* @__PURE__ */ new Map();
	ledger = /* @__PURE__ */ new Map();
	loopCounts = /* @__PURE__ */ new Map();
	runOutput;
	constructor(definition) {
		this.definition = definition;
		const nodeMap = /* @__PURE__ */ new Map();
		for (const node of definition.nodes) nodeMap.set(node.id, node);
		this.nodes = nodeMap;
		const outMap = /* @__PURE__ */ new Map();
		const inMap = /* @__PURE__ */ new Map();
		for (const node of definition.nodes) {
			outMap.set(node.id, []);
			inMap.set(node.id, []);
		}
		for (const edge of definition.edges) {
			outMap.get(edge.from)?.push(edge);
			inMap.get(edge.to)?.push(edge);
		}
		this.outEdges = outMap;
		this.inEdges = inMap;
		for (const node of definition.nodes) this.status.set(node.id, { state: "pending" });
	}
	/** Seed the input node with the run's user input and resolve it. */
	setInput(userInput) {
		const inputNode = this.definition.nodes.find((node) => node.kind === "input");
		if (inputNode === void 0) return;
		this.ledger.set(inputNode.id, [{
			type: "text",
			text: userInput
		}]);
		this.status.get(inputNode.id).state = "succeeded";
		this.settle();
	}
	/** Agent nodes ready to execute after control nodes have settled. */
	readyAgentNodes() {
		this.settle();
		const ready = [];
		for (const [id, status] of this.status) {
			if (status.state !== "pending") continue;
			const node = this.nodes.get(id);
			if (node.kind !== "agent") continue;
			if (this.isReady(id)) ready.push(node);
		}
		return ready;
	}
	/** Mark an agent node complete with its output and propagate. */
	completeAgent(nodeId, output) {
		if (!this.status.has(nodeId)) return;
		this.ledger.set(nodeId, output);
		this.status.get(nodeId).state = "succeeded";
		for (const edge of this.outEdges.get(nodeId) ?? []) if (edge.toHandle === "back") this.advanceLoop(edge.to, output);
		this.settle();
	}
	/** Mark an agent node failed; downstream nodes that depend on it cannot run. */
	failAgent(nodeId) {
		if (!this.status.has(nodeId)) return;
		this.status.get(nodeId).state = "failed";
	}
	/** The run's final output text once the output node has resolved. */
	getOutput() {
		return this.runOutput;
	}
	/** True when no node is pending or running. */
	isFinished() {
		for (const status of this.status.values()) if (status.state === "pending" || status.state === "running") return false;
		return true;
	}
	/** Read a node's stored output (engine ledger access). */
	nodeOutput(nodeId) {
		return this.ledger.get(nodeId);
	}
	/** Snapshot ledger entries for read-only prompt assembly. */
	ledgerSnapshot() {
		return this.ledger;
	}
	/**
	* Resolve control nodes and skip unreachable nodes until a fixed point:
	* control nodes whose dependencies are satisfied resolve deterministically;
	* pending nodes with no potentially-active in-edges are skipped as
	* unreachable, which may cascade further skips downstream.
	*/
	settle() {
		let changed = true;
		while (changed) {
			changed = false;
			for (const [id, status] of this.status) {
				if (status.state !== "pending") continue;
				const node = this.nodes.get(id);
				if (node.kind !== "input" && this.isUnreachable(id)) {
					status.state = "skipped";
					changed = true;
					continue;
				}
				if (node.kind === "input" || node.kind === "agent") continue;
				if (this.isReady(id)) {
					this.resolveControl(node);
					changed = true;
				}
			}
		}
	}
	/** In-edges that can still carry data (ready or waiting), excluding back returns. */
	liveInEdges(nodeId) {
		return (this.inEdges.get(nodeId) ?? []).filter((edge) => {
			const state = this.edgeState(edge);
			return state === "ready" || state === "waiting";
		});
	}
	/** A pending non-input node is unreachable when no in-edge can ever fire. */
	isUnreachable(nodeId) {
		return this.liveInEdges(nodeId).length === 0;
	}
	/** Whether a node's live in-edges are all satisfied (join strategy applied). */
	isReady(nodeId) {
		const node = this.nodes.get(nodeId);
		const live = this.liveInEdges(nodeId);
		if (live.length === 0) return false;
		const readyCount = live.filter((edge) => this.edgeState(edge) === "ready").length;
		if (node.kind === "join") {
			if (node.strategy === "all") return readyCount === live.length;
			if (node.strategy === "any") return readyCount >= 1;
			return readyCount >= (node.quorum ?? 1);
		}
		return readyCount === live.length;
	}
	/**
	* Classify one in-edge against its source's current state. Router edges match
	* the chosen case; loop edges match the emitted handle; plain nodes match any
	* out-edge once succeeded. Skipped or failed sources permanently deactivate
	* their edges; `back` returns are excluded from readiness entirely.
	*/
	edgeState(edge) {
		if (edge.toHandle === "back") return "inactive";
		const srcStatus = this.status.get(edge.from);
		if (srcStatus === void 0) return "inactive";
		const srcNode = this.nodes.get(edge.from);
		if (srcNode.kind === "router") {
			if (srcStatus.state === "succeeded") return edge.fromHandle === srcStatus.routerCase ? "ready" : "inactive";
			return srcStatus.state === "failed" || srcStatus.state === "skipped" ? "inactive" : "waiting";
		}
		if (srcNode.kind === "loop") {
			if (srcStatus.state === "running") {
				if (edge.fromHandle === srcStatus.loopEmit) return "ready";
				if (edge.fromHandle === "done") return "waiting";
				return "inactive";
			}
			if (srcStatus.state === "succeeded") return edge.fromHandle === srcStatus.loopEmit ? "ready" : "inactive";
			return srcStatus.state === "failed" || srcStatus.state === "skipped" ? "inactive" : "waiting";
		}
		if (srcStatus.state === "succeeded") return "ready";
		if (srcStatus.state === "failed" || srcStatus.state === "skipped") return "inactive";
		return "waiting";
	}
	/** Resolve a control node deterministically and store its ledger output. */
	resolveControl(node) {
		switch (node.kind) {
			case "note":
				this.status.get(node.id).state = "skipped";
				return;
			case "router":
				this.resolveRouter(node);
				return;
			case "join":
				this.resolveJoin(node);
				return;
			case "loop":
				this.activateLoop(node);
				return;
			case "output":
				this.resolveOutput(node);
				return;
			case "input":
			case "agent": return;
			default: return;
		}
	}
	resolveRouter(node) {
		const payload = this.mergePredecessorText(node.id);
		let chosen = "default";
		for (const caseEntry of node.cases) if (payload.toLowerCase().includes(caseEntry.toLowerCase())) {
			chosen = caseEntry;
			break;
		}
		const status = this.status.get(node.id);
		status.routerCase = chosen;
		status.state = "succeeded";
		this.ledger.set(node.id, this.mergePredecessorBlocks(node.id));
	}
	resolveJoin(node) {
		this.ledger.set(node.id, this.mergePredecessorBlocks(node.id));
		this.status.get(node.id).state = "succeeded";
	}
	activateLoop(node) {
		const status = this.status.get(node.id);
		status.state = "running";
		status.loopIter = 1;
		status.loopEmit = "iterate";
		status.loopOutputs = [];
		this.loopCounts.set(node.id, this.loopIterationCount(node));
	}
	advanceLoop(loopId, bodyOutput) {
		const status = this.status.get(loopId);
		if (status === void 0 || status.state !== "running") return;
		const node = this.nodes.get(loopId);
		if (node?.kind !== "loop") return;
		if (node.collect) status.loopOutputs?.push(textOf(bodyOutput));
		const count = this.loopCounts.get(loopId) ?? 1;
		const next = (status.loopIter ?? 1) + 1;
		status.loopIter = next;
		if (next <= count) {
			status.loopEmit = "iterate";
			this.resetBody(loopId);
		} else {
			status.loopEmit = "done";
			status.state = "succeeded";
			const collected = status.loopOutputs?.length ? status.loopOutputs.join("\n\n") : textOf(bodyOutput);
			this.ledger.set(loopId, [{
				type: "text",
				text: collected
			}]);
		}
	}
	resolveOutput(node) {
		const text = this.mergePredecessorText(node.id);
		this.ledger.set(node.id, [{
			type: "text",
			text
		}]);
		this.status.get(node.id).state = "succeeded";
		this.runOutput = text;
	}
	/** Reset every node in a loop's body (reachable from `iterate`, excluding the loop) to pending. */
	resetBody(loopId) {
		const iterateEdge = (this.outEdges.get(loopId) ?? []).find((edge) => edge.fromHandle === "iterate");
		if (iterateEdge === void 0) return;
		const body = /* @__PURE__ */ new Set();
		const stack = [iterateEdge.to];
		while (stack.length > 0) {
			const current = stack.pop();
			if (current === loopId || body.has(current)) continue;
			body.add(current);
			for (const edge of this.outEdges.get(current) ?? []) stack.push(edge.to);
		}
		for (const id of body) {
			const status = this.status.get(id);
			if (status === void 0) continue;
			status.state = "pending";
			delete status.routerCase;
			delete status.loopEmit;
			delete status.loopIter;
			delete status.loopOutputs;
			this.ledger.delete(id);
		}
	}
	loopIterationCount(node) {
		if (node.mode === "count" && node.count !== void 0) return Math.min(node.count, node.maxIters);
		return 1;
	}
	mergePredecessorText(nodeId) {
		return textOf(this.mergePredecessorBlocks(nodeId));
	}
	mergePredecessorBlocks(nodeId) {
		const parts = [];
		for (const edge of this.inEdges.get(nodeId) ?? []) {
			if (this.edgeState(edge) !== "ready") continue;
			const output = this.ledger.get(edge.from);
			if (output !== void 0) parts.push(textOf(output));
		}
		return [{
			type: "text",
			text: parts.join("\n\n")
		}];
	}
};
//#endregion
//#region lib/types/engine/run.js
/**
* Run orchestration for agent-multi: drives the ready-set scheduler to
* completion, journals the run lifecycle to the run session, caps concurrent
* node activations, and stops at a breakpoint on terminal node failure.
*
* The run root agent parents every node activation; the run session journal
* is the durable record. `resume` replays `node-end` events from the session
* to skip already-completed nodes before driving the remaining graph.
*/
/** Drive one workflow run to a terminal outcome. */
async function executeRun(options) {
	const { ctx, runRoot, definition, userInput, signal } = options;
	const maxActive = options.maxActive ?? 8;
	const runId = options.runId ?? brandString(randomUUID());
	const journal = new RunJournal(ctx, runRoot.session);
	const scheduler = new Scheduler(definition);
	scheduler.setInput(userInput);
	if (options.resume === true) replayJournal(scheduler, runRoot);
	await journal.append("agent-multi/run-start", {
		version: 1,
		runId,
		workflowId: definition.id,
		workflowRevision: definition.revision,
		input: userInput
	});
	if (options.resume === true) await journal.append("agent-multi/run-resumed", {
		version: 1,
		runId,
		mode: "resume"
	});
	const startedAt = Date.now();
	const inFlight = /* @__PURE__ */ new Map();
	let failure;
	let failureNodeId;
	const nodeOf = /* @__PURE__ */ new Map();
	const hitlChildren = /* @__PURE__ */ new Set();
	const hitl = installHitlTool({
		ctx,
		runRoot,
		journal,
		runId,
		nodeOf,
		hitlChildren
	});
	const fuse = createTokenFuse(options.tokenBudget);
	fuse.arm();
	const launch = (nodeId) => {
		const node = definition.nodes.find((candidate) => candidate.id === nodeId);
		if (node === void 0 || node.kind !== "agent") return;
		const inEdges = definition.edges.filter((edge) => edge.to === nodeId && edge.toHandle !== "back");
		const execution = executeAgentNode({
			ctx,
			runRoot,
			journal,
			runId,
			ledger: scheduler.ledgerSnapshot(),
			userInput,
			signal,
			nodeOf,
			hitlChildren,
			...fuse.consume !== void 0 ? { onNodeUsage: fuse.consume } : {}
		}, node, inEdges).then((outcome) => {
			if (outcome.ok) scheduler.completeAgent(nodeId, outcome.output);
			else {
				scheduler.failAgent(nodeId);
				failure = outcome;
				failureNodeId = nodeId;
			}
		});
		inFlight.set(nodeId, execution.finally(() => inFlight.delete(nodeId)));
	};
	try {
		while (failure === void 0 && !signal.aborted && !fuse.tripped()) {
			for (const node of scheduler.readyAgentNodes()) {
				if (inFlight.has(node.id)) continue;
				if (inFlight.size >= maxActive) break;
				launch(node.id);
			}
			if (inFlight.size === 0) break;
			await Promise.race(inFlight.values());
		}
		while (inFlight.size > 0) await Promise.race(inFlight.values());
	} finally {
		hitl.dispose();
		fuse.disarm();
	}
	if (fuse.tripped()) {
		await journal.append("agent-multi/run-paused", {
			version: 1,
			runId,
			reason: "breakpoint",
			...failureNodeId !== void 0 ? { nodeId: failureNodeId } : {}
		});
		await journal.append("agent-multi/run-end", {
			version: 1,
			runId,
			outcome: "failed",
			totalDurationMs: Date.now() - startedAt
		});
		return {
			outcome: "failed",
			runId,
			failure: {
				nodeId: failureNodeId ?? "(run)",
				errorClass: "deterministic",
				message: `token budget exceeded: ${fuse.consumed()} billed input+output tokens over a limit of ${fuse.budget()}`,
				attempts: 1
			}
		};
	}
	if (signal.aborted) {
		await journal.append("agent-multi/run-cancelled", {
			version: 1,
			runId
		});
		await journal.append("agent-multi/run-end", {
			version: 1,
			runId,
			outcome: "cancelled",
			totalDurationMs: Date.now() - startedAt
		});
		return {
			outcome: "cancelled",
			runId
		};
	}
	if (failure !== void 0 && failureNodeId !== void 0) {
		await journal.append("agent-multi/run-paused", {
			version: 1,
			runId,
			reason: "breakpoint",
			nodeId: failureNodeId
		});
		await journal.append("agent-multi/run-end", {
			version: 1,
			runId,
			outcome: "failed",
			totalDurationMs: Date.now() - startedAt
		});
		return {
			outcome: "failed",
			runId,
			failure: {
				nodeId: failureNodeId,
				errorClass: failure.errorClass,
				message: failure.message,
				attempts: failure.attempts
			}
		};
	}
	await journal.append("agent-multi/run-end", {
		version: 1,
		runId,
		outcome: "completed",
		totalDurationMs: Date.now() - startedAt
	});
	const output = scheduler.getOutput();
	if (output === void 0) return {
		outcome: "completed",
		runId
	};
	return {
		outcome: "completed",
		runId,
		output
	};
}
/**
* Seed the scheduler with completed nodes from the run session journal so a
* resumed run skips them. Only `node-end` events are replayed; failed nodes
* (no `node-end`) re-run from scratch.
*/
function replayJournal(scheduler, runRoot) {
	for (const event of runRoot.session.snapshotEvents()) {
		if (event.type !== "agent-multi/node-end") continue;
		const data = event.data;
		scheduler.completeAgent(data.nodeId, [{
			type: "text",
			text: data.output
		}]);
	}
}
/**
* Run-wide token fuse: sums billed tokens (uncached input + cache reads +
* cache writes + output) across every settled attempt and trips when the
* total crosses the budget. `consume` is absent when no budget is set, so
* the executor pays no observation cost on unbudgeted runs.
*/
function createTokenFuse(budget) {
	if (budget === void 0) return {
		arm: () => {},
		disarm: () => {},
		tripped: () => false,
		consumed: () => 0,
		budget: () => void 0,
		consume: void 0
	};
	let total = 0;
	let armed = false;
	let tripped = false;
	return {
		arm: () => {
			armed = true;
		},
		disarm: () => {
			armed = false;
		},
		tripped: () => tripped,
		consumed: () => total,
		budget: () => budget,
		consume: (usage) => {
			total += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
			if (armed && !tripped && total > budget) tripped = true;
		}
	};
}
//#endregion
//#region lib/types/engine/trigger-runtime.js
/** Largest delay Node timers represent without clamping. */
const MAX_TIMER_DELAY_MS = 2147483647;
/** Map one trigger timing onto the schedule package's recurring record vocabulary. */
function recurringRecordOf(timing, scheduledAt) {
	const id = ScheduleId("trigger");
	switch (timing.kind) {
		case "cron": return {
			kind: "cron",
			id,
			title: "trigger",
			prompt: "trigger",
			expression: timing.expression,
			timeZone: timing.timeZone,
			scheduledAt
		};
		case "daily": return {
			kind: "daily",
			id,
			title: "trigger",
			prompt: "trigger",
			time: timing.time,
			timeZone: timing.timeZone,
			scheduledAt
		};
		case "weekly": return {
			kind: "weekly",
			id,
			title: "trigger",
			prompt: "trigger",
			time: timing.time,
			timeZone: timing.timeZone,
			weekdays: [...timing.weekdays],
			scheduledAt
		};
	}
}
/**
* Owns the single host timer for workflow triggers.
*
* The runtime never throws to callers: drive failures are logged and the timer
* is re-armed from the still-durable committed targets.
*/
var TriggerRuntime = class {
	ctx;
	triggers;
	fire;
	commit;
	timer;
	running;
	stopping = false;
	requested = false;
	/**
	* @param ctx - Host context for logging and timer allocation.
	* @param triggers - Current durable trigger records.
	* @param fire - Start one run for a due trigger; resolves with the run id.
	* @param commit - Persist runtime-made trigger mutations.
	*/
	constructor(ctx, triggers, fire, commit) {
		this.ctx = ctx;
		this.triggers = triggers;
		this.fire = fire;
		this.commit = commit;
	}
	/** Recompute the nearest obligation after startup or a durable change. */
	requestDrive() {
		if (this.stopping) return;
		this.requested = true;
		this.clearTimer();
		if (this.running !== void 0) return;
		const run = (async () => {
			while (this.requested && !this.stopping) {
				this.requested = false;
				await this.drive();
			}
		})();
		this.running = run;
		run.catch((error) => {
			this.ctx.logger.warn(`agent-multi: trigger dispatch stopped: ${String(error)}`);
		}).finally(() => {
			this.running = void 0;
			if (this.requested && !this.stopping) this.requestDrive();
		});
	}
	/** Stop the timer and drain an accepted drive before disposal. */
	async dispose() {
		this.stopping = true;
		this.clearTimer();
		await this.running?.catch(() => void 0);
	}
	clearTimer() {
		if (this.timer !== void 0) clearTimeout(this.timer);
		this.timer = void 0;
	}
	async drive() {
		this.clearTimer();
		const scanNow = Date.now();
		const due = this.triggers().filter((record) => record.enabled && Date.parse(record.scheduledAt) <= scanNow);
		for (const record of due) {
			if (this.stopping) return;
			try {
				const occurrence = this.resolveOccurrence(record, Date.now());
				const runId = await this.fire(record);
				const next = occurrence.nextScheduledAt ?? occurrence.occurrenceAt;
				await this.commit({
					...record,
					scheduledAt: next,
					...runId !== void 0 ? { lastRunId: runId } : {}
				});
			} catch (error) {
				this.ctx.logger.warn(`agent-multi: trigger "${record.id}" failed to fire: ${String(error)}`);
			}
		}
		if (this.stopping) return;
		const next = this.triggers().filter((record) => record.enabled).reduce((at, record) => {
			const target = Date.parse(record.scheduledAt);
			return at === void 0 ? target : Math.min(at, target);
		}, void 0);
		if (next !== void 0) {
			this.timer = setTimeout(() => {
				this.timer = void 0;
				this.requestDrive();
			}, Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)));
			this.timer.unref();
		}
	}
	resolveOccurrence(record, now) {
		try {
			return resolveRecurringOccurrence(recurringRecordOf(record.timing, record.scheduledAt), now);
		} catch (error) {
			if (error instanceof ScheduleInputError || error instanceof Error) throw new Error(`trigger timing is unsatisfiable: ${error.message}`);
			throw error;
		}
	}
};
//#endregion
//#region lib/types/trigger-views.js
/**
* Trigger helpers shared by the controller: initial target computation over
* the schedule package's recurrence arithmetic, and the client view mapping.
* @module @deepseek-ai/dsh-experimental-agent-multi/src/trigger-views
*/
/** Compute the first strictly future UTC target for a timing rule. */
function initialTargetOf(timing, now) {
	switch (timing.kind) {
		case "cron": return createCronScheduleRecord(ScheduleId("trigger"), "trigger", {
			expression: timing.expression,
			time_zone: timing.timeZone
		}, now, "trigger").scheduledAt;
		case "daily": return createDailyScheduleRecord(ScheduleId("trigger"), "trigger", {
			time: timing.time,
			time_zone: timing.timeZone
		}, now, "trigger").scheduledAt;
		case "weekly": return createWeeklyScheduleRecord(ScheduleId("trigger"), "trigger", {
			time: timing.time,
			time_zone: timing.timeZone,
			weekdays: [...timing.weekdays]
		}, now, "trigger").scheduledAt;
	}
}
/** Project a stored trigger record into the client view. */
function triggerEntryOf(record) {
	return {
		id: record.id,
		workflowId: record.workflowId,
		timing: record.timing,
		input: record.input,
		...record.tokenBudget !== void 0 ? { tokenBudget: record.tokenBudget } : {},
		enabled: record.enabled,
		scheduledAt: record.scheduledAt,
		...record.lastRunId !== void 0 ? { lastRunId: record.lastRunId } : {},
		updatedAt: record.updatedAt
	};
}
//#endregion
//#region lib/types/index.js
/**
* Host service for agent-multi: durable workflow definitions with
* optimistic-concurrency editing, plus run execution (start, resume,
* cancel, inspect) over typert remote methods for the Web client.
* @module @deepseek-ai/dsh-experimental-agent-multi/src/index
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Render a node's content blocks to plain text for the dry-run result. */
function textOfContent(blocks) {
	return textOf$1(blocks);
}
/** Sentinel thrown inside a CAS write when the stored revision moved ahead. */
var RevisionConflict = class extends Error {
	current;
	constructor(current) {
		super("workflow revision conflict");
		this.current = current;
	}
};
/**
* Workflow CRUD and run service. Owns the `agent_multi` storage domain: the
* domain opens with the plugin, validates every stored record, and closes on
* dispose, so a hot reload never leaks a domain handle. Runs execute in a
* dedicated session each; the run registry is in-memory, so resuming a run
* after a host restart requires the run-root session recovery planned for a
* later phase.
*/
let AgentMultiController = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _ping_decorators;
	let _createWorkflow_decorators;
	let _saveWorkflow_decorators;
	let _listWorkflows_decorators;
	let _getWorkflow_decorators;
	let _deleteWorkflow_decorators;
	let _validateWorkflow_decorators;
	let _exportWorkflow_decorators;
	let _importWorkflow_decorators;
	let _createLibraryAgent_decorators;
	let _saveLibraryAgent_decorators;
	let _listLibraryAgents_decorators;
	let _deleteLibraryAgent_decorators;
	let _startRun_decorators;
	let _createTrigger_decorators;
	let _setTriggerEnabled_decorators;
	let _deleteTrigger_decorators;
	let _listTriggers_decorators;
	let _resumeRun_decorators;
	let _cancelRun_decorators;
	let _getRun_decorators;
	let _listRuns_decorators;
	let _dryRunNode_decorators;
	let _listModelCatalog_decorators;
	return class AgentMultiController extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_ping_decorators = [Remote("ping")];
			_createWorkflow_decorators = [Remote("createWorkflow")];
			_saveWorkflow_decorators = [Remote("saveWorkflow")];
			_listWorkflows_decorators = [Remote("listWorkflows")];
			_getWorkflow_decorators = [Remote("getWorkflow")];
			_deleteWorkflow_decorators = [Remote("deleteWorkflow")];
			_validateWorkflow_decorators = [Remote("validateWorkflow")];
			_exportWorkflow_decorators = [Remote("exportWorkflow")];
			_importWorkflow_decorators = [Remote("importWorkflow")];
			_createLibraryAgent_decorators = [Remote("createLibraryAgent")];
			_saveLibraryAgent_decorators = [Remote("saveLibraryAgent")];
			_listLibraryAgents_decorators = [Remote("listLibraryAgents")];
			_deleteLibraryAgent_decorators = [Remote("deleteLibraryAgent")];
			_startRun_decorators = [Remote("startRun")];
			_createTrigger_decorators = [Remote("createTrigger")];
			_setTriggerEnabled_decorators = [Remote("setTriggerEnabled")];
			_deleteTrigger_decorators = [Remote("deleteTrigger")];
			_listTriggers_decorators = [Remote("listTriggers")];
			_resumeRun_decorators = [Remote("resumeRun")];
			_cancelRun_decorators = [Remote("cancelRun")];
			_getRun_decorators = [Remote("getRun")];
			_listRuns_decorators = [Remote("listRuns")];
			_dryRunNode_decorators = [Remote("dryRunNode")];
			_listModelCatalog_decorators = [Remote("listModelCatalog")];
			__esDecorate(this, null, _ping_decorators, {
				kind: "method",
				name: "ping",
				static: false,
				private: false,
				access: {
					has: (obj) => "ping" in obj,
					get: (obj) => obj.ping
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createWorkflow_decorators, {
				kind: "method",
				name: "createWorkflow",
				static: false,
				private: false,
				access: {
					has: (obj) => "createWorkflow" in obj,
					get: (obj) => obj.createWorkflow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _saveWorkflow_decorators, {
				kind: "method",
				name: "saveWorkflow",
				static: false,
				private: false,
				access: {
					has: (obj) => "saveWorkflow" in obj,
					get: (obj) => obj.saveWorkflow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listWorkflows_decorators, {
				kind: "method",
				name: "listWorkflows",
				static: false,
				private: false,
				access: {
					has: (obj) => "listWorkflows" in obj,
					get: (obj) => obj.listWorkflows
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getWorkflow_decorators, {
				kind: "method",
				name: "getWorkflow",
				static: false,
				private: false,
				access: {
					has: (obj) => "getWorkflow" in obj,
					get: (obj) => obj.getWorkflow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteWorkflow_decorators, {
				kind: "method",
				name: "deleteWorkflow",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteWorkflow" in obj,
					get: (obj) => obj.deleteWorkflow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _validateWorkflow_decorators, {
				kind: "method",
				name: "validateWorkflow",
				static: false,
				private: false,
				access: {
					has: (obj) => "validateWorkflow" in obj,
					get: (obj) => obj.validateWorkflow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _exportWorkflow_decorators, {
				kind: "method",
				name: "exportWorkflow",
				static: false,
				private: false,
				access: {
					has: (obj) => "exportWorkflow" in obj,
					get: (obj) => obj.exportWorkflow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _importWorkflow_decorators, {
				kind: "method",
				name: "importWorkflow",
				static: false,
				private: false,
				access: {
					has: (obj) => "importWorkflow" in obj,
					get: (obj) => obj.importWorkflow
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createLibraryAgent_decorators, {
				kind: "method",
				name: "createLibraryAgent",
				static: false,
				private: false,
				access: {
					has: (obj) => "createLibraryAgent" in obj,
					get: (obj) => obj.createLibraryAgent
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _saveLibraryAgent_decorators, {
				kind: "method",
				name: "saveLibraryAgent",
				static: false,
				private: false,
				access: {
					has: (obj) => "saveLibraryAgent" in obj,
					get: (obj) => obj.saveLibraryAgent
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listLibraryAgents_decorators, {
				kind: "method",
				name: "listLibraryAgents",
				static: false,
				private: false,
				access: {
					has: (obj) => "listLibraryAgents" in obj,
					get: (obj) => obj.listLibraryAgents
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteLibraryAgent_decorators, {
				kind: "method",
				name: "deleteLibraryAgent",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteLibraryAgent" in obj,
					get: (obj) => obj.deleteLibraryAgent
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _startRun_decorators, {
				kind: "method",
				name: "startRun",
				static: false,
				private: false,
				access: {
					has: (obj) => "startRun" in obj,
					get: (obj) => obj.startRun
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createTrigger_decorators, {
				kind: "method",
				name: "createTrigger",
				static: false,
				private: false,
				access: {
					has: (obj) => "createTrigger" in obj,
					get: (obj) => obj.createTrigger
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setTriggerEnabled_decorators, {
				kind: "method",
				name: "setTriggerEnabled",
				static: false,
				private: false,
				access: {
					has: (obj) => "setTriggerEnabled" in obj,
					get: (obj) => obj.setTriggerEnabled
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteTrigger_decorators, {
				kind: "method",
				name: "deleteTrigger",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteTrigger" in obj,
					get: (obj) => obj.deleteTrigger
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listTriggers_decorators, {
				kind: "method",
				name: "listTriggers",
				static: false,
				private: false,
				access: {
					has: (obj) => "listTriggers" in obj,
					get: (obj) => obj.listTriggers
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _resumeRun_decorators, {
				kind: "method",
				name: "resumeRun",
				static: false,
				private: false,
				access: {
					has: (obj) => "resumeRun" in obj,
					get: (obj) => obj.resumeRun
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _cancelRun_decorators, {
				kind: "method",
				name: "cancelRun",
				static: false,
				private: false,
				access: {
					has: (obj) => "cancelRun" in obj,
					get: (obj) => obj.cancelRun
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getRun_decorators, {
				kind: "method",
				name: "getRun",
				static: false,
				private: false,
				access: {
					has: (obj) => "getRun" in obj,
					get: (obj) => obj.getRun
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listRuns_decorators, {
				kind: "method",
				name: "listRuns",
				static: false,
				private: false,
				access: {
					has: (obj) => "listRuns" in obj,
					get: (obj) => obj.listRuns
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _dryRunNode_decorators, {
				kind: "method",
				name: "dryRunNode",
				static: false,
				private: false,
				access: {
					has: (obj) => "dryRunNode" in obj,
					get: (obj) => obj.dryRunNode
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listModelCatalog_decorators, {
				kind: "method",
				name: "listModelCatalog",
				static: false,
				private: false,
				access: {
					has: (obj) => "listModelCatalog" in obj,
					get: (obj) => obj.listModelCatalog
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = [
			"storageDomain",
			"agentLoop",
			"sessions",
			"subagents",
			"userQuestions",
			"sessionProjections"
		];
		static Config = z.object({
			runRootProvider: z.string().default("deepseek"),
			runRootModel: z.string().default("deepseek-chat"),
			maxActive: z.number().step(1).min(1).default(8),
			tokenBudget: z.number().step(1).min(0)
		});
		ready = __runInitializers(this, _instanceExtraInitializers);
		runs = /* @__PURE__ */ new Map();
		config;
		triggerRuntime;
		/** Resolved domain handle once `ready` settles; the promise never rejects. */
		resolvedDomain;
		constructor(ctx, config) {
			super(ctx, "agentMultiController", { namespace: "agentMulti" });
			this.config = {
				runRootProvider: config.runRootProvider ?? "deepseek",
				runRootModel: config.runRootModel ?? "deepseek-chat",
				maxActive: config.maxActive ?? 8,
				...config.tokenBudget !== void 0 ? { tokenBudget: config.tokenBudget } : {}
			};
			this.ready = ctx.storageDomain.open(agentMultiDomain).then(async (domain) => {
				for (const [key, record] of domain.table("workflows").entries()) if (key !== record.definition.id) {
					try {
						await domain.close();
					} catch (error) {
						ctx.logger.warn(`agent-multi: closing the domain after a key mismatch failed: ${String(error)}`);
					}
					throw new Error(`agent-multi: stored workflow key "${key}" differs from record id "${record.definition.id}"`);
				}
				this.resolvedDomain = domain;
				return domain;
			});
			this.triggerRuntime = new TriggerRuntime(ctx, () => {
				const domain = this.domainOf();
				return domain === void 0 ? [] : [...domain.table("triggers").entries()].map(([, record]) => record);
			}, async (trigger) => await this.fireTrigger(trigger), async (trigger) => {
				await (await this.ready).table("triggers").put(trigger.id, triggerRecordSchema.parse(trigger));
			});
			ctx.effect(async () => {
				const domain = await this.ready;
				this.triggerRuntime.requestDrive();
				return () => {
					domain.close();
				};
			});
			ctx.effect(() => {
				const disposeProjection = ctx.root.sessionProjections.register(agentMultiProjectionDefinition);
				return () => disposeProjection();
			});
			ctx.effect(() => () => {
				this.triggerRuntime.dispose();
				for (const record of this.runs.values()) record.controller.abort();
			});
		}
		/** Recompute the trigger timer after any durable trigger change. */
		requestTriggerDrive() {
			this.triggerRuntime.requestDrive();
		}
		/** Synchronous domain access when already resolved, for the timer read. */
		domainOf() {
			return this.resolvedDomain;
		}
		/** Spike smoke method; retained as the cheapest remote round-trip check. */
		ping() {
			return { pong: true };
		}
		/**
		 * Read the host model catalog: registered providers with their models, so
		 * the client can offer provider/model dropdowns instead of free text. A
		 * provider whose model listing fails is skipped, not fatal.
		 */
		async listModelCatalog() {
			const providers = this.ctx.llm.listProviders().map((provider) => ({ id: provider.id, name: provider.name }));
			const models = (await Promise.all(providers.map(async (provider) => {
				try {
					const listed = await this.ctx.llm.listModels(provider.id);
					return listed.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
				} catch {
					this.ctx.logger.warn(`agent-multi: listing models for provider "${provider.id}" failed`);
					return [];
				}
			}))).flat();
			return { providers, models };
		}
		/** @param request - Draft content for a new workflow. */
		async createWorkflow(request) {
			const errors = checkDraft(request.draft);
			if (errors.length > 0) return {
				outcome: "invalid",
				errors
			};
			const definition = {
				version: 1,
				id: brandString(randomUUID()),
				revision: 1,
				name: request.draft.name,
				nodes: request.draft.nodes,
				edges: request.draft.edges
			};
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const record = workflowRecordSchema.parse({
				definition,
				createdAt: now,
				updatedAt: now
			});
			await (await this.ready).table("workflows").put(definition.id, record);
			return {
				outcome: "created",
				definition
			};
		}
		/** @param request - Draft content plus the revision the editor based it on. */
		async saveWorkflow(request) {
			const errors = checkDraft(request.draft);
			if (errors.length > 0) return {
				outcome: "invalid",
				errors
			};
			const table = (await this.ready).table("workflows");
			if (table.get(request.id) === void 0) return { outcome: "missing" };
			const now = (/* @__PURE__ */ new Date()).toISOString();
			try {
				return {
					outcome: "saved",
					definition: (await table.update(request.id, (current) => {
						if (current.definition.revision !== request.expectedRevision) throw new RevisionConflict(current.definition);
						const definition = {
							version: 1,
							id: request.id,
							revision: request.expectedRevision + 1,
							name: request.draft.name,
							nodes: request.draft.nodes,
							edges: request.draft.edges
						};
						return workflowRecordSchema.parse({
							definition,
							createdAt: current.createdAt,
							updatedAt: now
						});
					})).definition
				};
			} catch (error) {
				if (error instanceof RevisionConflict) return {
					outcome: "conflict",
					current: error.current
				};
				throw error;
			}
		}
		/** Lists every stored workflow, name-ascending with id as tiebreaker. */
		async listWorkflows() {
			return [...(await this.ready).table("workflows").entries()].map(([, record]) => ({
				id: record.definition.id,
				name: record.definition.name,
				revision: record.definition.revision,
				updatedAt: record.updatedAt
			})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1);
		}
		/** @param request - Exact workflow identity. */
		async getWorkflow(request) {
			const record = (await this.ready).table("workflows").get(request.id);
			if (record === void 0) return { outcome: "missing" };
			return {
				outcome: "found",
				definition: record.definition,
				createdAt: record.createdAt,
				updatedAt: record.updatedAt
			};
		}
		/** @param request - Exact workflow identity. */
		async deleteWorkflow(request) {
			return await (await this.ready).table("workflows").delete(request.id) ? { outcome: "deleted" } : { outcome: "missing" };
		}
		/** @param request - Draft to validate without storing. */
		async validateWorkflow(request) {
			return { errors: checkDraft(request.draft) };
		}
		/**
		* Export one stored workflow as a portable document: the definition plus a
		* package stamp. The document round-trips through {@link importWorkflow}.
		* @param request - The workflow to export.
		*/
		async exportWorkflow(request) {
			const record = (await this.ready).table("workflows").get(request.id);
			if (record === void 0) return { outcome: "missing" };
			return {
				outcome: "found",
				document: {
					kind: "dsh-agent-multi-workflow",
					version: 1,
					definition: record.definition
				}
			};
		}
		/**
		* Import a portable workflow document: validated from scratch, stored with
		* either the exported identity (`keepId`) or a fresh id. An id collision
		* under `keepId` fails as `invalid` rather than overwriting.
		* @param request - The document and identity policy.
		*/
		async importWorkflow(request) {
			const { document } = request;
			if (document.kind !== "dsh-agent-multi-workflow" || document.version !== 1) return {
				outcome: "invalid",
				errors: [{
					code: "schema-invalid",
					message: "unknown workflow document kind or version"
				}]
			};
			const parsed = workflowRecordSchema.safeParse({
				definition: document.definition,
				createdAt: (/* @__PURE__ */ new Date()).toISOString(),
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			if (!parsed.success) return {
				outcome: "invalid",
				errors: [{
					code: "schema-invalid",
					message: "document does not match the workflow schema"
				}]
			};
			const definition = {
				...parsed.data.definition,
				id: request.keepId === true ? parsed.data.definition.id : brandString(randomUUID()),
				revision: 1
			};
			const errors = validateWorkflow(definition);
			if (errors.length > 0) return {
				outcome: "invalid",
				errors
			};
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const domain = await this.ready;
			if (await domain.table("workflows").get(definition.id) !== void 0) return {
				outcome: "invalid",
				errors: [{
					code: "duplicate-id",
					message: `workflow id "${definition.id}" already exists`
				}]
			};
			const record = workflowRecordSchema.parse({
				definition,
				createdAt: now,
				updatedAt: now
			});
			await domain.table("workflows").put(definition.id, record);
			return {
				outcome: "created",
				definition
			};
		}
		/**
		* Save one agent-node spec into the reusable library. The spec is validated
		* structurally (the same schema agent nodes use); a fresh agent id is
		* assigned on create.
		* @param request - Display name and the reusable agent payload.
		*/
		async createLibraryAgent(request) {
			const parsed = agentLibraryRecordSchema.safeParse({
				id: randomUUID(),
				name: request.name,
				spec: request.spec,
				createdAt: (/* @__PURE__ */ new Date()).toISOString(),
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			if (!parsed.success) return {
				outcome: "invalid",
				errors: parsed.error.issues.map((issue) => ({
					code: "schema-invalid",
					message: `${issue.path.join(".")}: ${issue.message}`
				}))
			};
			const record = parsed.data;
			await (await this.ready).table("agents").put(record.id, record);
			return {
				outcome: "created",
				agent: {
					id: record.id,
					name: record.name,
					spec: record.spec,
					updatedAt: record.updatedAt
				}
			};
		}
		/**
		* Replace one library agent's name and spec.
		* @param request - The agent to update and its replacement content.
		*/
		async saveLibraryAgent(request) {
			const domain = await this.ready;
			const current = await domain.table("agents").get(request.id);
			if (current === void 0) return { outcome: "missing" };
			const parsed = agentLibraryRecordSchema.safeParse({
				id: request.id,
				name: request.name,
				spec: request.spec,
				createdAt: current.createdAt,
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
			if (!parsed.success) return {
				outcome: "invalid",
				errors: parsed.error.issues.map((issue) => ({
					code: "schema-invalid",
					message: `${issue.path.join(".")}: ${issue.message}`
				}))
			};
			await domain.table("agents").put(parsed.data.id, parsed.data);
			return {
				outcome: "saved",
				agent: {
					id: parsed.data.id,
					name: parsed.data.name,
					spec: parsed.data.spec,
					updatedAt: parsed.data.updatedAt
				}
			};
		}
		/** Lists every library agent, name-ascending with id as tiebreaker. */
		async listLibraryAgents() {
			return [...(await this.ready).table("agents").entries()].map(([, record]) => ({
				id: record.id,
				name: record.name,
				spec: record.spec,
				updatedAt: record.updatedAt
			})).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1);
		}
		/**
		* Delete one library agent. Stored workflows keep their own node copies,
		* so deleting never breaks an existing workflow.
		* @param request - The agent to remove.
		*/
		async deleteLibraryAgent(request) {
			return await (await this.ready).table("agents").delete(request.id) ? { outcome: "deleted" } : { outcome: "missing" };
		}
		/**
		* Start a run: a dedicated session, a dormant run-root agent parenting every
		* node activation, and the engine driving the workflow to a terminal
		* outcome. Returns the run identity immediately; poll `get-run`.
		* @param request - The workflow to execute and the user input.
		*/
		async startRun(request) {
			const record = (await this.ready).table("workflows").get(request.workflowId);
			if (record === void 0) return { outcome: "missing" };
			const runRoot = await this.ctx.agentLoop.create(SessionId(randomUUID()), {
				provider: this.config.runRootProvider,
				model: this.config.runRootModel
			});
			const budget = request.tokenBudget !== void 0 ? request.tokenBudget : this.config.tokenBudget;
			return this.launchRun(record.definition, request.input, runRoot, false, void 0, budget);
		}
		/**
		* Fire one trigger: resolve the workflow, start the run, and return the run
		* id so the runtime can record it as the trigger's latest run. Resolves with
		* `undefined` when the workflow disappeared; the trigger keeps its target.
		* @param trigger - The due trigger record.
		*/
		async fireTrigger(trigger) {
			const record = (await this.ready).table("workflows").get(trigger.workflowId);
			if (record === void 0) return void 0;
			const runRoot = await this.ctx.agentLoop.create(SessionId(randomUUID()), {
				provider: this.config.runRootProvider,
				model: this.config.runRootModel
			});
			const budget = trigger.tokenBudget !== void 0 ? trigger.tokenBudget : this.config.tokenBudget;
			return this.launchRun(record.definition, trigger.input, runRoot, false, void 0, budget).runId;
		}
		/**
		* Create a workflow trigger. The timing rule is validated by the schedule
		* package's recurrence arithmetic and armed with its first future target.
		* @param request - Workflow binding, timing rule, and run parameters.
		*/
		async createTrigger(request) {
			const domain = await this.ready;
			if (domain.table("workflows").get(request.workflowId) === void 0) return { outcome: "missing" };
			let scheduledAt;
			try {
				scheduledAt = initialTargetOf(request.timing, Date.now());
			} catch (error) {
				return {
					outcome: "invalid",
					errors: [{
						code: "schema-invalid",
						message: `timing: ${error instanceof Error ? error.message : String(error)}`
					}]
				};
			}
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const parsed = triggerRecordSchema.safeParse({
				id: randomUUID(),
				workflowId: request.workflowId,
				timing: request.timing,
				input: request.input,
				...request.tokenBudget !== void 0 ? { tokenBudget: request.tokenBudget } : {},
				enabled: true,
				scheduledAt,
				createdAt: now,
				updatedAt: now
			});
			if (!parsed.success) return {
				outcome: "invalid",
				errors: parsed.error.issues.map((issue) => ({
					code: "schema-invalid",
					message: `${issue.path.join(".")}: ${issue.message}`
				}))
			};
			await domain.table("triggers").put(parsed.data.id, parsed.data);
			this.requestTriggerDrive();
			return {
				outcome: "created",
				trigger: triggerEntryOf(parsed.data)
			};
		}
		/**
		* Enable or disable one trigger. Disabling stops the timer obligation; the
		* committed target is preserved, so re-enabling never back-fires missed runs.
		* @param request - The trigger and its new enabled state.
		*/
		async setTriggerEnabled(request) {
			const table = (await this.ready).table("triggers");
			const current = table.get(request.id);
			if (current === void 0) return { outcome: "missing" };
			const updated = {
				...current,
				enabled: request.enabled,
				...request.enabled ? { scheduledAt: initialTargetOf(current.timing, Date.now()) } : {},
				updatedAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			await table.put(request.id, triggerRecordSchema.parse(updated));
			this.requestTriggerDrive();
			return {
				outcome: "saved",
				trigger: triggerEntryOf(updated)
			};
		}
		/**
		* Delete one trigger. Runs already started by it keep running.
		* @param request - The trigger to remove.
		*/
		async deleteTrigger(request) {
			const deleted = await (await this.ready).table("triggers").delete(request.id);
			this.requestTriggerDrive();
			return deleted ? { outcome: "deleted" } : { outcome: "missing" };
		}
		/**
		* List triggers, oldest first, optionally narrowed to one workflow.
		* @param request - Workflow filter, or all triggers when omitted.
		*/
		async listTriggers(request) {
			return { triggers: [...(await this.ready).table("triggers").entries()].map(([, record]) => record).filter((record) => request.workflowId === void 0 || record.workflowId === request.workflowId).sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1).map((record) => triggerEntryOf(record)) };
		}
		/**
		* Resume a paused or failed run on its existing session: completed nodes
		* are skipped from the journal, the current stored definition is used (so
		* edits between attempts take effect), and the original input replays.
		* @param request - The run to continue.
		*/
		async resumeRun(request) {
			const entry = this.runs.get(request.runId);
			if (entry === void 0) return { outcome: "missing" };
			if (!entry.settled) return { outcome: "running" };
			const record = (await this.ready).table("workflows").get(entry.workflowId);
			if (record === void 0) return { outcome: "missing" };
			this.runs.delete(request.runId);
			return this.launchRun(record.definition, entry.lastInput, entry.runRoot, true, entry.runId);
		}
		/**
		* Cancel a run: aborts the run signal, which tears down in-flight node
		* activations and settles the run as cancelled. Awaiting the settled
		* status makes the response deterministic.
		* @param request - The run to abort.
		*/
		async cancelRun(request) {
			const entry = this.runs.get(request.runId);
			if (entry === void 0) return { outcome: "missing" };
			entry.controller.abort();
			await entry.execution;
			return {
				outcome: "cancelled",
				runId: request.runId,
				status: runStatusOf(entry)
			};
		}
		/**
		* Inspect a run: status plus the full agent-multi journal projected from
		* the run session (the kanban derives from these events).
		* @param request - Exact run identity.
		*/
		async getRun(request) {
			const entry = this.runs.get(request.runId);
			if (entry === void 0) return { outcome: "missing" };
			return {
				outcome: "found",
				run: this.viewOf(entry)
			};
		}
		/**
		* List tracked runs, newest first, optionally narrowed to one workflow.
		* Registry is in-memory, so the history covers this host process only.
		* @param request - Workflow filter, or all workflows when omitted.
		*/
		async listRuns(request) {
			return { runs: [...this.runs.values()].filter((entry) => request.workflowId === void 0 || entry.workflowId === request.workflowId).reverse().map((entry) => {
				const result = entry.result;
				const failure = result?.failure === void 0 ? {} : { failure: { ...result.failure } };
				return {
					runId: entry.runId,
					workflowId: entry.workflowId,
					status: runStatusOf(entry),
					...failure
				};
			}) };
		}
		/**
		* Dry-run one agent node in isolation: a throwaway run-root session, no
		* workflow storage, no journal registration. Resolves with the settled
		* node outcome so the caller sees the final output or failure directly.
		* @param request - The node spec to try and the input to feed it.
		*/
		async dryRunNode(request) {
			const runRoot = await this.ctx.agentLoop.create(SessionId(randomUUID()), {
				provider: this.config.runRootProvider,
				model: this.config.runRootModel
			});
			const controller = new AbortController();
			const journal = new RunJournal(this.ctx, runRoot.session);
			const deps = {
				ctx: this.ctx,
				runRoot,
				journal,
				runId: brandString(randomUUID()),
				ledger: /* @__PURE__ */ new Map(),
				userInput: request.input,
				signal: controller.signal,
				nodeOf: /* @__PURE__ */ new Map(),
				hitlChildren: /* @__PURE__ */ new Set()
			};
			try {
				const outcome = await executeAgentNode(deps, request.node, []);
				if (outcome.ok) {
					const events = runRoot.session.snapshotEvents().filter((event) => event.type === "agent-multi/node-end");
					const usage = events.length > 0 ? (events.at(-1)?.data).usage : void 0;
					const durationMs = events.length > 0 ? (events.at(-1)?.data).durationMs ?? 0 : 0;
					return {
						outcome: "completed",
						output: textOfContent(outcome.output),
						durationMs,
						...usage !== void 0 ? { usage } : {}
					};
				}
				return {
					outcome: "failed",
					errorClass: outcome.errorClass,
					message: outcome.message,
					attempts: outcome.attempts
				};
			} finally {
				controller.abort();
			}
		}
		/**
		* Launch (or relaunch) one run and register it. The execution promise never
		* rejects here: the engine maps every outcome to a {@link RunResult}, and a
		* journaling failure is contained as a synthetic failed run.
		*/
		launchRun(definition, input, runRoot, resume, runId = brandString(randomUUID()), tokenBudget) {
			const controller = new AbortController();
			const execution = executeRun({
				ctx: this.ctx,
				runRoot,
				definition,
				userInput: input,
				signal: controller.signal,
				maxActive: this.config.maxActive,
				resume,
				runId,
				...tokenBudget !== void 0 ? { tokenBudget } : {}
			});
			const entry = {
				runId,
				workflowId: definition.id,
				runRoot,
				controller,
				execution,
				lastInput: input,
				settled: false,
				result: void 0
			};
			this.runs.set(runId, entry);
			execution.then((result) => {
				entry.settled = true;
				entry.result = result;
			}, () => {
				entry.settled = true;
				entry.result = {
					outcome: "failed",
					runId
				};
			});
			return {
				outcome: "started",
				runId
			};
		}
		/** Project a run record into the client view over its session journal and projection. */
		viewOf(entry) {
			const events = entry.runRoot.session.snapshotEvents().filter((event) => event.type.startsWith("agent-multi/")).map((event) => ({
				type: event.type,
				data: event.data
			}));
			const result = entry.result;
			const failure = result?.failure === void 0 ? {} : { failure: { ...result.failure } };
			const projected = this.ctx.sessionProjections.stateOf(entry.runRoot.session, "agentMulti");
			const nodes = projected?.run === void 0 ? [] : Object.values(projected.run.nodes).map((node) => ({
				nodeId: node.nodeId,
				nodeKind: node.nodeKind,
				status: node.status,
				attempt: node.attempt,
				...node.streaming === void 0 ? {} : { streaming: node.streaming },
				...node.output === void 0 ? {} : { output: node.output },
				...node.errorClass === void 0 ? {} : { errorClass: node.errorClass },
				...node.message === void 0 ? {} : { message: node.message },
				...node.attempts === void 0 ? {} : { attempts: node.attempts },
				...node.durationMs === void 0 ? {} : { durationMs: node.durationMs },
				...node.usage === void 0 ? {} : { usage: node.usage }
			}));
			const hitl = projected?.run?.hitl === void 0 ? {} : { hitl: {
				nodeId: projected.run.hitl.nodeId,
				question: projected.run.hitl.question,
				...projected.run.hitl.answer === void 0 ? {} : { answer: projected.run.hitl.answer }
			} };
			const pausedReason = projected?.run?.pauseReason === void 0 ? {} : { pausedReason: projected.run.pauseReason };
			if (result?.output === void 0) return {
				runId: entry.runId,
				workflowId: entry.workflowId,
				status: runStatusOf(entry),
				nodes,
				...hitl,
				...pausedReason,
				events,
				...failure
			};
			return {
				runId: entry.runId,
				workflowId: entry.workflowId,
				status: runStatusOf(entry),
				nodes,
				...hitl,
				...pausedReason,
				events,
				...failure,
				output: result.output
			};
		}
	};
})();
/** Terminal or in-progress status of a tracked run. */
function runStatusOf(entry) {
	return entry.settled ? entry.result?.outcome ?? "failed" : "running";
}
/** Structural parse followed by semantic graph rules. */
function checkDraft(draft) {
	const parsed = workflowDraftSchema.safeParse(draft);
	if (!parsed.success) return parsed.error.issues.map((issue) => ({
		code: "schema-invalid",
		message: `${issue.path.join(".")}: ${issue.message}`
	}));
	return validateWorkflow(parsed.data);
}
//#endregion
export { AgentMultiController, AgentMultiController as default };
