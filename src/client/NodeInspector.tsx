/**
 * Per-kind configuration form for the selected workflow node: identity, the
 * kind-specific execution settings the host validates, and a dry-run probe.
 */
import { useEffect, useState } from 'react'
import { Button, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AgentNodeSpec, AgentLibrarySpec, DryRunNodeResult, ModelCatalog, NodeSpec } from '@deepseek-ai/dsh-experimental-agent-multi/types'
import type { AgentMultiKey } from './locales.ts'
import css from './WorkflowEditor.module.css'

/** Remote action surface the inspector needs for the dry-run probe. */
export interface DryRunActions {
  readonly dryRunNode: (request: { node: AgentNodeSpec, input: string }) => Promise<{ ok: boolean, value?: DryRunNodeResult, message?: string }>
}

/** Remote action surface the inspector needs for library saves. */
export interface LibraryActions {
  readonly createLibraryAgent: (request: { name: string, spec: AgentLibrarySpec }) => Promise<{ ok: boolean }>
}

/** Catalog access the inspector needs for provider/model dropdowns. */
export interface CatalogActions {
  readonly load: () => Promise<{ ok: boolean, value?: ModelCatalog, message?: string }>
}

/** Inspector props: the node spec, its replacement callback, and copy. */
export interface NodeInspectorProps {
  readonly spec: NodeSpec
  readonly onChange: (next: NodeSpec) => void
  readonly onDelete: () => void
  readonly dryRun?: DryRunActions
  readonly library?: LibraryActions
  readonly catalog?: CatalogActions
  readonly labels: PropsRuntime<'main'> & PropsLocale<'agent-multi'>
}

/** Textarea value for an optional string field ('' when absent). */
function textOf(value: string | undefined): string {
  return value ?? ''
}

