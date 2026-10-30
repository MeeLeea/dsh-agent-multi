/**
 * The run panel: starts a workflow run on user input, then observes the
 * agent-multi journal — status, per-node events, final output, and the
 * terminal failure with resume/cancel controls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Background, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Button, IconChevronLeftOutlineRegular, IconRefreshOutlineRegular, IconStopFillRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  RunHitlView, RunNodeView, RunStatus, RunSummary, RunView, WorkflowDefinition, WorkflowId,
  AgentMultiErrorClass, AgentMultiJsonValue, TriggerEntry, TriggerTiming,
} from '@deepseek-ai/dsh-experimental-agent-multi/types'
import type { AgentMultiInjected } from './WorkflowPage.tsx'
import type { AgentMultiKey } from './locales.ts'
import css from './WorkflowEditor.module.css'

/** The run target: which stored workflow to execute. */
export interface RunTarget {
  readonly workflowId: WorkflowId
  readonly name: string
}

const POLL_INTERVAL_MS = 1000

const ERROR_CLASS_LABEL: Record<AgentMultiErrorClass, AgentMultiKey> = {
  transient: 'errorClassTransient',
  timeout: 'errorClassTimeout',
  deterministic: 'errorClassDeterministic',
  auth: 'errorClassAuth',
}

/**
 * Render the run launcher and live run observation for one workflow.
 * @param props - target workflow, framework copy, injected actions, and exit callback.
 * @returns the run panel.
 */
export function RunPanel(props: {
  readonly target: RunTarget
  readonly actions: PropsRuntime<'main'> & AgentMultiInjected & PropsLocale<'agent-multi'>
  readonly onExit: () => void
}) {
  const { target, actions, onExit } = props
  const { startRun, resumeRun, cancelRun, getRun, listRuns, t } = actions
  const [input, setInput] = useState('')
  const [run, setRun] = useState<RunView | null>(null)
  const [history, setHistory] = useState<readonly RunSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null)
  const refreshRef = useRef<(runId: string) => Promise<void>>()

  useEffect(() => {
    let cancelled = false
    void actions.getWorkflow({ id: target.workflowId }).then(result => {
      if (cancelled) return
      if (result.ok && result.value.outcome === 'found') setDefinition(result.value.definition)
    })
    return () => { cancelled = true }
  }, [actions, target.workflowId])

  const refresh = useCallback(async (runId: string) => {
    const result = await getRun({ runId })
    if (result.ok && result.value.outcome === 'found') setRun(result.value.run)
  }, [getRun])
  refreshRef.current = refresh

  const refreshHistory = useCallback(async () => {
    const result = await listRuns({ workflowId: target.workflowId })
    if (result.ok) setHistory(result.value.runs)
  }, [listRuns, target.workflowId])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  useEffect(() => {
    if (run === null || run.status !== 'running') {
      void refreshHistory()
      return
    }
    const timer = setTimeout(() => { void refreshRef.current?.(run.runId) }, POLL_INTERVAL_MS)
    return () => { clearTimeout(timer) }
  }, [run, refreshHistory])

  const onStart = useCallback(async () => {
    if (input.trim() === '' || busy) return
    setBusy(true)
    try {
      const result = await startRun({ workflowId: target.workflowId, input })
      if (!result.ok) { setError(t('runMissing')); return }
      const value = result.value
      if (value.outcome === 'started') {
        setError(null)
        await refresh(value.runId)
      } else {
        setError(t('runMissing'))
      }
    } finally {
      setBusy(false)
    }
  }, [input, busy, startRun, target.workflowId, refresh, t])

  const onResume = useCallback(async () => {
    if (run === null || busy) return
    setBusy(true)
    try {
      const result = await resumeRun({ runId: run.runId })
      if (!result.ok) { setError(t('runMissing')); return }
      const value = result.value
      if (value.outcome === 'started' || value.outcome === 'running') await refresh(run.runId)
      else setError(t('runMissing'))
    } finally {
      setBusy(false)
    }
  }, [run, busy, resumeRun, refresh, t])

  const onCancel = useCallback(async () => {
    if (run === null || busy) return
    setBusy(true)
    try {
      await cancelRun({ runId: run.runId })
      await refresh(run.runId)
    } finally {
      setBusy(false)
    }
  }, [run, busy, cancelRun, refresh])

  const statusLabel = (status: RunStatus): string => status === 'running' ? t('statusRunning')
    : status === 'completed' ? t('statusCompleted')
      : status === 'failed' ? t('statusFailed')
        : t('statusCancelled')

  return <section className={css.page}>
    <header className={css.header}>
      <Button onClick={onExit}><IconChevronLeftOutlineRegular size={14} />{t('back')}</Button>
      <h2 className={css.title}>{target.name}</h2>
      {run !== null && <span className={css.runStatus}>{statusLabel(run.status)}</span>}
      {run !== null && <Button onClick={() => { void refreshRef.current?.(run.runId) }}><IconRefreshOutlineRegular size={14} />{t('runRefresh')}</Button>}
      {run?.status === 'running' && <Button onClick={() => { void onCancel() }}><IconStopFillRegular size={14} />{t('runCancel')}</Button>}
      {run?.status === 'failed' && <Button variant='primary' onClick={() => { void onResume() }}>{t('runRetryHint')}</Button>}
    </header>
    {error !== null && <p className={css.error}>{error}</p>}
    <TriggerPanel workflowId={target.workflowId} actions={actions} />
    {run === null
      ? <div className={css.runBar}>
        <textarea className={css.runInput} rows={3} value={input} placeholder={t('runInput')}
          onChange={event => { setInput(event.target.value) }} />
        <Button variant='primary' disabled={busy} onClick={() => { void onStart() }}>{t('runStart')}</Button>
      </div>
      : <div className={css.runBody}>
        {run.nodes.length > 0 && <div className={css.runNodes}>
          {run.nodes.map(node => <NodeCard key={node.nodeId} node={node} t={t} />)}
        </div>}
        {definition !== null && run.nodes.length > 0 && <div className={css.runCanvas}>
          <RunCanvas definition={definition} nodes={run.nodes} {...(run.hitl !== undefined ? { hitlNodeId: run.hitl.nodeId } : {})} />
        </div>}
        {run.hitl !== undefined && <HitlCard hitl={run.hitl} t={t} />}
        {run.output !== undefined && <div className={css.runOutput}>{run.output}</div>}
        {run.failure !== undefined && <div className={css.runFailure}>
          {t('runFailure')}: {run.failure.nodeId} · {t(ERROR_CLASS_LABEL[run.failure.errorClass])} · {run.failure.message} · {run.failure.attempts}
        </div>}
        <p className={css.sectionTitle}>{t('runEvents')}</p>
        <div className={css.runEvents}>
          {run.events.map((event, index) => <div key={index} className={css.eventRow}>
            {event.type.replace('agent-multi/', '')}
            {eventText(event.data)}
          </div>)}
        </div>
        {history.length > 0 && <div className={css.runNodes}>
          <p className={css.sectionTitle}>{t('runHistory')}</p>
          {history.map(summary => <button
            key={summary.runId}
            type='button'
            className={`${css.nodeCard} ${summary.status === 'failed' ? css.nodeCardFailed : css.nodeCardCompleted}`}
            onClick={() => { void refresh(summary.runId) }}
          >
            <span className={css.nodeMeta}>
              {statusLabel(summary.status)} · {summary.runId.slice(0, 8)}
              {summary.failure !== undefined ? ` · ${t(ERROR_CLASS_LABEL[summary.failure.errorClass])}` : ''}
            </span>
          </button>)}
        </div>}
      </div>}
  </section>
}

