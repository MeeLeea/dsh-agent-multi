/**
 * The status page: every tracked run listed with its workflow and session on
 * the left, and a read-only canvas mirroring the selected run's live node
 * states on the right. Green marks a live run/node, yellow an idle run, red a
 * failed node, amber a node waiting on a human answer.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Background, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RunNodeView, RunSummary, RunView, WorkflowDefinition, WorkflowSummary,
} from 'dsh-agent-multi/types'
import type { AgentMultiInjected } from './WorkflowPage.tsx'
import css from './StatusPage.module.css'

const POLL_RUNS_MS = 2000
const POLL_RUN_MS = 1000

type NodeState = 'running' | 'completed' | 'failed'

/**
 * Render the tracked-run list and the selected run's status canvas.
 * @param props - injected actions and localized copy.
 * @returns the status page body.
 */
export function StatusPage(props: {
  readonly actions: PropsRuntime<'main'> & AgentMultiInjected & PropsLocale<'agent-multi'>
}) {
  const { actions } = props
  const { listRuns, listWorkflows, getRun, getWorkflow, t } = actions
  const [runs, setRuns] = useState<readonly RunSummary[] | null>(null)
  const [workflows, setWorkflows] = useState<readonly WorkflowSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<RunView | null>(null)
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null)

  // Track every run in the registry while the page is open.
  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      const result = await listRuns({})
      if (cancelled) return
      if (result.ok) setRuns(result.value.runs)
    }
    void poll()
    const timer = setInterval(() => { void poll() }, POLL_RUNS_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [listRuns])

  useEffect(() => {
    let cancelled = false
    void listWorkflows().then(result => {
      if (!cancelled && result.ok) setWorkflows(result.value)
    })
    return () => { cancelled = true }
  }, [listWorkflows])

  // Default selection: the first running run, else the newest entry.
  useEffect(() => {
    if (runs === null || runs.length === 0) return
    if (selectedId !== null && runs.some(run => run.runId === selectedId)) return
    const active = runs.find(run => run.status === 'running') ?? runs.at(0)
    if (active === undefined) return
    setSelectedId(active.runId)
  }, [runs, selectedId])

  const selected = runs?.find(run => run.runId === selectedId) ?? null
  const selectedWorkflowId = selected?.workflowId
  const selectedStatus = selected?.status

  // Poll the selected run's node states; settle into one-shot reads once the
  // run leaves the running state.
  useEffect(() => {
    if (selectedId === null) { setView(null); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      const result = await getRun({ runId: selectedId })
      if (cancelled) return
      if (result.ok && result.value.outcome === 'found') {
        setView(result.value.run)
        if (result.value.run.status === 'running') timer = setTimeout(() => { void poll() }, POLL_RUN_MS)
      }
    }
    void poll()
    return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer) }
  }, [selectedId, selectedStatus, getRun])

  useEffect(() => {
    if (selectedWorkflowId === undefined) { setDefinition(null); return }
    let cancelled = false
    void getWorkflow({ id: selectedWorkflowId }).then(result => {
      if (!cancelled && result.ok && result.value.outcome === 'found') setDefinition(result.value.definition)
    })
    return () => { cancelled = true }
  }, [selectedWorkflowId, getWorkflow])

  const nameOf = (workflowId: RunSummary['workflowId']): string =>
    workflows.find(entry => entry.id === workflowId)?.name ?? workflowId

  return <div className={css.statusBody}>
    <aside className={css.statusList}>
      {runs === null || runs.length === 0
        ? <p className={css.statusEmpty}>{t('statusEmpty')}</p>
        : runs.map(run => <button
          key={run.runId}
          type='button'
          className={`${css.statusRow} ${run.runId === selectedId ? css.statusRowSelected : ''}`}
          onClick={() => { setSelectedId(run.runId) }}
        >
          <span className={`${css.stateDot} ${run.status === 'running' ? css.stateDotActive : css.stateDotIdle}`} />
          <span className={css.statusRowText}>
            <span className={css.statusRowName}>{nameOf(run.workflowId)}</span>
            <span className={css.statusRowSession}>{run.sessionTitle ?? run.runId.slice(0, 8)}</span>
          </span>
        </button>)}
    </aside>
    <div className={css.statusCanvas}>
      {definition !== null && selectedWorkflowId !== undefined && definition.id === selectedWorkflowId
        ? <StatusCanvas
          definition={definition}
          nodes={view !== null && view.runId === selectedId ? view.nodes : []}
          {...(view !== null && view.runId === selectedId && view.hitl !== undefined
            ? { hitlNodeId: view.hitl.nodeId } : {})}
        />
        : <p className={css.statusEmpty}>{t('statusCanvasEmpty')}</p>}
    </div>
  </div>
}

