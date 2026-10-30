import { defineTool } from '@deepseek-ai/dsh-tools';
/** Model-facing name of the ask-user tool. */
export const HITL_TOOL_NAME = 'agent-multi-ask-user';
const HITL_VALUE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        answer: { type: 'string', required: true },
    },
};
/**
 * Install the ask-user tool on every HITL-enabled run child as it is
 * created. The executor pre-assigns each activation's child session id and
 * records it in `hitlChildren` before starting the activation, so the
 * `agent/created` listener resolves membership without ordering assumptions.
 * @param deps - run-wide installation dependencies.
 * @returns the disposer removing the listener and every tool registration.
 */
export function installHitlTool(deps) {
    const disposers = [];
    const listener = ({ agent }) => {
        if (!deps.hitlChildren.has(agent.id))
            return;
        disposers.push(agent.ctx.tools.register(defineTool({
            name: HITL_TOOL_NAME,
            description: 'Ask the human user one question when the task needs a decision or clarification.',
            parameters: {
                question: { type: 'string', required: true, description: 'The question to ask.' },
                detail: { type: 'string', description: 'Optional context shown under the question.' },
                options: { type: 'array', items: { type: 'string' }, description: 'Optional answer labels to choose from.' },
                multiSelect: { type: 'boolean', description: 'Whether the user may select several options.' },
            },
            output: {
                schema: HITL_VALUE_SCHEMA,
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
            },
            async execute(args, exec) {
                const nodeId = deps.nodeOf.get(agent.id) ?? 'unknown';
                const item = {
                    id: 'agent-multi-hitl',
                    question: args.question,
                    ...(args.detail !== undefined ? { detail: args.detail } : {}),
                    ...(args.options !== undefined && args.options.length > 0
                        ? { options: args.options.map((label) => ({ label })) }
                        : {}),
                    ...(args.multiSelect !== undefined ? { multiSelect: args.multiSelect } : {}),
                };
                await deps.journal.append('agent-multi/hitl-asked', {
                    version: 1, runId: deps.runId, nodeId, question: args.question,
                });
                const answer = await deps.ctx.userQuestions.ask({
                    agent: deps.runRoot,
                    questions: [item],
                    signal: exec.signal,
                });
                const first = answer.answers[0];
                const selected = first === undefined
                    ? ''
                    : [...first.selected, ...(first.custom === undefined ? [] : [first.custom])].join(', ');
                await deps.journal.append('agent-multi/hitl-answered', {
                    version: 1, runId: deps.runId, nodeId, answer: selected,
                });
                return { answer: selected };
            },
        })));
        return undefined;
    };
    const off = deps.ctx.on('agent/created', listener);
    return {
        dispose() {
            off();
            for (const dispose of disposers.splice(0))
                dispose();
        },
    };
}
//# sourceMappingURL=hitl.js.map