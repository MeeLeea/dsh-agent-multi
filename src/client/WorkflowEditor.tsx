/**
 * The workflow canvas editor: a React Flow graph over the workflow draft with
 * a node palette, a per-kind inspector for the selected node or edge, and
 * save/validate actions against the stored definition.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow,
  useEdgesState, useNodesState,
  type Connection, type Edge, type EdgeMouseHandler, type Node, type NodeMouseHandler, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button, IconChevronLeftOutlineRegular, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  EdgeFormat, EdgeSpec, NodeKind, NodeSpec, WorkflowDefinition, WorkflowDraft, WorkflowId, WorkflowValidationError,
  AgentLibraryEntry, AgentLibrarySpec, ModelCatalog,
} from '@deepseek-ai/dsh-experimental-agent-multi/types'
import { NodeInspector } from './NodeInspector.tsx'
import type { AgentMultiInjected } from './WorkflowPage.tsx'
import type { AgentMultiKey } from './locales.ts'
import css from './WorkflowEditor.module.css'

/** The definition the editor edits. */
export interface EditorTarget {
  readonly definition: WorkflowDefinition
}

/** React Flow node carrying a node spec in its data. */
type AgentMultiFlowNode = Node<{ spec: NodeSpec }>

type Selection =
  | { readonly kind: 'node', readonly id: string }
  | { readonly kind: 'edge', readonly id: string }

/** Inspector form props: framework copy plus injected actions. */
export type InspectorProps = PropsRuntime<'main'> & InjectFace<AgentMultiInjected> & PropsLocale<'agent-multi'>

const KINDS: readonly NodeKind[] = ['input', 'agent', 'router', 'join', 'loop', 'output', 'note']

const KIND_LABEL: Record<NodeKind, AgentMultiKey> = {
  input: 'kindInput',
  agent: 'kindAgent',
  router: 'kindRouter',
  join: 'kindJoin',
  loop: 'kindLoop',
  output: 'kindOutput',
  note: 'kindNote',
}

function kindGlyph(kind: NodeKind): string {
  return kind === 'agent' ? '⬡' : kind === 'input' ? '→' : kind === 'output' ? '⏹' : kind === 'router' ? '⑃'
    : kind === 'join' ? '⨯' : kind === 'loop' ? '↻' : '✎'
}

