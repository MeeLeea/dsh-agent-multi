/**
 * agent-multi run journal events.
 *
 * Every event is appended to the run Session (the run root's Session) and is the
 * durable record of one run: node lifecycle, intermediate payloads, errors,
 * breakpoints, and human interaction. The client reads these via the agent-multi
 * Session projection (registered in a later phase); the engine keeps its own
 * in-memory ledger for live orchestration and reconstructs it from `node-end`
 * events on restart.
 *
 * Payloads carry a `version` discriminator so future migrations can branch on the
 * stored generation without a wholesale format break.
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
import type { WorkflowId, NodeKind } from '../types.ts';
/** Branded identity of one workflow run. */
export type RunId = Branded<'RunId'>;
/** Why a node failed, mapped from the subagent stop reason and provider diagnostic. */
export type AgentMultiErrorClass = 'transient' | 'timeout' | 'deterministic' | 'auth';
/** Terminal stop reason of a node's subagent activation, mirrored from the subagent seam. */
export type NodeStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal';
/** Restart intent for a paused run. */
export type RunResumeMode = 'resume' | 'resume-edited' | 'discard';
/** Why a run paused. */
export type RunPauseReason = 'breakpoint' | 'hitl' | 'process-restart';
/** How a run ended. */
export type RunOutcome = 'completed' | 'failed' | 'cancelled';
export interface RunStartPayload {
    version: 1;
    runId: RunId;
    workflowId: WorkflowId;
    workflowRevision: number;
    input: string;
}
export interface NodeStartPayload {
    version: 1;
    runId: RunId;
    nodeId: string;
    nodeKind: NodeKind;
    attempt: number;
}
export interface NodeInputPayload {
    version: 1;
    runId: RunId;
    nodeId: string;
    attempt: number;
    /** Assembled prompt text (system prompt + context + user input) delivered to the node. */
    prompt: string;
}
export interface NodeDeltaPayload {
    version: 1;
    runId: RunId;
    nodeId: string;
    attempt: number;
    /** One streaming chunk of assistant output. */
    delta: string;
}
/** Disjoint per-node token accounting, mirrored from the child session's `assistant/message` events. */
export interface NodeUsagePayload {
    /** Uncached input tokens across the node's attempts. */
    inputTokens: number;
    /** Output tokens (reasoning included) across the node's attempts. */
    outputTokens: number;
    /** Cached-input read tokens, when any adapter reported them. */
    cacheReadTokens: number;
    /** Cached-input write tokens, when any adapter reported them. */
    cacheWriteTokens: number;
}
export interface NodeEndPayload {
    version: 1;
    runId: RunId;
    nodeId: string;
    attempt: number;
    /** The node's final assistant output rendered as text. */
    output: string;
    /** The intermediate payload stored in the ledger for downstream nodes. */
    payload: string;
    stopReason: NodeStopReason;
    durationMs: number;
    /** Token accounting over all of the node's model calls, when any reported usage. */
    usage?: NodeUsagePayload;
}
export interface NodeErrorPayload {
    version: 1;
    runId: RunId;
    nodeId: string;
    attempt: number;
    errorClass: AgentMultiErrorClass;
    message: string;
    /** Number of attempts exhausted before this terminal failure. */
    attempts: number;
}
export interface HitlAskedPayload {
    version: 1;
    runId: RunId;
    nodeId: string;
    question: string;
}
export interface HitlAnsweredPayload {
    version: 1;
    runId: RunId;
    nodeId: string;
    answer: string;
}
export interface RunPausedPayload {
    version: 1;
    runId: RunId;
    reason: RunPauseReason;
    /** Node at which the run paused, when applicable. */
    nodeId?: string;
}
export interface RunResumedPayload {
    version: 1;
    runId: RunId;
    mode: RunResumeMode;
}
export interface RunEndPayload {
    version: 1;
    runId: RunId;
    outcome: RunOutcome;
    totalDurationMs: number;
}
export interface RunCancelledPayload {
    version: 1;
    runId: RunId;
}
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'agent-multi/run-start': RunStartPayload;
        'agent-multi/node-start': NodeStartPayload;
        'agent-multi/node-input': NodeInputPayload;
        'agent-multi/node-delta': NodeDeltaPayload;
        'agent-multi/node-end': NodeEndPayload;
        'agent-multi/node-error': NodeErrorPayload;
        'agent-multi/hitl-asked': HitlAskedPayload;
        'agent-multi/hitl-answered': HitlAnsweredPayload;
        'agent-multi/run-paused': RunPausedPayload;
        'agent-multi/run-resumed': RunResumedPayload;
        'agent-multi/run-end': RunEndPayload;
        'agent-multi/run-cancelled': RunCancelledPayload;
    }
}
//# sourceMappingURL=events.d.ts.map