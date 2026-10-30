import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Per-kind configuration form for the selected workflow node: identity, the
 * kind-specific execution settings the host validates, and a dry-run probe.
 */
import { useEffect, useState } from 'react';
import { Button, IconTrashOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './WorkflowEditor.module.css';
/** Textarea value for an optional string field ('' when absent). */
function textOf(value) {
    return value ?? '';
}
/** Number input value for an optional integer field ('' when absent). */
function numberOf(value) {
    return value === undefined ? '' : String(value);
}
/** Parse a number input, mapping '' and NaN to undefined. */
function toNumber(value) {
    if (value === '')
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/**
 * Render the configuration form for one node.
 * @param props - node spec, change and delete callbacks, localized copy.
 * @returns the inspector form.
 */
export function NodeInspector(props) {
    const { spec, onChange, onDelete, dryRun, library, labels, catalog } = props;
    const { t } = labels;
    return _jsxs("div", { className: css.inspectorBody, children: [_jsxs("h3", { className: css.inspectorTitle, children: [spec.kind, " \u00B7 ", spec.name] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeName') }), _jsx("input", { className: css.input, value: spec.name, onChange: event => { onChange({ ...spec, name: event.target.value }); } })] }), spec.kind === 'agent' && _jsx(AgentFields, { spec: spec, onChange: onChange, t: t, catalog: catalog }), spec.kind === 'agent' && dryRun !== undefined && _jsx(DryRunSection, { spec: spec, dryRun: dryRun, t: t }), spec.kind === 'agent' && library !== undefined && _jsx(SaveToLibrarySection, { spec: spec, library: library, t: t }), spec.kind === 'router' && _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeCases') }), _jsx("textarea", { className: css.textarea, rows: 4, value: spec.cases.join('\n'), onChange: event => {
                            onChange({ ...spec, cases: event.target.value.split('\n').map(line => line.trim()).filter(line => line !== '') });
                        } })] }), spec.kind === 'join' && _jsxs(_Fragment, { children: [_jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeStrategy') }), _jsxs("select", { className: css.select, value: spec.strategy, onChange: event => {
                                    const strategy = event.target.value;
                                    onChange(strategy === 'quorum' ? { ...spec, strategy } : { ...stripQuorum({ ...spec, strategy }) });
                                }, children: [_jsx("option", { value: 'all', children: t('strategyAll') }), _jsx("option", { value: 'any', children: t('strategyAny') }), _jsx("option", { value: 'quorum', children: t('strategyQuorum') })] })] }), spec.strategy === 'quorum' && _jsx(NumberField, { label: t('nodeQuorum'), value: spec.quorum, onChange: quorum => { onChange(quorum === undefined ? stripQuorum(spec) : { ...spec, quorum }); } })] }), spec.kind === 'loop' && _jsx(LoopFields, { spec: spec, onChange: onChange, t: t }), spec.kind === 'note' && _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('noteText') }), _jsx("textarea", { className: css.textarea, rows: 6, value: spec.text, onChange: event => { onChange({ ...spec, text: event.target.value }); } })] }), _jsxs(Button, { onClick: onDelete, children: [_jsx(IconTrashOutlineRegular, { size: 14 }), t('nodeDelete')] })] });
}
/** Agent-node execution fields. */
function AgentFields(props) {
    const { spec, onChange, t, catalog } = props;
    const { retry } = spec;
    const [modelCatalog, setModelCatalog] = useState(null);
    const [catalogFailed, setCatalogFailed] = useState(false);
    useEffect(() => {
        if (!catalog)
            return;
        let cancelled = false;
        catalog.load().then(response => {
            if (cancelled)
                return;
            if (response.ok)
                setModelCatalog(response.value);
            else
                setCatalogFailed(true);
        }).catch(() => {
            if (!cancelled)
                setCatalogFailed(true);
        });
        return () => { cancelled = true; };
    }, [catalog]);
    const providers = modelCatalog?.providers ?? [];
    const models = modelCatalog?.models ?? [];
    const scopedModels = spec.provider ? models.filter(model => model.provider === spec.provider) : models;
    return _jsxs(_Fragment, { children: [_jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeSystemPrompt') }), _jsx("textarea", { className: css.textarea, rows: 8, value: spec.systemPrompt, onChange: event => { onChange({ ...spec, systemPrompt: event.target.value }); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeProvider') }), providers.length > 0 ? _jsxs("select", { className: css.select, value: textOf(spec.provider), onChange: event => { onChange(withProvider(spec, event.target.value)); }, children: [_jsx("option", { value: '', children: t('nodeModelPlaceholder') }), ...providers.map(provider => _jsx("option", { value: provider.id, children: provider.name }, provider.id))] }) : _jsx("input", { className: css.input, value: textOf(spec.provider), placeholder: catalogFailed ? t('catalogFailed') : t('nodeModelPlaceholder'), onChange: event => { onChange(withProvider(spec, event.target.value)); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeModel') }), scopedModels.length > 0 ? _jsxs("select", { className: css.select, value: textOf(spec.model), onChange: event => { onChange(withModel(spec, event.target.value)); }, children: [_jsx("option", { value: '', children: t('nodeModelPlaceholder') }), ...scopedModels.map(model => _jsx("option", { value: model.id, children: model.name }, `${model.provider}/${model.id}`))] }) : _jsx("input", { className: css.input, value: textOf(spec.model), placeholder: catalogFailed ? t('catalogFailed') : t('nodeModelPlaceholder'), onChange: event => { onChange(withModel(spec, event.target.value)); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeToolAllow') }), _jsx("textarea", { className: css.textarea, rows: 3, value: textOf(spec.toolFilter?.allow?.join('\n')), onChange: event => { onChange(withToolFilter(spec, 'allow', event.target.value)); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeToolDeny') }), _jsx("textarea", { className: css.textarea, rows: 3, value: textOf(spec.toolFilter?.deny?.join('\n')), onChange: event => { onChange(withToolFilter(spec, 'deny', event.target.value)); } })] }), _jsx(NumberField, { label: t('nodeContextBudget'), value: spec.contextBudgetTokens, onChange: value => { onChange(withNumber(spec, 'contextBudgetTokens', value)); } }), _jsx(NumberField, { label: t('nodeRetry'), value: retry.maxAttempts, min: 1, onChange: value => { onChange({ ...spec, retry: { ...retry, maxAttempts: value ?? 1 } }); } }), _jsx(NumberField, { label: t('nodeBackoff'), value: retry.backoffMs, min: 0, onChange: value => { onChange({ ...spec, retry: { ...retry, backoffMs: value ?? 0 } }); } }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeFallbackModel') }), _jsx("input", { className: css.input, value: textOf(retry.fallbackModel), onChange: event => {
                            const fallbackModel = event.target.value;
                            const next = fallbackModel === '' ? stripFallback(retry) : { ...retry, fallbackModel };
                            onChange({ ...spec, retry: next });
                        } })] }), _jsx(NumberField, { label: t('nodeTimeout'), value: spec.timeoutMs, onChange: value => { onChange(withNumber(spec, 'timeoutMs', value)); } }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('nodeHitl') }), _jsx("input", { type: 'checkbox', checked: spec.hitlEnabled, onChange: event => { onChange({ ...spec, hitlEnabled: event.target.checked }); } })] })] });
}
/** Loop-node fields, gated by the loop mode. */
function LoopFields(props) {
    const { spec, onChange, t } = props;
    return _jsxs(_Fragment, { children: [_jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('loopMode') }), _jsxs("select", { className: css.select, value: spec.mode, onChange: event => { onChange(withLoopMode(spec, event.target.value)); }, children: [_jsx("option", { value: 'items', children: "items" }), _jsx("option", { value: 'count', children: "count" }), _jsx("option", { value: 'while', children: "while" })] })] }), spec.mode === 'items' && _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('loopItems') }), _jsx("input", { className: css.input, value: textOf(spec.itemsExpr), onChange: event => { onChange(withLoopParam(spec, 'itemsExpr', event.target.value)); } })] }), spec.mode === 'count' && _jsx(NumberField, { label: t('loopCount'), value: spec.count, min: 1, onChange: value => { onChange(value === undefined ? stripLoopParam({ ...spec }) : { ...spec, count: value }); } }), spec.mode === 'while' && _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('loopCondition') }), _jsx("input", { className: css.input, value: textOf(spec.condition), onChange: event => { onChange(withLoopParam(spec, 'condition', event.target.value)); } })] }), _jsx(NumberField, { label: t('loopMaxIters'), value: spec.maxIters, min: 1, onChange: value => { onChange({ ...spec, maxIters: value ?? 1 }); } }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('loopCollect') }), _jsx("input", { type: 'checkbox', checked: spec.collect, onChange: event => { onChange({ ...spec, collect: event.target.checked }); } })] })] });
}
/** Number input bound to an optional numeric field. */
function NumberField(props) {
    return _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: props.label }), _jsx("input", { className: css.input, type: 'number', min: props.min, value: numberOf(props.value), onChange: event => { props.onChange(toNumber(event.target.value)); } })] });
}
function withProvider(spec, provider) {
    return provider === '' ? stripKey({ ...spec }, 'provider') : { ...spec, provider };
}
function withModel(spec, model) {
    return model === '' ? stripKey({ ...spec }, 'model') : { ...spec, model };
}
function withNumber(spec, key, value) {
    return value === undefined ? stripKey({ ...spec }, key) : { ...spec, [key]: value };
}
function withToolFilter(spec, key, value) {
    const items = value.split('\n').map(line => line.trim()).filter(line => line !== '');
    const current = spec.toolFilter;
    const next = items.length === 0
        ? { ...(current ?? {}), [key]: undefined }
        : { ...(current ?? {}), [key]: items };
    const allow = next.allow;
    const deny = next.deny;
    if (allow === undefined && deny === undefined)
        return stripKey({ ...spec }, 'toolFilter');
    return { ...spec, toolFilter: { ...(allow === undefined ? {} : { allow }), ...(deny === undefined ? {} : { deny }) } };
}
function stripFallback(retry) {
    const { fallbackModel: _fallbackModel, ...rest } = retry;
    return rest;
}
function withLoopMode(spec, mode) {
    const { itemsExpr: _i, count: _c, condition: _d, ...rest } = spec;
    return mode === 'count' ? { ...rest, mode, count: 2 } : { ...rest, mode };
}
function withLoopParam(spec, key, value) {
    return value === '' ? stripKey({ ...spec }, key) : { ...spec, [key]: value };
}
function stripLoopParam(spec) {
    const { count: _count, ...rest } = spec;
    return rest;
}
function stripQuorum(spec) {
    const { quorum: _quorum, ...rest } = spec;
    return rest;
}
/** Copy without one optional key, for exactOptionalPropertyTypes safety. */
function stripKey(spec, key) {
    const copy = { ...spec };
    delete copy[key];
    return copy;
}
/**
 * One-off dry-run probe for an agent node: user input, a trigger, and the
 * settled result (output or failure) without saving or journaling a run.
 */