/** Render one workflow node card with its per-kind handles. */
function AgentMultiCard({ data, selected }: NodeProps<AgentMultiFlowNode>) {
  const { spec } = data
  return <div className={`${css.card} ${css[spec.kind]} ${selected === true ? css.cardSelected : ''}`}>
    {spec.kind !== 'note' && <Handle type='target' position={Position.Left} id='in' />}
    {spec.kind === 'loop' && <Handle type='target' position={Position.Top} id='back' className={css.backHandle} />}
    <span className={css.cardGlyph}>{kindGlyph(spec.kind)}</span>
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

const nodeTypes = { agentMulti: AgentMultiCard }

function toFlow(definition: WorkflowDefinition): { nodes: AgentMultiFlowNode[], edges: Edge[] } {
  const nodes = definition.nodes.map((spec, index) => ({
    id: spec.id,
    type: 'agentMulti',
    position: spec.position ?? { x: 120 + (index % 4) * 220, y: 100 + Math.floor(index / 4) * 180 },
    data: { spec },
  }))
  const edges = definition.edges.map(edge => ({
    id: edge.id,
    source: edge.from,
    sourceHandle: edge.fromHandle ?? 'out',
    target: edge.to,
    ...(edge.toHandle === undefined ? {} : { targetHandle: edge.toHandle }),
    label: edge.format,
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { spec: edge },
  }))
  return { nodes, edges }
}

/**
 * Render the canvas editor with palette, inspector, and save/validate bar.
 * @param props - target definition, framework copy, injected actions, exit and run callbacks.
 * @returns the editor layout.
 */
export function WorkflowEditor(props: {
  readonly target: EditorTarget
  readonly actions: InspectorProps
  readonly onExit: () => void
  readonly onRun: (workflowId: WorkflowId, name: string) => void
}) {
  const { target, actions, onExit, onRun } = props
  const { saveWorkflow, validateWorkflow, listLibraryAgents, listModelCatalog, t } = actions
  const initial = useMemo(() => toFlow(target.definition), [target.definition])
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentMultiFlowNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [name, setName] = useState(target.definition.name)
  const [issues, setIssues] = useState<readonly WorkflowValidationError[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [library, setLibrary] = useState<readonly AgentLibraryEntry[]>([])
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)

  useEffect(() => {
    let cancelled = false
    void listLibraryAgents().then(result => {
      if (cancelled) return
      if (result.ok) setLibrary(result.value)
    })
    return () => { cancelled = true }
  }, [listLibraryAgents])

  useEffect(() => {
    let cancelled = false
    void listModelCatalog().then(result => {
      if (cancelled) return
      if (result.ok) setCatalog(result.value)
    })
    return () => { cancelled = true }
  }, [listModelCatalog])

  const markDirty = useCallback(() => { setDirty(true); setIssues(null) }, [])

  const onConnect = useCallback((connection: Connection) => {
    setEdges(current => [...current, {
      id: `e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      source: connection.source,
      sourceHandle: connection.sourceHandle ?? 'out',
      target: connection.target,
      ...(connection.targetHandle === 'back' ? { targetHandle: 'back' as const } : {}),
      label: 'text',
      markerEnd: { type: MarkerType.ArrowClosed },
      data: {
        spec: {
          id: `e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
          from: connection.source,
          ...(connection.sourceHandle === undefined || connection.sourceHandle === 'out'
            ? {}
            : { fromHandle: connection.sourceHandle }),
          to: connection.target,
          ...(connection.targetHandle === 'back' ? { toHandle: 'back' as const } : {}),
          format: 'text',
          inContext: true,
        },
      },
    }])
    markDirty()
  }, [setEdges, markDirty])

  const onNodeClick = useCallback<NodeMouseHandler>(() => { setSelection(null) }, [])
  const onEdgeClick = useCallback<EdgeMouseHandler>((_event, edge) => { setSelection({ kind: 'edge', id: edge.id }) }, [])

  const addNode = useCallback((kind: NodeKind) => {
    const index = nodes.length + 1
    const id = `${kind}${index}`
    const base = { id, name: `${kind} ${index}`, position: { x: 120 + (index % 4) * 220, y: 100 + Math.floor(index / 4) * 180 } }
    const spec: NodeSpec = kind === 'input' ? { kind, ...base }
      : kind === 'agent' ? { kind, ...base, systemPrompt: '', retry: { maxAttempts: 1, backoffMs: 0 }, hitlEnabled: false }
        : kind === 'router' ? { kind, ...base, cases: ['yes'] }
          : kind === 'join' ? { kind, ...base, strategy: 'all' }
            : kind === 'loop' ? { kind, ...base, mode: 'count', count: 2, maxIters: 8, collect: true }
              : kind === 'output' ? { kind, ...base }
                : { kind, ...base, text: '' }
    setNodes(current => [...current, { id, type: 'agentMulti', position: base.position, data: { spec } }])
    setSelection({ kind: 'node', id })
    markDirty()
  }, [nodes.length, setNodes, markDirty])

  /** Insert a library agent as a fresh canvas node carrying a spec copy. */
  const insertLibraryAgent = useCallback((entry: AgentLibraryEntry) => {
    const index = nodes.length + 1
    const id = `agent${index}`
    const position = { x: 120 + (index % 4) * 220, y: 100 + Math.floor(index / 4) * 180 }
    const spec: NodeSpec = {
      id, name: entry.name,
      ...libraryNodeFields(entry.spec),
      position,
    } as NodeSpec
    setNodes(current => [...current, { id, type: 'agentMulti', position, data: { spec } }])
    setSelection({ kind: 'node', id })
    markDirty()
  }, [nodes.length, setNodes, markDirty])

  const updateSpec = useCallback((id: string, next: NodeSpec) => {
    setNodes(current => current.map(node => node.id === id ? { ...node, data: { spec: next } } : node))
    markDirty()
  }, [setNodes, markDirty])

  const deleteNode = useCallback((id: string) => {
    setNodes(current => current.filter(node => node.id !== id))
    setEdges(current => current.filter(edge => edge.source !== id && edge.target !== id))
    setSelection(null)
    markDirty()
  }, [setNodes, setEdges, markDirty])

  const updateEdgeSpec = useCallback((id: string, next: EdgeSpec) => {
    setEdges(current => current.map(edge => edge.id === id
      ? { ...edge, label: next.format, data: { spec: next } }
      : edge))
    markDirty()
  }, [setEdges, markDirty])

  const deleteEdge = useCallback((id: string) => {
    setEdges(current => current.filter(edge => edge.id !== id))
    setSelection(null)
    markDirty()
  }, [setEdges, markDirty])

  const buildDraft = useCallback((): WorkflowDraft => ({
    name,
    nodes: nodes.map(node => ({ ...node.data.spec, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } })),
    edges: edges.map(edge => edge.data?.spec as EdgeSpec),
  }), [name, nodes, edges])

  const onSave = useCallback(async () => {
    const result = await saveWorkflow({ id: target.definition.id, draft: buildDraft(), expectedRevision: target.definition.revision })
    if (!result.ok) { setNotice(t('saveFailed')); return }
    const value = result.value
    if (value.outcome === 'saved') {
      setDirty(false)
      setIssues(null)
      setNotice(null)
    } else if (value.outcome === 'conflict') {
      setNotice(t('saveConflict'))
    } else if (value.outcome === 'invalid') {
      setIssues(value.errors)
    }
  }, [saveWorkflow, target.definition, buildDraft, t])

  const onValidate = useCallback(async () => {
    const result = await validateWorkflow({ draft: buildDraft() })
    if (result.ok) setIssues(result.value.errors)
  }, [validateWorkflow, buildDraft])

  const selectedNode = selection?.kind === 'node' ? nodes.find(node => node.id === selection.id) : undefined
  const selectedEdge = selection?.kind === 'edge' ? edges.find(edge => edge.id === selection.id) : undefined
  return <section className={css.editor}>
    <header className={css.toolbar}>
      <Button onClick={onExit}><IconChevronLeftOutlineRegular size={14} />{t('back')}</Button>
      <input
        className={css.nameInput}
        value={name}
        aria-label={t('nodeName')}
        onChange={event => { setName(event.target.value); markDirty() }}
      />
      <span className={css.revision}>{t('revision')} {target.definition.revision}{dirty ? ` · ${t('unsaved')}` : ''}</span>
      <Button onClick={() => { void onValidate() }}>{t('validate')}</Button>
      <Button variant='primary' onClick={() => { void onSave() }}>{t('save')}</Button>
      <Button onClick={() => onRun(target.definition.id, target.definition.name)}><IconPlayOutlineRegular size={14} />{t('run')}</Button>
    </header>
    {notice !== null && <p className={css.error}>{notice}</p>}
    {issues !== null && issues.length > 0 && <ul className={css.issues}>
      {issues.map((issue, index) => <li key={index} className={css.issueItem}>{issue.message}</li>)}
    </ul>}
    <div className={css.body}>
      <div className={css.palette}>
        <span className={css.paletteTitle}>{t('palette')}</span>
        {KINDS.map(kind => (
          <Button key={kind} onClick={() => addNode(kind)}>
            <span className={css.paletteGlyph}>{kindGlyph(kind)}</span>{t(KIND_LABEL[kind])}
          </Button>
        ))}
        {library.length > 0 && <>
          <span className={css.paletteTitle}>{t('libraryTitle')}</span>
          {library.map(entry => (
            <Button key={entry.id} onClick={() => insertLibraryAgent(entry)}>
              <span className={css.paletteGlyph}>{kindGlyph('agent')}</span>{entry.name}
            </Button>
          ))}
        </>}
      </div>
      <div className={css.canvasWrap}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={changes => { onNodesChange(changes); if (changes.some(change => change.type !== 'select' && change.type !== 'dimensions')) markDirty() }}
          onEdgesChange={changes => { onEdgesChange(changes); if (changes.some(change => change.type === 'remove')) markDirty() }}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onNodeDoubleClick={(_event, node) => { setSelection({ kind: 'node', id: node.id }) }}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <aside className={css.inspector}>
        {selectedNode !== undefined
          ? <NodeInspector
            spec={selectedNode.data?.spec as NodeSpec}
            onChange={next => { updateSpec(selectedNode.id, next) }}
            onDelete={() => { deleteNode(selectedNode.id) }}
            dryRun={actions}
            library={actions}
            catalog={catalog === null ? undefined : {
              load: () => Promise.resolve({ ok: true, value: catalog }),
            }}
            labels={actions}
          />
          : selectedEdge !== undefined
            ? <EdgeInspector
              spec={selectedEdge.data?.spec as EdgeSpec}
              onChange={next => { updateEdgeSpec(selectedEdge.id, next) }}
              onDelete={() => { deleteEdge(selectedEdge.id) }}
              labels={actions}
            />
            : <p className={css.hint}>{t('noSelection')}</p>}
      </aside>
    </div>
  </section>
}