/** One kanban card: node identity, live status, output preview, usage, failure. */
function NodeCard(props: { readonly node: RunNodeView, readonly t: (key: AgentMultiKey) => string }) {
  const { node, t } = props
  const statusClass = node.status === 'running' ? css.nodeCardRunning
    : node.status === 'completed' ? css.nodeCardCompleted : css.nodeCardFailed
  const statusLabel = node.status === 'running' ? t('nodeRunning')
    : node.status === 'completed' ? t('nodeCompleted') : t('nodeFailed')
  const meta: string[] = [`${node.nodeKind} · ${statusLabel} · #${node.attempt}`]
  if (node.durationMs !== undefined) meta.push(`${node.durationMs}ms`)
  if (node.usage !== undefined) {
    meta.push(`tokens ${node.usage.inputTokens + node.usage.outputTokens} (${node.usage.inputTokens} in / ${node.usage.outputTokens} out)`)
  }
  if (node.errorClass !== undefined && node.errorClass in ERROR_CLASS_LABEL) {
    meta.push(t(ERROR_CLASS_LABEL[node.errorClass]))
  }
  if (node.attempts !== undefined && node.status === 'failed') meta.push(`${node.attempts} ${t('runAttempts')}`)
  const preview = node.status === 'running' ? node.streaming : node.output
  return <div className={`${css.nodeCard} ${statusClass}`}>
    <div className={css.nodeHead}>
      <span className={css.nodeName}>{node.nodeId}</span>
      <span className={css.nodeStatus}>{statusLabel}</span>
    </div>
    <span className={css.nodeMeta}>{meta.join(' · ')}</span>
    {node.message !== undefined && <div className={css.nodeOutput}>{node.message}</div>}
    {preview !== undefined && preview !== '' && <div className={css.nodeOutput}>{preview}</div>}
  </div>
}

