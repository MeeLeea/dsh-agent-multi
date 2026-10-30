/**
 * Human-in-the-loop relay for agent-multi runs.
 *
 * The ask-user tool is installed per run child on the child's own scoped
 * layer; installation itself is the gate. A node without `hitlEnabled`
 * never sees the tool, and no tool restriction has to name it: restrictions
 * only cover inherited names, while a scope's own registrations are exempt.
 * Every question is relayed through the run root — the only agent allowed
 * to ask (a child asking directly fails with DELEGATED_CALLER).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { RunJournal } from './executor.ts';
import type { RunId } from './events.ts';
/** Model-facing name of the ask-user tool. */
export declare const HITL_TOOL_NAME = "agent-multi-ask-user";
/** Dependencies for the run-wide ask-user tool installation. */
export interface InstallHitlDeps {
    /** Context providing `userQuestions` and the `agent/created` event stream. */
    readonly ctx: Context;
    /** The run root: parent of every child activation and the only agent allowed to ask. */
    readonly runRoot: Agent;
    /** Journal receiving `hitl-asked` / `hitl-answered` events. */
    readonly journal: RunJournal;
    readonly runId: RunId;
    /** Pre-assigned child session ids whose node enables HITL. */
    readonly hitlChildren: ReadonlySet<string>;
    /** Child session id to node id, for journal attribution. */
    readonly nodeOf: ReadonlyMap<string, string>;
}
/**
 * Install the ask-user tool on every HITL-enabled run child as it is
 * created. The executor pre-assigns each activation's child session id and
 * records it in `hitlChildren` before starting the activation, so the
 * `agent/created` listener resolves membership without ordering assumptions.
 * @param deps - run-wide installation dependencies.
 * @returns the disposer removing the listener and every tool registration.
 */
export declare function installHitlTool(deps: InstallHitlDeps): {
    dispose(): void;
};
//# sourceMappingURL=hitl.d.ts.map