/**
 * Semantic graph validation for workflow drafts. Structural shape and
 * per-field bounds live in the zod domain schema; this module owns the graph
 * rules: endpoint references, handle completeness, degree legality, guarded
 * cycles, and template references.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/validation
 */
import { TEMPLATE_NODE_REF_RE } from "./contract.js";
/**
 * Validate a workflow draft against the semantic graph rules. Pure: no
 * context, no storage, no exceptions. Returns every issue found so the
 * inspector can surface the full rejection matrix at once.
 * @param draft - Draft to validate.
 * @returns issues in no guaranteed order; empty means the draft is runnable.
 */
export function validateWorkflow(draft) {
    const issues = [];
    const nodes = new Map(draft.nodes.map(node => [node.id, node]));
    const nodeIds = new Set(nodes.keys());
    if (draft.name.trim().length === 0) {
        issues.push({ code: 'name-empty', message: 'workflow name must not be blank' });
    }
    for (const node of draft.nodes) {
        if (!NODE_ID_RE.test(node.id)) {
            issues.push({ code: 'node-id-invalid', message: `node id '${node.id}' must match [A-Za-z0-9_-]+`, nodeId: node.id });
        }
    }
    issueDuplicateIds(draft, issues);
    const edges = draft.edges;
    const outEdges = new Map();
    const inEdges = new Map();
    for (const edge of edges) {
        if (edge.from === edge.to) {
            issues.push({ code: 'edge-self', message: `edge '${edge.id}' connects node '${edge.from}' to itself`, edgeId: edge.id, nodeId: edge.from });
        }
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (from === undefined) {
            issues.push({ code: 'edge-endpoint-unknown', message: `edge '${edge.id}' starts at unknown node '${edge.from}'`, edgeId: edge.id });
        }
        if (to === undefined) {
            issues.push({ code: 'edge-endpoint-unknown', message: `edge '${edge.id}' ends at unknown node '${edge.to}'`, edgeId: edge.id });
        }
        if (from === undefined || to === undefined)
            continue;
        if (from.kind === 'note' || to.kind === 'note') {
            issues.push({ code: 'edge-note', message: `edge '${edge.id}' touches note node '${from.kind === 'note' ? from.id : to.id}'; notes never connect`, edgeId: edge.id });
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
    if (list === undefined)
        map.set(key, [edge]);
    else
        list.push(edge);
}
function issueDuplicateIds(draft, issues) {
    const nodeIds = new Set();
    for (const node of draft.nodes) {
        if (nodeIds.has(node.id)) {
            issues.push({ code: 'node-id-duplicate', message: `duplicate node id '${node.id}'`, nodeId: node.id });
        }
        nodeIds.add(node.id);
    }
    const edgeIds = new Set();
    for (const edge of draft.edges) {
        if (edgeIds.has(edge.id)) {
            issues.push({ code: 'edge-id-duplicate', message: `duplicate edge id '${edge.id}'`, edgeId: edge.id });
        }
        edgeIds.add(edge.id);
    }
}
function issueHandleLegality(edge, from, to, issues) {
    if (from.kind === 'router') {
        if (edge.fromHandle === undefined) {
            issues.push({ code: 'router-handle-missing', message: `router out-edge '${edge.id}' must declare fromHandle (a case name or 'default')`, edgeId: edge.id, nodeId: from.id });
        }
        else if (edge.fromHandle !== 'default' && !from.cases.includes(edge.fromHandle)) {
            issues.push({ code: 'router-handle-unknown', message: `edge '${edge.id}' uses fromHandle '${edge.fromHandle}' which is neither a declared case nor 'default'`, edgeId: edge.id, nodeId: from.id, handle: edge.fromHandle });
        }
    }
    else if (from.kind === 'loop') {
        if (edge.fromHandle !== 'iterate' && edge.fromHandle !== 'done') {
            issues.push({ code: 'loop-handle-unknown', message: `loop out-edge '${edge.id}' must use fromHandle 'iterate' or 'done'`, edgeId: edge.id, nodeId: from.id });
        }
    }
    else if (edge.fromHandle !== undefined) {
        issues.push({ code: 'edge-handle-unexpected', message: `edge '${edge.id}' declares fromHandle '${edge.fromHandle}' but its source node has no handles`, edgeId: edge.id, nodeId: from.id });
    }
    if (edge.toHandle !== undefined) {
        if (edge.toHandle !== 'back' || to.kind !== 'loop') {
            issues.push({ code: 'edge-tohandle-invalid', message: `edge '${edge.id}' declares toHandle '${edge.toHandle ?? ''}'; only 'back' into a loop node is valid`, edgeId: edge.id, nodeId: to.id });
        }
    }
}
function issueEndpointDegrees(draft, inEdges, outEdges, issues) {
    const inputs = draft.nodes.filter(node => node.kind === 'input');
    const outputs = draft.nodes.filter(node => node.kind === 'output');
    if (inputs.length !== 1) {
        issues.push({ code: 'input-count', message: `expected exactly one input node, found ${inputs.length}` });
    }
    if (outputs.length === 0) {
        issues.push({ code: 'output-count', message: 'workflow needs at least one output node' });
    }
    for (const node of inputs) {
        if ((inEdges.get(node.id) ?? []).length > 0) {
            issues.push({ code: 'input-indegree', message: `input node '${node.id}' must not have incoming edges`, nodeId: node.id });
        }
    }
    for (const node of outputs) {
        if ((outEdges.get(node.id) ?? []).length > 0) {
            issues.push({ code: 'output-outdegree', message: `output node '${node.id}' must not have outgoing edges`, nodeId: node.id });
        }
    }
}
function issueRouterCases(draft, outEdges, issues) {
    for (const node of draft.nodes) {
        if (node.kind !== 'router')
            continue;
        if (node.cases.length === 0) {
            issues.push({ code: 'router-cases-empty', message: `router node '${node.id}' declares no cases`, nodeId: node.id });
        }
        const seen = new Set();
        for (const name of node.cases) {
            if (name.trim().length === 0) {
                issues.push({ code: 'router-case-blank', message: `router node '${node.id}' declares a blank case name`, nodeId: node.id, handle: name });
            }
            if (seen.has(name)) {
                issues.push({ code: 'router-case-duplicate', message: `router node '${node.id}' declares case '${name}' more than once`, nodeId: node.id, handle: name });
                continue;
            }
            seen.add(name);
        }
        const wired = new Set((outEdges.get(node.id) ?? []).map(edge => edge.fromHandle));
        for (const name of node.cases) {
            if (!wired.has(name)) {
                issues.push({ code: 'router-case-unwired', message: `router case '${name}' on node '${node.id}' has no outgoing edge`, nodeId: node.id, handle: name });
            }
        }
    }
}
function issueLoops(draft, inEdges, outEdges, issues) {
    for (const node of draft.nodes) {
        if (node.kind !== 'loop')
            continue;
        const out = outEdges.get(node.id) ?? [];
        const handles = new Set(out.map(edge => edge.fromHandle));
        if (!handles.has('iterate')) {
            issues.push({ code: 'loop-handle-missing', message: `loop node '${node.id}' lacks an 'iterate' out-edge`, nodeId: node.id, handle: 'iterate' });
        }
        if (!handles.has('done')) {
            issues.push({ code: 'loop-handle-missing', message: `loop node '${node.id}' lacks a 'done' out-edge`, nodeId: node.id, handle: 'done' });
        }
        const back = (inEdges.get(node.id) ?? []).filter(edge => edge.toHandle === 'back');
        if (back.length === 0) {
            issues.push({ code: 'loop-handle-missing', message: `loop node '${node.id}' has no 'back' in-edge from its body`, nodeId: node.id, handle: 'back' });
        }
        if (node.mode === 'items' && (node.itemsExpr ?? '').trim().length === 0) {
            issues.push({ code: 'loop-params', message: `loop node '${node.id}' in items mode requires itemsExpr`, nodeId: node.id });
        }
        if (node.mode === 'count' && node.count === undefined) {
            issues.push({ code: 'loop-params', message: `loop node '${node.id}' in count mode requires count`, nodeId: node.id });
        }
        if (node.mode === 'while' && (node.condition ?? '').trim().length === 0) {
            issues.push({ code: 'loop-params', message: `loop node '${node.id}' in while mode requires condition`, nodeId: node.id });
        }
    }
}
function issueJoins(draft, inEdges, issues) {
    for (const node of draft.nodes) {
        if (node.kind !== 'join')
            continue;
        const inDegree = (inEdges.get(node.id) ?? []).length;
        if (inDegree < 2) {
            issues.push({ code: 'join-indegree', message: `join node '${node.id}' needs at least two incoming edges, found ${inDegree}`, nodeId: node.id });
        }
        if (node.strategy === 'quorum') {
            if (node.quorum === undefined || node.quorum < 1 || node.quorum > inDegree) {
                issues.push({ code: 'join-quorum-range', message: `join node '${node.id}' quorum must be between 1 and its in-degree (${inDegree})`, nodeId: node.id });
            }
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
    const indegree = new Map();
    for (const node of draft.nodes) {
        if (node.kind !== 'note')
            indegree.set(node.id, 0);
    }
    for (const [target, edges] of inEdges) {
        if (!indegree.has(target))
            continue;
        for (const edge of edges) {
            if (edge.toHandle !== 'back')
                indegree.set(target, (indegree.get(target) ?? 0) + 1);
        }
    }
    const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
    const order = [];
    while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined)
            break;
        order.push(id);
        for (const edge of outEdges.get(id) ?? []) {
            if (edge.toHandle === 'back')
                continue;
            const next = (indegree.get(edge.to) ?? 0) - 1;
            indegree.set(edge.to, next);
            if (next === 0)
                queue.push(edge.to);
        }
    }
    if (order.length < indegree.size) {
        const stuck = [...indegree].filter(([, degree]) => (degree ?? 0) > 0).map(([id]) => id);
        issues.push({
            code: 'cycle-illegal',
            message: `cycle outside any loop node passes through: ${stuck.join(', ')}; route it through a loop node's back edge`,
        });
    }
}
function issueTemplates(draft, nodeIds, issues) {
    for (const edge of draft.edges) {
        if (edge.template === undefined)
            continue;
        for (const ref of edge.template.matchAll(TEMPLATE_NODE_REF_RE)) {
            const id = ref[1];
            if (id === undefined)
                continue;
            if (!nodeIds.has(id)) {
                issues.push({ code: 'template-node-unknown', message: `edge '${edge.id}' template references unknown node '{{nodes.${id}}}'`, edgeId: edge.id, nodeId: id });
            }
        }
    }
}
//# sourceMappingURL=validation.js.map