function DryRunSection(props) {
    const { spec, dryRun, t } = props;
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const run = async () => {
        setBusy(true);
        setError(null);
        setResult(null);
        try {
            const response = await dryRun.dryRunNode({ node: spec, input });
            if (!response.ok) {
                setError(response.message ?? 'request failed');
            }
            else if (response.value !== undefined) {
                setResult(response.value);
            }
        }
        finally {
            setBusy(false);
        }
    };
    return _jsxs("div", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('dryRunTitle') }), _jsx("textarea", { className: css.textarea, rows: 2, value: input, placeholder: t('dryRunInputPlaceholder'), onChange: event => { setInput(event.target.value); } }), _jsx(Button, { variant: 'outline', disabled: busy, onClick: () => { void run(); }, children: busy ? t('dryRunRunning') : t('dryRunStart') }), error !== null && _jsx("p", { className: css.dryRunError, children: error }), result?.outcome === 'completed' && _jsxs("div", { className: css.dryRunOutput, children: [_jsxs("p", { className: css.dryRunMeta, children: [t('dryRunDuration'), ": ", result.durationMs, "ms", result.usage !== undefined ? ` · ${result.usage.inputTokens + result.usage.outputTokens} tokens` : ''] }), _jsx("pre", { className: css.dryRunPre, children: result.output })] }), result?.outcome === 'failed' && _jsx("div", { className: css.dryRunOutput, children: _jsxs("p", { className: css.dryRunError, children: [t('dryRunFailed'), ": ", result.message, " (\u00D7", result.attempts, ")"] }) })] });
}
/** Library-copy spec from an agent node spec, dropping canvas-local fields. */
function librarySpecOf(spec) {
    const { kind, systemPrompt, provider, model, toolFilter, permissionPreset, contextBudgetTokens, timeoutMs } = spec;
    const { maxAttempts, backoffMs, fallbackModel } = spec.retry;
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
    };
}
/** Save-the-current-agent form: name the entry and store a spec copy. */
function SaveToLibrarySection(props) {
    const { spec, library, t } = props;
    const [name, setName] = useState(spec.name);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const save = async () => {
        if (busy || name.trim() === '')
            return;
        setBusy(true);
        setError(null);
        try {
            const response = await library.createLibraryAgent({ name: name.trim(), spec: librarySpecOf(spec) });
            if (!response.ok)
                setError(t('librarySaveFailed'));
        }
        finally {
            setBusy(false);
        }
    };
    return _jsxs("div", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('libraryTitle') }), _jsx("input", { className: css.input, value: name, placeholder: t('libraryNamePrompt'), onChange: event => { setName(event.target.value); } }), _jsx(Button, { variant: 'outline', disabled: busy, onClick: () => { void save(); }, children: t('librarySave') }), error !== null && _jsx("p", { className: css.dryRunError, children: error })] });
}
//# sourceMappingURL=NodeInspector.js.map