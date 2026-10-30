/**
 * The agent-multi main panel: the workflow list, the canvas editor, and the
 * run panel. The page owns view routing and list loading; editing and run
 * observation live in their own components.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Button, IconPlusOutlineRegular, IconTrashOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CancelRunResult, CreateWorkflowResult, DeleteWorkflowResult, DryRunNodeResult, GetRunResult,
  GetWorkflowResult, ListRunsResult, ResumeRunResult, SaveWorkflowRequest, SaveWorkflowResult, StartRunResult,
  ValidateWorkflowResult, WorkflowDraft, WorkflowId, WorkflowSummary, AgentNodeSpec,
  ExportWorkflowResult, ImportWorkflowResult, WorkflowExportDocument, AgentLibraryEntry, AgentLibraryId,
  AgentLibrarySpec, CreateLibraryAgentResult, SaveLibraryAgentResult, CreateTriggerRequest, CreateTriggerResult,
  ListTriggersResult, SetTriggerEnabledResult, DeleteTriggerResult,
  ModelCatalog,
} from '@deepseek-ai/dsh-experimental-agent-multi/types'
import { RunPanel, type RunTarget } from './RunPanel.tsx'
import { WorkflowEditor, type EditorTarget } from './WorkflowEditor.tsx'
import css from './WorkflowPage.module.css'

/** Remote-backed actions injected into the panel. */
export interface AgentMultiInjected {
  readonly createWorkflow: (draft: WorkflowDraft) => Promise<RemoteResult<CreateWorkflowResult>>
  readonly saveWorkflow: (request: SaveWorkflowRequest) => Promise<RemoteResult<SaveWorkflowResult>>
  readonly listWorkflows: () => Promise<RemoteResult<readonly WorkflowSummary[]>>
  readonly getWorkflow: (request: { id: WorkflowId }) => Promise<RemoteResult<GetWorkflowResult>>
  readonly deleteWorkflow: (request: { id: WorkflowId }) => Promise<RemoteResult<DeleteWorkflowResult>>
  readonly validateWorkflow: (request: { draft: WorkflowDraft }) => Promise<RemoteResult<ValidateWorkflowResult>>
  readonly startRun: (request: { workflowId: WorkflowId, input: string }) => Promise<RemoteResult<StartRunResult>>
  readonly resumeRun: (request: { runId: string }) => Promise<RemoteResult<ResumeRunResult>>
  readonly cancelRun: (request: { runId: string }) => Promise<RemoteResult<CancelRunResult>>
  readonly getRun: (request: { runId: string }) => Promise<RemoteResult<GetRunResult>>
  readonly listRuns: (request: { workflowId?: WorkflowId }) => Promise<RemoteResult<ListRunsResult>>
  readonly dryRunNode: (request: { node: AgentNodeSpec, input: string }) => Promise<RemoteResult<DryRunNodeResult>>
  readonly exportWorkflow: (request: { id: WorkflowId }) => Promise<RemoteResult<ExportWorkflowResult>>
  readonly importWorkflow: (request: { document: WorkflowExportDocument, keepId?: boolean }) => Promise<RemoteResult<ImportWorkflowResult>>
  readonly listLibraryAgents: () => Promise<RemoteResult<readonly AgentLibraryEntry[]>>
  readonly createLibraryAgent: (request: { name: string, spec: AgentLibrarySpec }) => Promise<RemoteResult<CreateLibraryAgentResult>>
  readonly saveLibraryAgent: (request: { id: AgentLibraryId, name: string, spec: AgentLibrarySpec }) => Promise<RemoteResult<SaveLibraryAgentResult>>
  readonly deleteLibraryAgent: (request: { id: AgentLibraryId }) => Promise<RemoteResult<{ outcome: 'deleted' | 'missing' }>>
  readonly createTrigger: (request: CreateTriggerRequest) => Promise<RemoteResult<CreateTriggerResult>>
  readonly setTriggerEnabled: (request: { id: string, enabled: boolean }) => Promise<RemoteResult<SetTriggerEnabledResult>>
  readonly deleteTrigger: (request: { id: string }) => Promise<RemoteResult<DeleteTriggerResult>>
  readonly listTriggers: (request: { workflowId?: WorkflowId }) => Promise<RemoteResult<ListTriggersResult>>
  readonly listModelCatalog: () => Promise<RemoteResult<ModelCatalog>>
}

/** Root-scoped panel props derived from the framework and injected actions. */
export type WorkflowPageProps = PropsRuntime<'main'>
  & InjectFace<AgentMultiInjected>
  & PropsLocale<'agent-multi'>

type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'edit', readonly target: EditorTarget }
  | { readonly kind: 'run', readonly target: RunTarget }

/** Default new-workflow draft: input → one agent → output. */
function newDraft(name: string): WorkflowDraft {
  return {
    name,
    nodes: [
      { kind: 'input', id: 'input', name: 'Input', position: { x: 60, y: 200 } },
      {
        kind: 'agent', id: 'agent1', name: 'Agent 1', position: { x: 360, y: 200 },
        systemPrompt: '', retry: { maxAttempts: 1, backoffMs: 0 }, hitlEnabled: false,
      },
      { kind: 'output', id: 'output', name: 'Output', position: { x: 660, y: 200 } },
    ],
    edges: [
      { id: 'e1', from: 'input', to: 'agent1', format: 'text', inContext: true },
      { id: 'e2', from: 'agent1', to: 'output', format: 'text', inContext: true },
    ],
  }
}

/**
 * Render the workflow list, editor, or run panel.
 * @param props - framework props, injected actions, and localized copy.
 * @returns the panel contents.
 */
