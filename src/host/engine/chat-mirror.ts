/**
 * Chat mirroring for agent-multi run sessions.
 *
 * A run session never executes a real model turn — the run root is a dormant
 * parent for node activations — so without these events it stays `blank`
 * (hidden from the workspace tree) and reads as an empty conversation. This
 * module projects the run lifecycle onto the standard conversation surface:
 * `turn/start` clears the blank flag, the run input echoes as a user message
 * (which also triggers automatic title generation), and the terminal outcome
 * lands as an assistant message followed by a balancing `turn/end`. The
 * agent-multi journal events are non-surface and never render in the chat
 * view, so the session presents exactly like an ordinary one.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'

/** Model attribution carried by the mirrored terminal assistant message. */
export interface ChatMirrorIdentity {
  readonly provider: string
  readonly model: string
}

/** Terminal close of a mirrored turn, mapped onto a `turn/end` reason. */
export type ChatMirrorClose =
  | { readonly outcome: 'completed', readonly text: string }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'failed', readonly message: string }

/**
 * Open a mirrored turn on the run session.
 * @param ctx - host services (session flush).
 * @param runRoot - the run's dormant root agent.
 * @param input - the run input, echoed as a user message when `echoInput`.
 * @param echoInput - suppress the echo on resume so the chat shows the input once.
 * @returns the opened turn number; pass it to {@link closeRunTurn}.
 */
export async function openRunTurn(ctx: Context, runRoot: Agent, input: string, echoInput: boolean): Promise<number> {
  const session = runRoot.session
  const turn = session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
  session.append('turn/start', { turn })
  if (echoInput) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: input }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  await ctx.sessions.flush(session)
  return turn
}

/**
 * Close a mirrored turn with the run outcome: a terminal assistant message
 * keeps the chat readable, and the `turn/end` balances the turn so the crash
 * repair pass never has to synthesize an `interrupted` closer.
 * @param ctx - host services (session flush).
 * @param runRoot - the run's dormant root agent.
 * @param identity - model attribution for the assistant message.
 * @param turn - the turn number from {@link openRunTurn}.
 * @param close - the run outcome to mirror.
 */
export async function closeRunTurn(
  ctx: Context,
  runRoot: Agent,
  identity: ChatMirrorIdentity,
  turn: number,
  close: ChatMirrorClose,
): Promise<void> {
  const session = runRoot.session
  const text = close.outcome === 'completed' ? close.text
    : close.outcome === 'cancelled' ? '(run cancelled)'
    : `(run failed) ${close.message}`
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: identity.provider, model: identity.model },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('turn/end', {
    turn,
    reason: close.outcome === 'completed' ? { kind: 'completed' }
      : close.outcome === 'cancelled' ? { kind: 'aborted', reason: { kind: 'user' } }
      : { kind: 'error', error: { code: 'UNKNOWN', message: close.message } },
  })
  await ctx.sessions.flush(session)
}