/** HITL card: the open question awaiting an answer, or the recorded answer. */
function HitlCard(props: { readonly hitl: RunHitlView, readonly t: (key: AgentMultiKey) => string }) {
  const { hitl, t } = props
  return <div className={css.hitlCard}>
    <span className={css.hitlQuestion}>{t('hitlOpen')} · {hitl.nodeId}</span>
    <span>{hitl.question}</span>
    {hitl.answer !== undefined
      ? <span className={css.hitlAnswer}>{t('hitlAnswered')}: {hitl.answer}</span>
      : null}
  </div>
}

/** Short one-line summary of one journal event payload. */
function eventText(data: AgentMultiJsonValue): string {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return ''
  const summary: string[] = []
  const record: Record<string, AgentMultiJsonValue> = data
  for (const key of ['nodeId', 'nodeKind', 'attempt', 'errorClass', 'message', 'reason', 'mode', 'outcome', 'stopReason', 'answer', 'question', 'durationMs', 'prompt', 'delta', 'output', 'payload']) {
    if (key in record) {
      const value = record[key]
      if (value === undefined || value === null) continue
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      summary.push(`${key}=${truncate(text)}`)
    }
  }
  return summary.join(' ')
}

function truncate(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized
}

/** One status-ring canvas card mirroring the editor card shape. */
function RunCanvasCard({ data }: NodeProps<RunCanvasFlowNode>) {
  const { spec, state } = data
  return <div className={`${css.card} ${css[spec.kind]} ${state === undefined ? '' : css[`ring${state}`]}`}>
    {spec.kind !== 'note' && <Handle type='target' position={Position.Left} id='in' />}
    <span className={css.cardGlyph}>{spec.name}</span>
  </div>
}

type RunCanvasFlowNode = Node<{ spec: WorkflowDefinition['nodes'][number], state?: 'running' | 'completed' | 'failed' }>

const runCanvasNodeTypes = { agentMulti: RunCanvasCard }

/** Read-only mini canvas: workflow graph with a status ring per live node. */
function RunCanvas(props: {
  readonly definition: WorkflowDefinition
  readonly nodes: readonly RunNodeView[]
  readonly hitlNodeId?: string
}) {  const { definition, nodes, hitlNodeId } = props

  const flow = useMemo(() => {
    const stateOf = new Map<string, 'running' | 'completed' | 'failed'>(nodes.map(node => [node.nodeId, node.status]))
    const flowNodes: RunCanvasFlowNode[] = definition.nodes.map(spec => {
      const state = stateOf.get(spec.id)
      return {
        id: spec.id,
        type: 'agentMulti',
        position: spec.position ?? { x: 0, y: 0 },
        data: { spec, ...(state === undefined ? {} : { state }) },
      }
    })
    const flowEdges: Edge[] = definition.edges.map(edge => ({
      id: edge.id, source: edge.from, target: edge.to,
      sourceHandle: edge.fromHandle ?? 'out',
      ...(edge.toHandle === undefined ? {} : { targetHandle: edge.toHandle }),
      markerEnd: { type: MarkerType.ArrowClosed },
    }))
    return { flowNodes, flowEdges }
  }, [definition, nodes, hitlNodeId])
  return <ReactFlow nodes={flow.flowNodes} edges={flow.flowEdges} nodeTypes={runCanvasNodeTypes} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}>
    <Background />
  </ReactFlow>
}

type TimingKind = 'cron' | 'daily' | 'weekly'