type StatusFlowNode = Node<{
  spec: WorkflowDefinition['nodes'][number]
  state?: NodeState
  hitl?: boolean
}>

/** One status-canvas card: full handle set plus a colored state ring. */
function StatusCanvasCard({ data }: NodeProps<StatusFlowNode>) {
  const { spec, state, hitl } = data
  const ring = hitl === true ? css.ringHitl
    : state === 'running' ? css.ringRunning
      : state === 'completed' ? css.ringCompleted
        : state === 'failed' ? css.ringFailed : ''
  return <div className={`${css.card} ${ring}`}>
    {spec.kind !== 'note' && <Handle type='target' position={Position.Left} id='in' />}
    {spec.kind === 'loop' && <Handle type='target' position={Position.Top} id='back' className={css.backHandle} />}
    <span className={css.cardKind}>{spec.kind}</span>
    <span className={css.cardName}>{spec.name}</span>
    {spec.kind === 'input' || spec.kind === 'agent' || spec.kind === 'join'
      ? <Handle type='source' position={Position.Right} id='out' />
      : spec.kind === 'loop'
        ? <>
          <Handle type='source' position={Position.Right} id='iterate' style={{ top: '30%' }} />
          <Handle type='source' position={Position.Right} id='done' style={{ top: '70%' }} />
        </>
        : spec.kind === 'router'
          ? <>
            {spec.cases.map((label, index) => (
              <Handle key={label} type='source' position={Position.Right} id={label}
                style={{ top: `${(index + 1) * (100 / (spec.cases.length + 1))}%` }} />
            ))}
            <Handle type='source' position={Position.Right} id='default'
              style={{ top: `${(spec.cases.length + 1) * (100 / (spec.cases.length + 2))}%` }} />
          </>
          : undefined}
  </div>
}

const statusNodeTypes = { agentMulti: StatusCanvasCard }

/** Read-only canvas: the workflow graph with a live state ring per node. */
function StatusCanvas(props: {
  readonly definition: WorkflowDefinition
  readonly nodes: readonly RunNodeView[]
  readonly hitlNodeId?: string
}) {
  const { definition, nodes, hitlNodeId } = props
  const flow = useMemo(() => {
    const stateOf = new Map<string, NodeState>(nodes.map(node => [node.nodeId, node.status]))
    const flowNodes: StatusFlowNode[] = definition.nodes.map(spec => {
      const state = stateOf.get(spec.id)
      return {
        id: spec.id,
        type: 'agentMulti',
        position: spec.position ?? { x: 0, y: 0 },
        data: {
          spec,
          ...(state === undefined ? {} : { state }),
          ...(hitlNodeId === spec.id ? { hitl: true } : {}),
        },
      }
    })
    const flowEdges: Edge[] = definition.edges.map(edge => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.fromHandle ?? 'out',
      ...(edge.toHandle === undefined ? {} : { targetHandle: edge.toHandle }),
      markerEnd: { type: MarkerType.ArrowClosed },
    }))
    return { flowNodes, flowEdges }
  }, [definition, nodes, hitlNodeId])
  return <ReactFlow
    nodes={flow.flowNodes}
    edges={flow.flowEdges}
    nodeTypes={statusNodeTypes}
    fitView
    nodesDraggable={false}
    nodesConnectable={false}
    elementsSelectable={false}
  >
    <Background />
  </ReactFlow>
}