/** Number input value for an optional integer field ('' when absent). */
function numberOf(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/** Parse a number input, mapping '' and NaN to undefined. */
function toNumber(value: string): number | undefined {
  if (value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Render the configuration form for one node.
 * @param props - node spec, change and delete callbacks, localized copy.
 * @returns the inspector form.
 */
export function NodeInspector(props: NodeInspectorProps) {
  const { spec, onChange, onDelete, dryRun, library, catalog, labels } = props
  const { t } = labels
  return <div className={css.inspectorBody}>
    <h3 className={css.inspectorTitle}>{spec.kind} · {spec.name}</h3>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeName')}</span>
      <input className={css.input} value={spec.name}
        onChange={event => { onChange({ ...spec, name: event.target.value }) }} />
    </label>
    {spec.kind === 'agent' && <AgentFields spec={spec} onChange={onChange} t={t} catalog={catalog} />}
    {spec.kind === 'agent' && dryRun !== undefined && <DryRunSection spec={spec} dryRun={dryRun} t={t} />}
    {spec.kind === 'agent' && library !== undefined && <SaveToLibrarySection spec={spec} library={library} t={t} />}
    {spec.kind === 'router' && <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeCases')}</span>
      <textarea className={css.textarea} rows={4} value={spec.cases.join('\n')}
        onChange={event => {
          onChange({ ...spec, cases: event.target.value.split('\n').map(line => line.trim()).filter(line => line !== '') })
        }} />
    </label>}
    {spec.kind === 'join' && <>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('nodeStrategy')}</span>
        <select className={css.select} value={spec.strategy}
          onChange={event => {
            const strategy = event.target.value as typeof spec.strategy
            onChange(strategy === 'quorum' ? { ...spec, strategy } : { ...stripQuorum({ ...spec, strategy }) })
          }}>
          <option value='all'>{t('strategyAll')}</option>
          <option value='any'>{t('strategyAny')}</option>
          <option value='quorum'>{t('strategyQuorum')}</option>
        </select>
      </label>
      {spec.strategy === 'quorum' && <NumberField
        label={t('nodeQuorum')} value={spec.quorum}
        onChange={quorum => { onChange(quorum === undefined ? stripQuorum(spec) : { ...spec, quorum }) }} />}
    </>}
    {spec.kind === 'loop' && <LoopFields spec={spec} onChange={onChange} t={t} />}
    {spec.kind === 'note' && <label className={css.field}>
      <span className={css.fieldLabel}>{t('noteText')}</span>
      <textarea className={css.textarea} rows={6} value={spec.text}
        onChange={event => { onChange({ ...spec, text: event.target.value }) }} />
    </label>}
    <Button onClick={onDelete}><IconTrashOutlineRegular size={14} />{t('nodeDelete')}</Button>
  </div>
}

type Translate = (key: AgentMultiKey) => string

/** Agent-node execution fields. */
function AgentFields(props: {
  readonly spec: Extract<NodeSpec, { kind: 'agent' }>
  readonly onChange: (next: NodeSpec) => void
  readonly t: Translate
  readonly catalog?: CatalogActions
}) {
  const { spec, onChange, t, catalog } = props
  const { retry } = spec
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const catalogLoad = catalog?.load
  useEffect(() => {
    if (catalogLoad === undefined) return
    let cancelled = false
    void catalogLoad().then(result => {
      if (cancelled) return
      if (result.ok && result.value !== undefined) setModelCatalog(result.value)
      else setCatalogFailed(true)
    })
    return () => { cancelled = true }
  }, [catalogLoad])
  const providers = modelCatalog?.providers ?? []
  const models = modelCatalog?.models ?? []
  const scopedModels = spec.provider === undefined ? models : models.filter(model => model.provider === spec.provider)
  return <>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeSystemPrompt')}</span>
      <textarea className={css.textarea} rows={8} value={spec.systemPrompt}
        onChange={event => { onChange({ ...spec, systemPrompt: event.target.value }) }} />
    </label>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeProvider')}</span>
      {providers.length > 0
        ? <select
          className={css.select}
          value={spec.provider ?? ''}
          onChange={event => { onChange(withProvider(spec, event.target.value)) }}
        >
          <option value=''>{t('nodeModelPlaceholder')}</option>
          {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
        : <input className={css.input} value={textOf(spec.provider)} placeholder={catalogFailed ? t('catalogFailed') : t('nodeModelPlaceholder')}
          onChange={event => { onChange(withProvider(spec, event.target.value)) }} />}
    </label>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeModel')}</span>
      {scopedModels.length > 0
        ? <select
          className={css.select}
          value={spec.model ?? ''}
          onChange={event => { onChange(withModel(spec, event.target.value)) }}
        >
          <option value=''>{t('nodeModelPlaceholder')}</option>
          {scopedModels.map(model => <option key={`${model.provider}/${model.id}`} value={model.id}>{model.name}</option>)}
        </select>
        : <input className={css.input} value={textOf(spec.model)} placeholder={t('nodeModelPlaceholder')}
          onChange={event => { onChange(withModel(spec, event.target.value)) }} />}
    </label>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeToolAllow')}</span>
      <textarea className={css.textarea} rows={3} value={textOf(spec.toolFilter?.allow?.join('\n'))}
        onChange={event => { onChange(withToolFilter(spec, 'allow', event.target.value)) }} />
    </label>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeToolDeny')}</span>
      <textarea className={css.textarea} rows={3} value={textOf(spec.toolFilter?.deny?.join('\n'))}
        onChange={event => { onChange(withToolFilter(spec, 'deny', event.target.value)) }} />
    </label>
    <NumberField label={t('nodeContextBudget')} value={spec.contextBudgetTokens}
      onChange={value => { onChange(withNumber(spec, 'contextBudgetTokens', value)) }} />
    <NumberField label={t('nodeRetry')} value={retry.maxAttempts} min={1}
      onChange={value => { onChange({ ...spec, retry: { ...retry, maxAttempts: value ?? 1 } }) }} />
    <NumberField label={t('nodeBackoff')} value={retry.backoffMs} min={0}
      onChange={value => { onChange({ ...spec, retry: { ...retry, backoffMs: value ?? 0 } }) }} />
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeFallbackModel')}</span>
      <input className={css.input} value={textOf(retry.fallbackModel)}
        onChange={event => {
          const fallbackModel = event.target.value
          const next = fallbackModel === '' ? stripFallback(retry) : { ...retry, fallbackModel }
          onChange({ ...spec, retry: next })
        }} />
    </label>
    <NumberField label={t('nodeTimeout')} value={spec.timeoutMs}
      onChange={value => { onChange(withNumber(spec, 'timeoutMs', value)) }} />
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('nodeHitl')}</span>
      <input type='checkbox' checked={spec.hitlEnabled}
        onChange={event => { onChange({ ...spec, hitlEnabled: event.target.checked }) }} />
    </label>
  </>
}

/** Loop-node fields, gated by the loop mode. */
function LoopFields(props: {
  readonly spec: Extract<NodeSpec, { kind: 'loop' }>
  readonly onChange: (next: NodeSpec) => void
  readonly t: Translate
}) {
  const { spec, onChange, t } = props
  return <>
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('loopMode')}</span>
      <select className={css.select} value={spec.mode}
        onChange={event => { onChange(withLoopMode(spec, event.target.value as typeof spec.mode)) }}>
        <option value='items'>items</option>
        <option value='count'>count</option>
        <option value='while'>while</option>
      </select>
    </label>
    {spec.mode === 'items' && <label className={css.field}>
      <span className={css.fieldLabel}>{t('loopItems')}</span>
      <input className={css.input} value={textOf(spec.itemsExpr)}
        onChange={event => { onChange(withLoopParam(spec, 'itemsExpr', event.target.value)) }} />
    </label>}
    {spec.mode === 'count' && <NumberField label={t('loopCount')} value={spec.count} min={1}
      onChange={value => { onChange(value === undefined ? stripLoopParam({ ...spec }) : { ...spec, count: value }) }} />}
    {spec.mode === 'while' && <label className={css.field}>
      <span className={css.fieldLabel}>{t('loopCondition')}</span>
      <input className={css.input} value={textOf(spec.condition)}
        onChange={event => { onChange(withLoopParam(spec, 'condition', event.target.value)) }} />
    </label>}
    <NumberField label={t('loopMaxIters')} value={spec.maxIters} min={1}
      onChange={value => { onChange({ ...spec, maxIters: value ?? 1 }) }} />
    <label className={css.field}>
      <span className={css.fieldLabel}>{t('loopCollect')}</span>
      <input type='checkbox' checked={spec.collect}
        onChange={event => { onChange({ ...spec, collect: event.target.checked }) }} />
    </label>
  </>
}

/** Number input bound to an optional numeric field. */
function NumberField(props: {
  readonly label: string
  readonly value: number | undefined
  readonly min?: number
  readonly onChange: (value: number | undefined) => void
}) {
  return <label className={css.field}>
    <span className={css.fieldLabel}>{props.label}</span>
    <input className={css.input} type='number' min={props.min} value={numberOf(props.value)}
      onChange={event => { props.onChange(toNumber(event.target.value)) }} />
  </label>
}

type AgentSpec = Extract<NodeSpec, { kind: 'agent' }>

function withProvider(spec: AgentSpec, provider: string): NodeSpec {
  return provider === '' ? stripKey({ ...spec }, 'provider') : { ...spec, provider }
}

function withModel(spec: AgentSpec, model: string): NodeSpec {
  return model === '' ? stripKey({ ...spec }, 'model') : { ...spec, model }
}

function withNumber<K extends 'contextBudgetTokens' | 'timeoutMs'>(spec: AgentSpec, key: K, value: number | undefined): NodeSpec {
  return value === undefined ? stripKey({ ...spec }, key) : { ...spec, [key]: value }
}

function withToolFilter(spec: AgentSpec, key: 'allow' | 'deny', value: string): NodeSpec {
  const items = value.split('\n').map(line => line.trim()).filter(line => line !== '')
  const current = spec.toolFilter
  const next = items.length === 0
    ? { ...(current ?? {}), [key]: undefined }
    : { ...(current ?? {}), [key]: items }
  const allow = next.allow
  const deny = next.deny
  if (allow === undefined && deny === undefined) return stripKey({ ...spec }, 'toolFilter')
  return { ...spec, toolFilter: { ...(allow === undefined ? {} : { allow }), ...(deny === undefined ? {} : { deny }) } }
}

function stripFallback(retry: AgentSpec['retry']): AgentSpec['retry'] {
  const { fallbackModel: _fallbackModel, ...rest } = retry
  return rest
}

type LoopSpec = Extract<NodeSpec, { kind: 'loop' }>

function withLoopMode(spec: LoopSpec, mode: LoopSpec['mode']): NodeSpec {
  const { itemsExpr: _i, count: _c, condition: _d, ...rest } = spec
  return mode === 'count' ? { ...rest, mode, count: 2 } : { ...rest, mode }
}

function withLoopParam(spec: LoopSpec, key: 'itemsExpr' | 'condition', value: string): NodeSpec {
  return value === '' ? stripKey({ ...spec }, key) : { ...spec, [key]: value }
}

function stripLoopParam(spec: LoopSpec): NodeSpec {
  const { count: _count, ...rest } = spec
  return rest
}

function stripQuorum(spec: Extract<NodeSpec, { kind: 'join' }>): NodeSpec {
  const { quorum: _quorum, ...rest } = spec
  return rest
}

/** Copy without one optional key, for exactOptionalPropertyTypes safety. */
function stripKey<T extends object, K extends keyof T>(spec: T, key: K): T {
  const copy = { ...spec }
  delete copy[key]
  return copy
}

/**
 * One-off dry-run probe for an agent node: user input, a trigger, and the
 * settled result (output or failure) without saving or journaling a run.
 */
function DryRunSection(props: {
  readonly spec: AgentNodeSpec
  readonly dryRun: DryRunActions
  readonly t: (key: AgentMultiKey) => string
}) {
  const { spec, dryRun, t } = props
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DryRunNodeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const response = await dryRun.dryRunNode({ node: spec, input })
      if (!response.ok) {
        setError(response.message ?? 'request failed')
      } else if (response.value !== undefined) {
        setResult(response.value)
      }
    } finally {
      setBusy(false)
    }
  }
  return <div className={css.field}>
    <span className={css.fieldLabel}>{t('dryRunTitle')}</span>
    <textarea
      className={css.textarea}
      rows={2}
      value={input}
      placeholder={t('dryRunInputPlaceholder')}
      onChange={event => { setInput(event.target.value) }}
    />
    <Button variant='outline' disabled={busy} onClick={() => { void run() }}>
      {busy ? t('dryRunRunning') : t('dryRunStart')}
    </Button>
    {error !== null && <p className={css.dryRunError}>{error}</p>}
    {result?.outcome === 'completed' && <div className={css.dryRunOutput}>
      <p className={css.dryRunMeta}>{t('dryRunDuration')}: {result.durationMs}ms
        {result.usage !== undefined ? ` · ${result.usage.inputTokens + result.usage.outputTokens} tokens` : ''}</p>
      <pre className={css.dryRunPre}>{result.output}</pre>
    </div>}
    {result?.outcome === 'failed' && <div className={css.dryRunOutput}>
      <p className={css.dryRunError}>{t('dryRunFailed')}: {result.message} (×{result.attempts})</p>
    </div>}
  </div>
}

