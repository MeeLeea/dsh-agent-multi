/**
 * Group-chat mirror of node subagent conversations inside the run session.
 *
 * The host appends one `agent-multi/node-message` journal event per node
 * utterance (input prompt and final output/failure) to the run root session.
 * This module registers a Chat conversation Definition that turns those
 * events into labelled chat rows — "节点名：内容" — so opening the run
 * session reads like one group conversation instead of a flat event log.
 */
import { memo } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationNodeContext, ConversationNodeDefinition, ConversationMatch, ConversationMatchResult,
  ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNode, ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import css from './NodeMessageView.module.css'

/** Chat renderer dispatch key for one mirrored node utterance. */
export const NODE_MESSAGE_KIND = 'agent-multi-node'

/** Journal event mirrored from the host for every node utterance. */
export const NODE_MESSAGE_EVENT_TYPE = 'agent-multi/node-message'

/** Renderer payload carried by one mirrored node utterance row. */
export interface AgentMultiNodeChatData {
  /** Node display label rendered ahead of the bubble. */
  readonly label: string
  /** Which side of the node exchange this row mirrors. */
  readonly role: 'input' | 'output'
  /** Mirrored text. */
  readonly text: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'agent-multi-node': AgentMultiNodeChatData
  }
}

/** Decoded shape of the host journal payload (validated loosely: it crosses a plugin boundary). */
interface NodeMessageEventData {
  readonly version: number
  readonly runId: string
  readonly nodeId: string
  readonly nodeLabel: string
  readonly role: 'input' | 'output'
  readonly text: string
}

interface NodeMessageState {
  readonly label: string
  readonly role: 'input' | 'output'
  readonly text: string
  readonly seq: number
}

/** Read and minimally validate one mirrored event payload. */
function eventData(event: unknown): NodeMessageEventData | undefined {
  const data = (event as { readonly data?: unknown }).data
  if (data === null || typeof data !== 'object') return undefined
  const candidate = data as NodeMessageEventData
  if (typeof candidate.nodeId !== 'string' || typeof candidate.text !== 'string') return undefined
  const role = candidate.role === 'output' ? 'output' as const : 'input' as const
  const label = typeof candidate.nodeLabel === 'string' && candidate.nodeLabel !== ''
    ? candidate.nodeLabel
    : candidate.nodeId
  return { version: 1, runId: String(candidate.runId), nodeId: candidate.nodeId, nodeLabel: label, role, text: candidate.text }
}

/**
 * One mirrored node utterance as a Chat row: a small node-name label above a
 * plain-text bubble, group-chat style. Input rows are tinted; output rows
 * show a green edge so failures read differently from prompts.
 */
export const NodeMessageView = memo(function NodeMessageView({ node }: ChatNodeViewProps<typeof NODE_MESSAGE_KIND>) {
  const { label, role, text } = node.data
  return (
    <div className={role === 'input' ? css.rowInput : css.rowOutput} data-agent-multi-role={role}>
      <div className={css.header}>
        <span className={css.label}>{label}</span>
      </div>
      <div className={css.bubble}>
        <div className={css.text}>{text}</div>
      </div>
    </div>
  )
})

/**
 * Conversation business Definition mirroring `agent-multi/node-message`
 * journal events into Chat rows. Every event opens its own Context (one row
 * per utterance), anchored at the event seq so rows interleave in journal
 * order with the run turn's user prompt and summary bubbles.
 */
export const nodeMessageDefinition: ConversationNodeDefinition<NodeMessageState> = {
  kind: NODE_MESSAGE_KIND,
  target: 'chat',
  match(event): ConversationMatchResult | null {
    if ((event as { readonly type: string }).type !== NODE_MESSAGE_EVENT_TYPE) return null
    const data = eventData(event)
    if (data === undefined) return null
    return { id: `${data.runId}:${data.nodeId}:${data.role}:${event.seq}`, role: 'start' }
  },
  start(_context, match: ConversationStartMatch): NodeMessageState {
    const data = eventData(match.event)
    return {
      label: data?.nodeLabel ?? '?',
      role: data?.role ?? 'input',
      text: data?.text ?? '',
      seq: match.event.seq,
    }
  },
  update(context: ConversationNodeContext<NodeMessageState>, _match: ConversationMatch): NodeMessageState {
    return context.state as NodeMessageState
  },
  buildViewNode(context: ConversationNodeContext<NodeMessageState>) {
    const state = context.state
    if (state === undefined) return null
    const node: ChatNode<typeof NODE_MESSAGE_KIND> = {
      key: context.key,
      kind: NODE_MESSAGE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: state.seq,
      location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      groupTree: undefined,
      data: { label: state.label, role: state.role, text: state.text },
    }
    return node
  },
}
