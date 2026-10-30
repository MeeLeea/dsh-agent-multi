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
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { RunJournal } from './executor.ts'
import type { RunId } from './events.ts'

/** Model-facing name of the ask-user tool. */
export const HITL_TOOL_NAME = 'agent-multi-ask-user'

const HITL_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: { type: 'string', required: true },
  },
} as const

/** Dependencies for the run-wide ask-user tool installation. */
export interface InstallHitlDeps {
  /** Context providing `userQuestions` and the `agent/created` event stream. */
  readonly ctx: Context
  /** The run root: parent of every child activation and the only agent allowed to ask. */
  readonly runRoot: Agent
  /** Journal receiving `hitl-asked` / `hitl-answered` events. */
  readonly journal: RunJournal
  readonly runId: RunId
  /** Pre-assigned child session ids whose node enables HITL. */
  readonly hitlChildren: ReadonlySet<string>
  /** Child session id to node id, for journal attribution. */
  readonly nodeOf: ReadonlyMap<string, string>
}

/**
 * Install the ask-user tool on every HITL-enabled run child as it is
 * created. The executor pre-assigns each activation's child session id and
 * records it in `hitlChildren` before starting the activation, so the
 * `agent/created` listener resolves membership without ordering assumptions.
 * @param deps - run-wide installation dependencies.
 * @returns the disposer removing the listener and every tool registration.
 */
export function installHitlTool(deps: InstallHitlDeps): { dispose(): void } {
  const disposers: Array<() => void> = []
  const listener = ({ agent }: { agent: Agent }): undefined => {
    if (!deps.hitlChildren.has(agent.id)) return
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
        render: (_args: unknown, value: InferValue<typeof HITL_VALUE_SCHEMA>) =>
          [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const nodeId = deps.nodeOf.get(agent.id) ?? 'unknown'
        const item: AskUserQuestionItem = {
          id: 'agent-multi-hitl',
          question: args.question,
          ...(args.detail !== undefined ? { detail: args.detail } : {}),
          ...(args.options !== undefined && args.options.length > 0
            ? { options: args.options.map((label) => ({ label })) }
            : {}),
          ...(args.multiSelect !== undefined ? { multiSelect: args.multiSelect } : {}),
        }
        await deps.journal.append('agent-multi/hitl-asked', {
          version: 1, runId: deps.runId, nodeId, question: args.question,
        })
        const answer = await deps.ctx.userQuestions.ask({
          agent: deps.runRoot,
          questions: [item],
          signal: exec.signal,
        })
        const first = answer.answers[0]
        const selected = first === undefined
          ? ''
          : [...first.selected, ...(first.custom === undefined ? [] : [first.custom])].join(', ')
        await deps.journal.append('agent-multi/hitl-answered', {
          version: 1, runId: deps.runId, nodeId, answer: selected,
        })
        return { answer: selected }
      },
    })))
    return undefined
  }
  const off = deps.ctx.on('agent/created', listener)
  return {
    dispose(): void {
      off()
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}
