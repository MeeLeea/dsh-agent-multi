import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AgentMultiErrorClass, RunId } from './events.ts';
import type { WorkflowDefinition } from '../types.ts';
/** Terminal outcome of one run. */
export interface RunResult {
    readonly outcome: 'completed' | 'failed' | 'cancelled';
    readonly runId: RunId;
    /** The output node's text, present when the run completed. */
    readonly output?: string;
    /** The terminal node failure, present when the run failed. */
    readonly failure?: {
        nodeId: string;
        errorClass: AgentMultiErrorClass;
        message: string;
        attempts: number;
    };
}
export interface ExecuteRunOptions {
    readonly ctx: Context;
    readonly runRoot: Agent;
    readonly definition: WorkflowDefinition;
    readonly userInput: string;
    readonly signal: AbortSignal;
    /** Maximum concurrent node activations; default 8. */
    readonly maxActive?: number;
    /** Replay completed nodes from the run session journal before starting. */
    readonly resume?: boolean;
    /** Caller-assigned run identity; defaults to a fresh random id. */
    readonly runId?: RunId;
    /**
     * Token fuse: a run-wide billed-token budget. When the sum of input,
     * cache-read, and cache-write tokens exceeds it, the run aborts and fails
     * with the `auth`-free deterministic class `token-fuse`.
     */
    readonly tokenBudget?: number;
}
/** Drive one workflow run to a terminal outcome. */
export declare function executeRun(options: ExecuteRunOptions): Promise<RunResult>;
//# sourceMappingURL=run.d.ts.map