/**
 * agent-multi run state projected incrementally from the run Session's
 * agent-multi journal events. One run Session belongs to exactly one run
 * (resume reuses both), so the state holds at most one run; the wire view is
 * the kanban/canvas shape: per-node status, streaming output, HITL state,
 * and the terminal failure derived from node errors.
 */
import { z } from 'zod';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { NodeKind, WorkflowId } from './types.ts';
import { type AgentMultiErrorClass, type NodeStopReason, type NodeUsagePayload } from './engine/events.ts';
/** Per-node status within one run, as the kanban and canvas rings consume it. */
export type NodeViewStatus = 'running' | 'completed' | 'failed';
/** One node's projected lifecycle inside its run. */
export interface NodeView {
    readonly nodeId: string;
    readonly nodeKind: NodeKind;
    status: NodeViewStatus;
    /** Latest attempt number seen for the node. */
    attempt: number;
    /** Fully-assembled prompt of the latest attempt. */
    prompt?: string;
    /** Accumulated streaming preview while running; replaced by `output` on end. */
    streaming?: string;
    output?: string;
    payload?: string;
    stopReason?: NodeStopReason;
    errorClass?: AgentMultiErrorClass;
    message?: string;
    /** Terminal attempt count reported by the node-error that ended the node. */
    attempts?: number;
    durationMs?: number;
    /** Token accounting over the node's model calls, when any reported usage. */
    usage?: NodeUsagePayload;
}
/** Human-interaction state of one run. */
export interface HitlView {
    readonly nodeId: string;
    readonly question: string;
    answer?: string;
}
/** Run status as the client sees it. */
export type RunViewStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
/** The run's journal-derived state once its run-start has been applied. */
export interface RunState {
    readonly runId: string;
    readonly workflowId: WorkflowId;
    readonly workflowRevision: number;
    readonly input: string;
    status: RunViewStatus;
    nodes: Record<string, NodeView>;
    hitl?: HitlView;
    pauseReason?: 'breakpoint' | 'hitl' | 'process-restart';
    totalDurationMs?: number;
}
/** Projected state of the Session; `run` is absent until the first run-start. */
export interface AgentMultiProjectionState {
    readonly run?: RunState;
    readonly failure?: string;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        agentMulti: AgentMultiProjectionState;
    }
}
/** Wire view of a started run. */
export interface RunStartedView {
    readonly started: true;
    readonly runId: string;
    readonly workflowId: WorkflowId;
    readonly status: RunViewStatus;
    readonly nodes: readonly NodeView[];
    readonly hitl?: HitlView;
    readonly totalDurationMs?: number;
}
/** Wire view before any run event arrived on the Session. */
export interface RunIdleView {
    readonly started: false;
}
/** Wire view of the run for the Web client's run panel and canvas. */
export type AgentMultiRunView = RunStartedView | RunIdleView;
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        /** Run kanban view of the agent-multi run owned by the projected Session. */
        agentMulti: AgentMultiRunView;
    }
}
/** Every agent-multi journal event key. */
export type AgentMultiEventType = 'agent-multi/run-start' | 'agent-multi/node-start' | 'agent-multi/node-input' | 'agent-multi/node-delta' | 'agent-multi/node-end' | 'agent-multi/node-error' | 'agent-multi/hitl-asked' | 'agent-multi/hitl-answered' | 'agent-multi/run-paused' | 'agent-multi/run-resumed' | 'agent-multi/run-end' | 'agent-multi/run-cancelled';
type AgentMultiSessionEvent = SessionEvent<AgentMultiEventType>;
/**
 * Test whether a Session event belongs to the agent-multi domain.
 * @param event - candidate Session event.
 * @returns whether the event has an agent-multi-owned type.
 */
export declare function isAgentMultiEvent(event: SessionEvent): event is AgentMultiSessionEvent;
declare function applyProjectionEvent(state: AgentMultiProjectionState, event: SessionEvent): AgentMultiProjectionState;
/**
 * Wire view of the projected run. The same state reference reuses the same
 * view reference, so unchanged state publishes nothing; a projection failure
 * also keeps the last derived view.
 * @param state - current projection state.
 * @returns the run kanban view.
 */
declare function runView(state: AgentMultiProjectionState): AgentMultiRunView;
/** agent-multi run projection; the run Session owns exactly one run. */
export declare const agentMultiProjectionDefinition: {
    key: "agentMulti";
    stateVersion: number;
    stateSchema: z.ZodType<AgentMultiProjectionState, unknown, z.core.$ZodTypeInternals<AgentMultiProjectionState, unknown>>;
    init: () => AgentMultiProjectionState;
    apply: typeof applyProjectionEvent;
    wire: {
        viewSchema: z.ZodType<AgentMultiRunView, unknown, z.core.$ZodTypeInternals<AgentMultiRunView, unknown>>;
        view: typeof runView;
    };
};
export {};
//# sourceMappingURL=projection.d.ts.map