/**
 * Pure ready-set graph scheduler for agent-multi runs.
 *
 * The scheduler resolves control nodes (input, router, join, loop, output, note)
 * deterministically and exposes only the agent nodes that are ready to execute.
 * The executor runs agent activations; `completeAgent` feeds the result back and
 * re-settles, which may advance loops, route router branches, or merge joins.
 *
 * Edge states drive readiness:
 * - `ready`: the source succeeded and the edge's handle matches the source's
 *   current emission (router case / loop handle).
 * - `waiting`: the source is still pending or running; the edge may become ready.
 * - `inactive`: the source skipped or failed, the handle can never match, or the
 *   edge is a loop `back` return (handled by advanceLoop instead).
 *
 * A node with only `inactive` in-edges is unreachable and is skipped, cascading
 * forward — so un-taken router branches never block the output, and orphan notes
 * settle as skipped. Joins count only `ready` edges; `all` additionally requires
 * that no `waiting` edge remains.
 *
 * v1 loop support is count-mode: a loop iterates `count` times (capped by
 * `maxIters`), each iteration running the body subgraph reachable from the
 * `iterate` handle and returning via the `back` edge; on exhaustion the loop
 * emits `done`. The body is reset to pending for each iteration. `items`/`while`
 * modes fall back to a single iteration pending restricted expression evaluation.
 *
 * v1 router is deterministic keyword match: the first case whose `label` is a
 * case-insensitive substring of the merged predecessor payload wins; otherwise
 * the `default` branch. LLM-driven routing is a later enhancement.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { WorkflowDefinition, AgentNodeSpec } from '../types.ts';
export declare class Scheduler {
    private readonly definition;
    private readonly nodes;
    private readonly outEdges;
    private readonly inEdges;
    private readonly status;
    private readonly ledger;
    private readonly loopCounts;
    private runOutput;
    constructor(definition: WorkflowDefinition);
    /** Seed the input node with the run's user input and resolve it. */
    setInput(userInput: string): void;
    /** Agent nodes ready to execute after control nodes have settled. */
    readyAgentNodes(): AgentNodeSpec[];
    /** Mark an agent node complete with its output and propagate. */
    completeAgent(nodeId: string, output: readonly ContentBlock[]): void;
    /** Mark an agent node failed; downstream nodes that depend on it cannot run. */
    failAgent(nodeId: string): void;
    /** The run's final output text once the output node has resolved. */
    getOutput(): string | undefined;
    /** True when no node is pending or running. */
    isFinished(): boolean;
    /** Read a node's stored output (engine ledger access). */
    nodeOutput(nodeId: string): readonly ContentBlock[] | undefined;
    /** Snapshot ledger entries for read-only prompt assembly. */
    ledgerSnapshot(): ReadonlyMap<string, readonly ContentBlock[]>;
    /**
     * Resolve control nodes and skip unreachable nodes until a fixed point:
     * control nodes whose dependencies are satisfied resolve deterministically;
     * pending nodes with no potentially-active in-edges are skipped as
     * unreachable, which may cascade further skips downstream.
     */
    private settle;
    /** In-edges that can still carry data (ready or waiting), excluding back returns. */
    private liveInEdges;
    /** A pending non-input node is unreachable when no in-edge can ever fire. */
    private isUnreachable;
    /** Whether a node's live in-edges are all satisfied (join strategy applied). */
    private isReady;
    /**
     * Classify one in-edge against its source's current state. Router edges match
     * the chosen case; loop edges match the emitted handle; plain nodes match any
     * out-edge once succeeded. Skipped or failed sources permanently deactivate
     * their edges; `back` returns are excluded from readiness entirely.
     */
    private edgeState;
    /** Resolve a control node deterministically and store its ledger output. */
    private resolveControl;
    private resolveRouter;
    private resolveJoin;
    private activateLoop;
    private advanceLoop;
    private resolveOutput;
    /** Reset every node in a loop's body (reachable from `iterate`, excluding the loop) to pending. */
    private resetBody;
    private loopIterationCount;
    private mergePredecessorText;
    private mergePredecessorBlocks;
}
//# sourceMappingURL=scheduler.d.ts.map