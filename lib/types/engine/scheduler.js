const TEXT_BLOCK_TYPE = 'text';
function textOf(blocks) {
    return blocks
        .filter((block) => block.type === TEXT_BLOCK_TYPE)
        .map((block) => block.text)
        .join('');
}
export class Scheduler {
    definition;
    nodes;
    outEdges;
    inEdges;
    status = new Map();
    ledger = new Map();
    loopCounts = new Map();
    runOutput;
    constructor(definition) {
        this.definition = definition;
        const nodeMap = new Map();
        for (const node of definition.nodes)
            nodeMap.set(node.id, node);
        this.nodes = nodeMap;
        const outMap = new Map();
        const inMap = new Map();
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
        for (const node of definition.nodes) {
            this.status.set(node.id, { state: 'pending' });
        }
    }
    /** Seed the input node with the run's user input and resolve it. */
    setInput(userInput) {
        const inputNode = this.definition.nodes.find((node) => node.kind === 'input');
        if (inputNode === undefined)
            return;
        this.ledger.set(inputNode.id, [{ type: 'text', text: userInput }]);
        this.status.get(inputNode.id).state = 'succeeded';
        this.settle();
    }
    /** Agent nodes ready to execute after control nodes have settled. */
    readyAgentNodes() {
        this.settle();
        const ready = [];
        for (const [id, status] of this.status) {
            if (status.state !== 'pending')
                continue;
            const node = this.nodes.get(id);
            if (node.kind !== 'agent')
                continue;
            if (this.isReady(id))
                ready.push(node);
        }
        return ready;
    }
    /** Mark an agent node complete with its output and propagate. */
    completeAgent(nodeId, output) {
        if (!this.status.has(nodeId))
            return; // journal replay may name removed nodes
        this.ledger.set(nodeId, output);
        this.status.get(nodeId).state = 'succeeded';
        // A back edge returns control to a running loop.
        for (const edge of this.outEdges.get(nodeId) ?? []) {
            if (edge.toHandle === 'back') {
                this.advanceLoop(edge.to, output);
            }
        }
        this.settle();
    }
    /** Mark an agent node failed; downstream nodes that depend on it cannot run. */
    failAgent(nodeId) {
        if (!this.status.has(nodeId))
            return; // journal replay may name removed nodes
        this.status.get(nodeId).state = 'failed';
    }
    /** The run's final output text once the output node has resolved. */
    getOutput() {
        return this.runOutput;
    }
    /** True when no node is pending or running. */
    isFinished() {
        for (const status of this.status.values()) {
            if (status.state === 'pending' || status.state === 'running')
                return false;
        }
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
                if (status.state !== 'pending')
                    continue;
                const node = this.nodes.get(id);
                // The input node has no in-edges by definition and is always reachable.
                if (node.kind !== 'input' && this.isUnreachable(id)) {
                    status.state = 'skipped';
                    changed = true;
                    continue;
                }
                if (node.kind === 'input' || node.kind === 'agent')
                    continue;
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
            return state === 'ready' || state === 'waiting';
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
        if (live.length === 0)
            return false;
        const readyCount = live.filter((edge) => this.edgeState(edge) === 'ready').length;
        if (node.kind === 'join') {
            if (node.strategy === 'all')
                return readyCount === live.length;
            if (node.strategy === 'any')
                return readyCount >= 1;
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
        if (edge.toHandle === 'back')
            return 'inactive';
        const srcStatus = this.status.get(edge.from);
        if (srcStatus === undefined)
            return 'inactive';
        const srcNode = this.nodes.get(edge.from);
        if (srcNode.kind === 'router') {
            if (srcStatus.state === 'succeeded') {
                return edge.fromHandle === srcStatus.routerCase ? 'ready' : 'inactive';
            }
            return srcStatus.state === 'failed' || srcStatus.state === 'skipped' ? 'inactive' : 'waiting';
        }
        if (srcNode.kind === 'loop') {
            if (srcStatus.state === 'running') {
                // The body edge is live; the `done` edge may still fire when the loop exits.
                if (edge.fromHandle === srcStatus.loopEmit)
                    return 'ready';
                if (edge.fromHandle === 'done')
                    return 'waiting';
                return 'inactive';
            }
            if (srcStatus.state === 'succeeded') {
                return edge.fromHandle === srcStatus.loopEmit ? 'ready' : 'inactive';
            }
            return srcStatus.state === 'failed' || srcStatus.state === 'skipped' ? 'inactive' : 'waiting';
        }
        if (srcStatus.state === 'succeeded')
            return 'ready';
        if (srcStatus.state === 'failed' || srcStatus.state === 'skipped')
            return 'inactive';
        return 'waiting';
    }
    /** Resolve a control node deterministically and store its ledger output. */
    resolveControl(node) {
        switch (node.kind) {
            case 'note':
                this.status.get(node.id).state = 'skipped';
                return;
            case 'router':
                this.resolveRouter(node);
                return;
            case 'join':
                this.resolveJoin(node);
                return;
            case 'loop':
                this.activateLoop(node);
                return;
            case 'output':
                this.resolveOutput(node);
                return;
            case 'input':
            case 'agent':
                return;
            default:
                return;
        }
    }
    resolveRouter(node) {
        const payload = this.mergePredecessorText(node.id);
        let chosen = 'default';
        for (const caseEntry of node.cases) {
            // The case string doubles as the match keyword (case-insensitive substring).
            if (payload.toLowerCase().includes(caseEntry.toLowerCase())) {
                chosen = caseEntry;
                break;
            }
        }
        const status = this.status.get(node.id);
        status.routerCase = chosen;
        status.state = 'succeeded';
        // Router output mirrors the routed predecessor payload so downstream agents see it.
        this.ledger.set(node.id, this.mergePredecessorBlocks(node.id));
    }
    resolveJoin(node) {
        this.ledger.set(node.id, this.mergePredecessorBlocks(node.id));
        this.status.get(node.id).state = 'succeeded';
    }
    activateLoop(node) {
        const status = this.status.get(node.id);
        status.state = 'running';
        status.loopIter = 1;
        status.loopEmit = 'iterate';
        status.loopOutputs = [];
        this.loopCounts.set(node.id, this.loopIterationCount(node));
    }
    advanceLoop(loopId, bodyOutput) {
        const status = this.status.get(loopId);
        if (status === undefined || status.state !== 'running')
            return;
        const node = this.nodes.get(loopId);
        if (node?.kind !== 'loop')
            return;
        if (node.collect) {
            status.loopOutputs?.push(textOf(bodyOutput));
        }
        const count = this.loopCounts.get(loopId) ?? 1;
        const next = (status.loopIter ?? 1) + 1;
        status.loopIter = next;
        if (next <= count) {
            status.loopEmit = 'iterate';
            // Reset the body subgraph so each iteration runs fresh.
            this.resetBody(loopId);
        }
        else {
            status.loopEmit = 'done';
            status.state = 'succeeded';
            const collected = status.loopOutputs?.length ? status.loopOutputs.join('\n\n') : textOf(bodyOutput);
            this.ledger.set(loopId, [{ type: 'text', text: collected }]);
        }
    }
    resolveOutput(node) {
        const text = this.mergePredecessorText(node.id);
        this.ledger.set(node.id, [{ type: 'text', text }]);
        this.status.get(node.id).state = 'succeeded';
        this.runOutput = text;
    }
    /** Reset every node in a loop's body (reachable from `iterate`, excluding the loop) to pending. */
    resetBody(loopId) {
        const iterateEdge = (this.outEdges.get(loopId) ?? []).find((edge) => edge.fromHandle === 'iterate');
        if (iterateEdge === undefined)
            return;
        const body = new Set();
        const stack = [iterateEdge.to];
        while (stack.length > 0) {
            const current = stack.pop();
            if (current === loopId || body.has(current))
                continue;
            body.add(current);
            for (const edge of this.outEdges.get(current) ?? []) {
                stack.push(edge.to);
            }
        }
        for (const id of body) {
            const status = this.status.get(id);
            if (status === undefined)
                continue;
            status.state = 'pending';
            delete status.routerCase;
            delete status.loopEmit;
            delete status.loopIter;
            delete status.loopOutputs;
            this.ledger.delete(id);
        }
    }
    // --- helpers ---
    loopIterationCount(node) {
        if (node.mode === 'count' && node.count !== undefined)
            return Math.min(node.count, node.maxIters);
        // items/while: restricted evaluation is unsupported in v1; run one iteration.
        return 1;
    }
    mergePredecessorText(nodeId) {
        return textOf(this.mergePredecessorBlocks(nodeId));
    }
    mergePredecessorBlocks(nodeId) {
        const parts = [];
        for (const edge of this.inEdges.get(nodeId) ?? []) {
            if (this.edgeState(edge) !== 'ready')
                continue;
            const output = this.ledger.get(edge.from);
            if (output !== undefined)
                parts.push(textOf(output));
        }
        return [{ type: 'text', text: parts.join('\n\n') }];
    }
}
//# sourceMappingURL=scheduler.js.map