/** Workflow-scoped scheduled triggers: list plus create/enable/delete form. */
function TriggerPanel(props: {
  readonly workflowId: WorkflowId
  readonly actions: PropsRuntime<'main'> & AgentMultiInjected & PropsLocale<'agent-multi'>
}) {
  const { workflowId, actions } = props
  const { createTrigger, setTriggerEnabled, deleteTrigger, listTriggers, t } = actions
  const [triggers, setTriggers] = useState<readonly TriggerEntry[] | null>(null)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<TimingKind>('cron')
  const [expression, setExpression] = useState('')
  const [time, setTime] = useState('09:00:00')
  const [weekdays, setWeekdays] = useState('1')
  const [timeZone, setTimeZone] = useState('')
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const result = await listTriggers({ workflowId })
    if (result.ok) setTriggers(result.value.triggers)
  }, [listTriggers, workflowId])

  useEffect(() => { void refresh() }, [refresh])

  const onCreate = useCallback(async () => {
    if (busy) return
    const trimmedZone = timeZone.trim()
    const timing: TriggerTiming = kind === 'cron'
      ? { kind: 'cron', expression: expression.trim(), timeZone: trimmedZone === '' ? 'UTC' : trimmedZone }
      : kind === 'daily'
        ? { kind: 'daily', time, timeZone: trimmedZone === '' ? 'UTC' : trimmedZone }
        : { kind: 'weekly', time, timeZone: trimmedZone === '' ? 'UTC' : trimmedZone, weekdays: weekdays.split(',').map(part => Number.parseInt(part.trim(), 10)).filter(day => day >= 1 && day <= 7) }
    setBusy(true)
    try {
      const result = await createTrigger({ workflowId, timing, input })
      if (!result.ok || result.value.outcome !== 'created') {
        setError(t('triggerCreateFailed'))
        return
      }
      setError(null)
      setOpen(false)
      setInput('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [busy, kind, expression, time, weekdays, timeZone, input, createTrigger, workflowId, refresh, t])

  const onToggle = useCallback(async (entry: TriggerEntry, enabled: boolean) => {
    await setTriggerEnabled({ id: entry.id, enabled })
    await refresh()
  }, [setTriggerEnabled, refresh])

  const onDelete = useCallback(async (entry: TriggerEntry) => {
    if (!window.confirm(t('deleteConfirm'))) return
    await deleteTrigger({ id: entry.id })
    await refresh()
  }, [deleteTrigger, refresh, t])

  const timingLabel = (timing: TriggerTiming): string => timing.kind === 'cron'
    ? `${timing.expression} (${timing.timeZone})`
    : timing.kind === 'daily'
      ? `${t('timingDaily')} ${timing.time} (${timing.timeZone})`
      : `${t('timingWeekly')} ${timing.weekdays.join(',')} ${timing.time} (${timing.timeZone})`

  return <div className={css.triggerPanel}>
    <p className={css.sectionTitle}>{t('triggersTitle')}</p>
    {triggers === null
      ? <span className={css.triggerMeta}>{t('triggersEmpty')}</span>
      : triggers.length === 0
        ? <span className={css.triggerMeta}>{t('triggersEmpty')}</span>
        : triggers.map(entry => <div key={entry.id} className={css.triggerRow}>
          <span className={css.triggerTiming}>{timingLabel(entry.timing)}</span>
          <span className={css.triggerMeta}>
            {entry.enabled ? t('triggerEnabled') : t('triggerDisabled')}
            {` · ${t('triggerNext')} ${entry.scheduledAt}`}
            {entry.lastRunId !== undefined ? ` · ${t('triggerLastRun')} ${entry.lastRunId.slice(0, 8)}` : ''}
          </span>
          <span className={css.rowActions}>
            <Button onClick={() => { void onToggle(entry, !entry.enabled) }}>{entry.enabled ? t('triggerDisabled') : t('triggerEnabled')}</Button>
            <Button onClick={() => { void onDelete(entry) }}>{t('triggerDelete')}</Button>
          </span>
        </div>)}
    {error !== null && <p className={css.error}>{error}</p>}
    {!open
      ? <Button onClick={() => { setOpen(true) }}>{t('triggerCreate')}</Button>
      : <div className={css.triggerForm}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('triggerTimingKind')}</span>
          <select className={css.select} value={kind} onChange={event => { setKind(event.target.value as TimingKind) }}>
            <option value='cron'>{t('timingCron')}</option>
            <option value='daily'>{t('timingDaily')}</option>
            <option value='weekly'>{t('timingWeekly')}</option>
          </select>
        </label>
        {kind === 'cron' && <label className={css.field}>
          <span className={css.fieldLabel}>{t('triggerCron')}</span>
          <input className={css.input} value={expression} placeholder='*/10 * * * *'
            onChange={event => { setExpression(event.target.value) }} />
        </label>}
        {(kind === 'daily' || kind === 'weekly') && <label className={css.field}>
          <span className={css.fieldLabel}>{kind === 'daily' ? t('triggerDailyTime') : t('triggerWeeklyTime')}</span>
          <input className={css.input} value={time} placeholder='09:00:00'
            onChange={event => { setTime(event.target.value) }} />
        </label>}
        {kind === 'weekly' && <label className={css.field}>
          <span className={css.fieldLabel}>{t('triggerWeekdays')}</span>
          <input className={css.input} value={weekdays} placeholder='1,3,5'
            onChange={event => { setWeekdays(event.target.value) }} />
        </label>}
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('triggerTimeZone')}</span>
          <input className={css.input} value={timeZone} placeholder='UTC'
            onChange={event => { setTimeZone(event.target.value) }} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('triggerInput')}</span>
          <textarea className={css.textarea} rows={2} value={input}
            onChange={event => { setInput(event.target.value) }} />
        </label>
        <span className={css.rowActions}>
          <Button onClick={() => { setOpen(false) }}>{t('runClose')}</Button>
          <Button variant='primary' disabled={busy} onClick={() => { void onCreate() }}>{t('triggerCreate')}</Button>
        </span>
      </div>}
  </div>
}
