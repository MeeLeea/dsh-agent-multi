import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The agent-multi main panel: the workflow list, the canvas editor, and the
 * run panel. The page owns view routing and list loading; editing and run
 * observation live in their own components.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, IconPlusOutlineRegular, IconTrashOutlineRegular, } from '@deepseek-ai/dsh-client-ui-primitives';
import { RunPanel } from "./RunPanel.js";
import { WorkflowEditor } from "./WorkflowEditor.js";
import css from './WorkflowPage.module.css';
/** Default new-workflow draft: input → one agent → output. */
function newDraft(name) {
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
    };
}
/**
 * Render the workflow list, editor, or run panel.
 * @param props - framework props, injected actions, and localized copy.
 * @returns the panel contents.
 */
export function WorkflowPage(props) {
    const { createWorkflow, listWorkflows, deleteWorkflow, getWorkflow, exportWorkflow, importWorkflow, t } = props;
    const [view, setView] = useState({ kind: 'list' });
    const [workflows, setWorkflows] = useState(null);
    const [error, setError] = useState(null);
    const [importText, setImportText] = useState(null);
    const [keepId, setKeepId] = useState(false);
    useEffect(() => {
        let cancelled = false;
        listWorkflows().then(result => {
            if (cancelled)
                return;
            if (result.ok)
                setWorkflows([...result.value].sort((a, b) => a.name.localeCompare(b.name)));
            else
                setError(t('loadFailed'));
        });
        return () => { cancelled = true; };
    }, [listWorkflows, t]);
    const openEditor = useCallback(async (id) => {
        const result = await getWorkflow({ id });
        if (result.ok && result.value.outcome === 'found') {
            setView({ kind: 'edit', target: { definition: result.value.definition } });
        }
        else {
            setError(t('loadFailed'));
        }
    }, [getWorkflow, t]);
    const onCreate = useCallback(async () => {
        const draft = newDraft(t('draftName'));
        const result = await createWorkflow(draft);
        if (result.ok && result.value.outcome === 'created') {
            setView({ kind: 'edit', target: { definition: result.value.definition } });
        }
        else if (result.ok && result.value.outcome === 'invalid') {
            setError(result.value.errors.map(entry => entry.message).join('; '));
        }
    }, [createWorkflow, t]);
    const onDelete = useCallback(async (id) => {
        if (!window.confirm(t('deleteConfirm')))
            return;
        const result = await deleteWorkflow({ id });
        if (result.ok && result.value.outcome === 'deleted') {
            setWorkflows(current => current?.filter(entry => entry.id !== id) ?? null);
        }
    }, [deleteWorkflow, t]);
    const onExport = useCallback(async (id) => {
        const result = await exportWorkflow({ id });
        if (!result.ok || result.value.outcome === 'missing') {
            setError(t('exportFailed'));
            return;
        }
        const exported = result.value.document;
        if (exported === undefined) {
            setError(t('exportFailed'));
            return;
        }
        const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = window.document.createElement('a');
        anchor.href = url;
        anchor.download = `${exported.definition.name}.agent-multi.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    }, [exportWorkflow, t]);
    const onImport = useCallback(async () => {
        if (importText === null)
            return;
        let imported;
        try {
            imported = JSON.parse(importText);
        }
        catch {
            setError(t('importInvalid'));
            return;
        }
        const result = await importWorkflow({ document: imported, ...(keepId ? { keepId } : {}) });
        if (!result.ok) {
            setError(t('importFailed'));
            return;
        }
        if (result.value.outcome === 'created') {
            setImportText(null);
            setError(null);
            void refresh();
        }
        else {
            setError(result.value.errors.map(entry => entry.message).join('; '));
        }
    }, [importText, keepId, importWorkflow, t]);
    if (view.kind === 'edit') {
        return _jsx(WorkflowEditor, { target: view.target, actions: props, onExit: () => { setView({ kind: 'list' }); void refresh(); }, onRun: (workflowId, name) => { setView({ kind: 'run', target: { workflowId, name } }); } });
    }
    if (view.kind === 'run') {
        return _jsx(RunPanel, { target: view.target, actions: props, onExit: () => setView({ kind: 'list' }) });
    }
    function refresh() {
        return listWorkflows().then(result => {
            if (result.ok)
                setWorkflows([...result.value].sort((a, b) => a.name.localeCompare(b.name)));
        });
    }
    return _jsxs("section", { className: css.page, children: [_jsxs("header", { className: css.header, children: [_jsx("h2", { className: css.title, children: t('listTitle') }), _jsx(Button, { onClick: () => { setImportText(importText === null ? '' : null); }, children: t('importAction') }), _jsxs(Button, { variant: 'primary', onClick: () => { void onCreate(); }, children: [_jsx(IconPlusOutlineRegular, { size: 14 }), t('create')] })] }), error !== null && _jsx("p", { className: css.error, children: error }), importText !== null && _jsxs("div", { className: css.importBox, children: [_jsx("span", { className: css.sectionTitle, children: t('importTitle') }), _jsx("textarea", { className: css.importText, rows: 5, value: importText, placeholder: t('importHint'), onChange: event => { setImportText(event.target.value); } }), _jsxs("label", { className: css.importKeep, children: [_jsx("input", { type: 'checkbox', checked: keepId, onChange: event => { setKeepId(event.target.checked); } }), t('importKeepId')] }), _jsx(Button, { variant: 'primary', onClick: () => { void onImport(); }, children: t('importAction') })] }), workflows === null
                ? _jsx("p", { className: css.hint, children: t('loadFailed') })
                : workflows.length === 0
                    ? _jsxs("div", { className: css.empty, children: [_jsx("p", { className: css.title, children: t('listEmpty') }), _jsx("p", { className: css.hint, children: t('listEmptyHint') })] })
                    : _jsx("ul", { className: css.list, children: workflows.map(entry => _jsxs("li", { className: css.row, children: [_jsx("span", { className: css.rowName, children: entry.name }), _jsxs("span", { className: css.rowMeta, children: [t('revision'), " ", entry.revision] }), _jsxs("span", { className: css.rowActions, children: [_jsx(Button, { onClick: () => { void openEditor(entry.id); }, children: t('open') }), _jsx(Button, { onClick: () => setView({ kind: 'run', target: { workflowId: entry.id, name: entry.name } }), children: t('run') }), _jsx(Button, { onClick: () => { void onExport(entry.id); }, children: t('export') }), _jsx(Button, { onClick: () => { void onDelete(entry.id); }, children: _jsx(IconTrashOutlineRegular, { size: 14 }) })] })] }, entry.id)) })] });
}
//# sourceMappingURL=WorkflowPage.js.map