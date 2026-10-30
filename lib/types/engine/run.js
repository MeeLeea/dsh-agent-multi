/**
 * Run orchestration for agent-multi: drives the ready-set scheduler to
 * completion, journals the run lifecycle to the run session, caps concurrent
 * node activations, and stops at a breakpoint on terminal node failure.
 *
 * The run root agent parents every node activation; the run session journal
 * is the durable record. `resume` replays `node-end` events from the session
 * to skip already-completed nodes before driving the remaining graph.
 */
import { randomUUID } from 'node:crypto';
import { brandString } from '@deepseek-ai/dsh-brand';
import { executeAgentNode, RunJournal } from "./executor.js";
import { installHitlTool } from "./hitl.js";
import { Scheduler } from "./scheduler.js";
/** Drive one workflow run to a terminal outcome. */
export async function executeRun(options) {
    const { ctx, runRoot, definition, userInput, signal } = options;
    const maxActive = options.maxActive ?? 8;
    const runId = options.runId ?? brandString(randomUUID());
    const journal = new RunJournal(ctx, runRoot.session);
    const scheduler = new Scheduler(definition);
    scheduler.setInput(userInput);
    if (options.resume === true) {
        replayJournal(scheduler, runRoot);
    }
    await journal.append('agent-multi/run-start', {
        version: 1, runId, workflowId: definition.id, workflowRevision: definition.revision, input: userInput,
    });
    if (options.resume === true) {
        await journal.append('agent-multi/run-resumed', { version: 1, runId, mode: 'resume' });
    }
    const startedAt = Date.now();
    const inFlight = new Map();
    let failure;
    let failureNodeId;
    const nodeOf = new Map();
    const hitlChildren = new Set();
    const hitl = installHitlTool({ ctx, runRoot, journal, runId, nodeOf, hitlChildren });
    const fuse = createTokenFuse(options.tokenBudget);
    fuse.arm();
    const launch = (nodeId) => {
        const node = definition.nodes.find((candidate) => candidate.id === nodeId);
        if (node === undefined || node.kind !== 'agent')
            return;
        const inEdges = definition.edges.filter((edge) => edge.to === nodeId && edge.toHandle !== 'back');
        const execution = executeAgentNode({
            ctx, runRoot, journal, runId,
            ledger: scheduler.ledgerSnapshot(),
            userInput, signal, nodeOf, hitlChildren,
            ...(fuse.consume !== undefined ? { onNodeUsage: fuse.consume } : {}),
        }, node, inEdges).then(outcome => {
            if (outcome.ok) {
                scheduler.completeAgent(nodeId, outcome.output);
            }
            else {
                scheduler.failAgent(nodeId);
                failure = outcome;
                failureNodeId = nodeId;
            }
        });
        inFlight.set(nodeId, execution.finally(() => inFlight.delete(nodeId)));
    };
    try {
        while (failure === undefined && !signal.aborted && !fuse.tripped()) {
            for (const node of scheduler.readyAgentNodes()) {
                if (inFlight.has(node.id))
                    continue;
                if (inFlight.size >= maxActive)
                    break;
                launch(node.id);
            }
            if (inFlight.size === 0)
                break;
            await Promise.race(inFlight.values());
        }
        // Let already-running nodes settle so their journals stay consistent.
        while (inFlight.size > 0) {
            await Promise.race(inFlight.values());
        }
    }
    finally {
        hitl.dispose();
        fuse.disarm();
    }
    if (fuse.tripped()) {
        await journal.append('agent-multi/run-paused', {
            version: 1, runId, reason: 'breakpoint',
            ...(failureNodeId !== undefined ? { nodeId: failureNodeId } : {}),
        });
        await journal.append('agent-multi/run-end', {
            version: 1, runId, outcome: 'failed', totalDurationMs: Date.now() - startedAt,
        });
        return {
            outcome: 'failed', runId,
            failure: {
                nodeId: failureNodeId ?? '(run)',
                errorClass: 'deterministic',
                message: `token budget exceeded: ${fuse.consumed()} billed input+output tokens over a limit of ${fuse.budget()}`,
                attempts: 1,
            },
        };
    }
    if (signal.aborted) {
        await journal.append('agent-multi/run-cancelled', { version: 1, runId });
        await journal.append('agent-multi/run-end', {
            version: 1, runId, outcome: 'cancelled', totalDurationMs: Date.now() - startedAt,
        });
        return { outcome: 'cancelled', runId };
    }
    if (failure !== undefined && failureNodeId !== undefined) {
        await journal.append('agent-multi/run-paused', {
            version: 1, runId, reason: 'breakpoint', nodeId: failureNodeId,
        });
        await journal.append('agent-multi/run-end', {
            version: 1, runId, outcome: 'failed', totalDurationMs: Date.now() - startedAt,
        });
        return {
            outcome: 'failed', runId,
            failure: { nodeId: failureNodeId, errorClass: failure.errorClass, message: failure.message, attempts: failure.attempts },
        };
    }
    await journal.append('agent-multi/run-end', {
        version: 1, runId, outcome: 'completed', totalDurationMs: Date.now() - startedAt,
    });
    const output = scheduler.getOutput();
    if (output === undefined)
        return { outcome: 'completed', runId };
    return { outcome: 'completed', runId, output };
}
/**
 * Seed the scheduler with completed nodes from the run session journal so a
 * resumed run skips them. Only `node-end` events are replayed; failed nodes
 * (no `node-end`) re-run from scratch.
 */
function replayJournal(scheduler, runRoot) {
    for (const event of runRoot.session.snapshotEvents()) {
        if (event.type !== 'agent-multi/node-end')
            continue;
        const data = event.data;
        scheduler.completeAgent(data.nodeId, [{ type: 'text', text: data.output }]);
    }
}
/**
 * Run-wide token fuse: sums billed tokens (uncached input + cache reads +
 * cache writes + output) across every settled attempt and trips when the
 * total crosses the budget. `consume` is absent when no budget is set, so
 * the executor pays no observation cost on unbudgeted runs.
 */
function createTokenFuse(budget) {
    if (budget === undefined) {
        return { arm: () => { }, disarm: () => { }, tripped: () => false, consumed: () => 0, budget: () => undefined, consume: undefined };
    }
    let total = 0;
    let armed = false;
    let tripped = false;
    return {
        arm: () => { armed = true; },
        disarm: () => { armed = false; },
        tripped: () => tripped,
        consumed: () => total,
        budget: () => budget,
        consume: (usage) => {
            total += usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
            if (armed && !tripped && total > budget)
                tripped = true;
        },
    };
}
//# sourceMappingURL=run.js.map