/** Library-copy spec from an agent node spec, dropping canvas-local fields. */
function librarySpecOf(spec: AgentNodeSpec): AgentLibrarySpec {
  const { kind, systemPrompt, provider, model, toolFilter, permissionPreset, contextBudgetTokens, timeoutMs } = spec
  const { maxAttempts, backoffMs, fallbackModel } = spec.retry
  return {
    kind, systemPrompt,
    hitlEnabled: spec.hitlEnabled ?? false,
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
  }
}

/** Save-the-current-agent form: name the entry and store a spec copy. */
function SaveToLibrarySection(props: {
  readonly spec: AgentNodeSpec
  readonly library: LibraryActions
  readonly t: (key: AgentMultiKey) => string
}) {
  const { spec, library, t } = props
  const [name, setName] = useState(spec.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (busy || name.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const response = await library.createLibraryAgent({ name: name.trim(), spec: librarySpecOf(spec) })
      if (!response.ok) setError(t('librarySaveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return <div className={css.field}>
    <span className={css.fieldLabel}>{t('libraryTitle')}</span>
    <input
      className={css.input}
      value={name}
      placeholder={t('libraryNamePrompt')}
      onChange={event => { setName(event.target.value) }}
    />
    <Button variant='outline' disabled={busy} onClick={() => { void save() }}>{t('librarySave')}</Button>
    {error !== null && <p className={css.dryRunError}>{error}</p>}
  </div>
}