export function WorkflowPage(props: WorkflowPageProps) {
  const { createWorkflow, listWorkflows, deleteWorkflow, getWorkflow, exportWorkflow, importWorkflow, t } = props
  const [view, setView] = useState<View>({ kind: 'list' })
  const [workflows, setWorkflows] = useState<readonly WorkflowSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importText, setImportText] = useState<string | null>(null)
  const [keepId, setKeepId] = useState(false)

  useEffect(() => {
    let cancelled = false
    listWorkflows().then(result => {
      if (cancelled) return
      if (result.ok) setWorkflows([...result.value].sort((a, b) => a.name.localeCompare(b.name)))
      else setError(t('loadFailed'))
    })
    return () => { cancelled = true }
  }, [listWorkflows, t])

  const openEditor = useCallback(async (id: WorkflowId) => {
    const result = await getWorkflow({ id })
    if (result.ok && result.value.outcome === 'found') {
      setView({ kind: 'edit', target: { definition: result.value.definition } })
    } else {
      setError(t('loadFailed'))
    }
  }, [getWorkflow, t])

  const onCreate = useCallback(async () => {
    const draft = newDraft(t('draftName'))
    const result = await createWorkflow(draft)
    if (result.ok && result.value.outcome === 'created') {
      setView({ kind: 'edit', target: { definition: result.value.definition } })
    } else if (result.ok && result.value.outcome === 'invalid') {
      setError(result.value.errors.map(entry => entry.message).join('; '))
    }
  }, [createWorkflow, t])

  const onDelete = useCallback(async (id: WorkflowId) => {
    if (!window.confirm(t('deleteConfirm'))) return
    const result = await deleteWorkflow({ id })
    if (result.ok && result.value.outcome === 'deleted') {
      setWorkflows(current => current?.filter(entry => entry.id !== id) ?? null)
    }
  }, [deleteWorkflow, t])

  const onExport = useCallback(async (id: WorkflowId) => {
    const result = await exportWorkflow({ id })
    if (!result.ok || result.value.outcome === 'missing') { setError(t('exportFailed')); return }
    const exported = result.value.document
    if (exported === undefined) { setError(t('exportFailed')); return }
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${exported.definition.name}.agent-multi.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [exportWorkflow, t])

  const onImport = useCallback(async () => {
    if (importText === null) return
    let imported: WorkflowExportDocument
    try {
      imported = JSON.parse(importText) as WorkflowExportDocument
    } catch {
      setError(t('importInvalid'))
      return
    }
    const result = await importWorkflow({ document: imported, ...(keepId ? { keepId } : {}) })
    if (!result.ok) { setError(t('importFailed')); return }
    if (result.value.outcome === 'created') {
      setImportText(null)
      setError(null)
      void refresh()
    } else {
      setError(result.value.errors.map(entry => entry.message).join('; '))
    }
  }, [importText, keepId, importWorkflow, t])

  if (view.kind === 'edit') {
    return <WorkflowEditor
      target={view.target}
      actions={props}
      onExit={() => { setView({ kind: 'list' }); void refresh() }}
      onRun={(workflowId, name) => { setView({ kind: 'run', target: { workflowId, name } }) }}
    />
  }
  if (view.kind === 'run') {
    return <RunPanel target={view.target} actions={props} onExit={() => setView({ kind: 'list' })} />
  }

  function refresh(): Promise<void> {
    return listWorkflows().then(result => {
      if (result.ok) setWorkflows([...result.value].sort((a, b) => a.name.localeCompare(b.name)))
    })
  }

  return <section className={css.page}>
    <header className={css.header}>
      <h2 className={css.title}>{t('listTitle')}</h2>
      <Button onClick={() => { setImportText(importText === null ? '' : null) }}>{t('importAction')}</Button>
      <Button variant='primary' onClick={() => { void onCreate() }}>
        <IconPlusOutlineRegular size={14} />{t('create')}
      </Button>
    </header>
    {error !== null && <p className={css.error}>{error}</p>}
    {importText !== null && <div className={css.importBox}>
      <span className={css.sectionTitle}>{t('importTitle')}</span>
      <textarea className={css.importText} rows={5} value={importText} placeholder={t('importHint')}
        onChange={event => { setImportText(event.target.value) }} />
      <label className={css.importKeep}>
        <input type='checkbox' checked={keepId} onChange={event => { setKeepId(event.target.checked) }} />
        {t('importKeepId')}
      </label>
      <Button variant='primary' onClick={() => { void onImport() }}>{t('importAction')}</Button>
    </div>}
    {workflows === null
      ? <p className={css.hint}>{t('loadFailed')}</p>
      : workflows.length === 0
        ? <div className={css.empty}>
          <p className={css.title}>{t('listEmpty')}</p>
          <p className={css.hint}>{t('listEmptyHint')}</p>
        </div>
        : <ul className={css.list}>
          {workflows.map(entry => <li key={entry.id} className={css.row}>
            <span className={css.rowName}>{entry.name}</span>
            <span className={css.rowMeta}>{t('revision')} {entry.revision}</span>
            <span className={css.rowActions}>
              <Button onClick={() => { void openEditor(entry.id) }}>{t('open')}</Button>
              <Button onClick={() => setView({ kind: 'run', target: { workflowId: entry.id, name: entry.name } })}>{t('run')}</Button>
              <Button onClick={() => { void onExport(entry.id) }}>{t('export')}</Button>
              <Button onClick={() => { void onDelete(entry.id) }}><IconTrashOutlineRegular size={14} /></Button>
            </span>
          </li>)}
        </ul>}
  </section>
}
