import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { type SessionEventMap } from '@deepseek-ai/dsh-session';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { AgentNodeSpec, EdgeSpec } from '../domain.ts';
import type { AgentMultiErrorClass, NodeUsagePayload, RunId } from './events.ts';
import { type Ledger } from './format.ts';
/** Every agent-multi journal event key. */
export type AgentMultiEventType = Extract<keyof SessionEventMap, `agent-multi/${string}`>;
/** Journal writer bound to the run session; every append is flushed durably. */
export declare class RunJournal {
    private readonly ctx;
    private readonly session;
    constructor(ctx: Context, session: Agent['session']);
    /** Append one event and flush the session to durable storage. */
    append<T extends AgentMultiEventType>(type: T, data: SessionEventMap[T]): Promise<void>;
}
/** Terminal failure of a node after the retry budget was spent. */
export interface NodeExecutionFailure {
    readonly ok: false;
    readonly errorClass: AgentMultiErrorClass;
    readonly message: string;
    readonly attempts: number;
}
/** Successful node execution; `output` becomes the ledger payload. */
export interface NodeExecutionSuccess {
    readonly ok: true;
    readonly output: readonly ContentBlock[];
}
export type NodeExecutionOutcome = NodeExecutionSuccess | NodeExecutionFailure;
/** Dependencies shared by every node execution within one run. */
export interface NodeExecutionDeps {
    readonly ctx: Context;
    readonly runRoot: Agent;
    readonly journal: RunJournal;
    readonly runId: RunId;
    readonly ledger: Ledger;
    readonly userInput: string;
    /** Run-wide cancellation; every attempt signal links to it. */
    readonly signal: AbortSignal;
    /** Child session id to node id, shared with the HITL tool installation. */
    readonly nodeOf: Map<string, string>;
    /** Pre-assigned child session ids whose node enables HITL. */
    readonly hitlChildren: Set<string>;
    /**
     * Run-wide token fuse: called with the node usage after every settled
     * attempt. Throwing aborts the run through the shared signal.
     */
    readonly onNodeUsage?: (usage: NodeUsagePayload) => void;
}
/** Classify a settled subagent result into the retry decision vocabulary. */
export declare function classifyStopReason(result: SubagentResult, timedOut: boolean): AgentMultiErrorClass | 'cancelled';
/**
 * Run one agent node to a terminal outcome: success, exhausted retries, or
 * non-retryable failure. Every attempt is journaled.
 */
export declare function executeAgentNode(deps: NodeExecutionDeps, node: AgentNodeSpec, inEdges: readonly EdgeSpec[]): Promise<NodeExecutionOutcome>;
//# sourceMappingURL=executor.d.ts.map