/** Edge-format choice for the selected connection. */
function EdgeInspector(props: {
  readonly spec: EdgeSpec
  readonly onChange: (next: EdgeSpec) => void
  readonly onDelete: () => void
  readonly labels: PropsLocale<'agent-multi'>
}) {
  const { spec, onChange, onDelete, labels } = props
  const { t } = labels
  const formats: readonly EdgeFormat[] = ['json', 'md', 'text']
  return <div className={css.inspectorBody}>
    <h3 className={css.inspectorTitle}>{t('selectedEdge')}</h3>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('edgeFormat')}</span>
      <select
        className={css.select}
        value={spec.format}
        onChange={event => { onChange({ ...spec, format: event.target.value as EdgeFormat }) }}
      >
        {formats.map(format => <option key={format} value={format}>{format}</option>)}
      </select>
    </label>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('edgeInContext')}</span>
      <input
        type='checkbox'
        checked={spec.inContext}
        onChange={event => { onChange({ ...spec, inContext: event.target.checked }) }}
      />
    </label>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('edgeTemplate')}</span>
      <input
        className={css.input}
        value={spec.template ?? ''}
        placeholder={t('edgeTemplateHint')}
        onChange={event => {
          const template = event.target.value
          onChange(template === '' ? { ...stripTemplate(spec) } : { ...spec, template })
        }}
      />
    </label>
    <Button onClick={onDelete}>{t('edgeDelete')}</Button>
  </div>
}

/** Copy of the spec without a template entry, for exactOptionalPropertyTypes. */
function stripTemplate(spec: EdgeSpec): EdgeSpec {
  const { template: _template, ...rest } = spec
  return rest
}

/** Mutable agent-node fields from a library entry, with readonly arrays copied. */
function libraryNodeFields(spec: AgentLibrarySpec): {
  kind: 'agent', systemPrompt: string, retry: { maxAttempts: number, backoffMs: number, fallbackModel?: string },
  provider?: string, model?: string,
  toolFilter?: { allow?: string[], deny?: string[] },
  permissionPreset?: string, contextBudgetTokens?: number, timeoutMs?: number, hitlEnabled?: boolean,
} {
  const { kind, systemPrompt, provider, model, toolFilter, permissionPreset, contextBudgetTokens, timeoutMs, hitlEnabled } = spec
  const { maxAttempts, backoffMs, fallbackModel } = spec.retry
  return {
    kind,
    systemPrompt,
    retry: {
      maxAttempts, backoffMs,
      ...(fallbackModel === undefined ? {} : { fallbackModel }),
    },
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(toolFilter === undefined ? {} : {
      toolFilter: {
        ...(toolFilter.allow === undefined ? {} : { allow: [...toolFilter.allow] }),
        ...(toolFilter.deny === undefined ? {} : { deny: [...toolFilter.deny] }),
      },
    }),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    ...(contextBudgetTokens === undefined ? {} : { contextBudgetTokens }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(hitlEnabled === undefined ? {} : { hitlEnabled }),
  }
}
