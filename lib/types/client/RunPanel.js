import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The run panel: starts a workflow run on user input, then observes the
 * agent-multi journal — status, per-node events, final output, and the
 * terminal failure with resume/cancel controls.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Handle, MarkerType, Position, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, IconChevronLeftOutlineRegular, IconRefreshOutlineRegular, IconStopFillRegular, } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './WorkflowEditor.module.css';
const POLL_INTERVAL_MS = 1000;
const ERROR_CLASS_LABEL = {
    transient: 'errorClassTransient',
    timeout: 'errorClassTimeout',
    deterministic: 'errorClassDeterministic',
    auth: 'errorClassAuth',
};
/**
 * Render the run launcher and live run observation for one workflow.
 * @param props - target workflow, framework copy, injected actions, and exit callback.
 * @returns the run panel.
 */
export function RunPanel(props) {
    const { target, actions, onExit } = props;
    const { startRun, resumeRun, cancelRun, getRun, listRuns, t } = actions;
    const [input, setInput] = useState('');
    const [run, setRun] = useState(null);
    const [history, setHistory] = useState([]);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [definition, setDefinition] = useState(null);
    const refreshRef = useRef();
    useEffect(() => {
        let cancelled = false;
        void actions.getWorkflow({ id: target.workflowId }).then(result => {
            if (cancelled)
                return;
            if (result.ok && result.value.outcome === 'found')
                setDefinition(result.value.definition);
        });
        return () => { cancelled = true; };
    }, [actions, target.workflowId]);
    const refresh = useCallback(async (runId) => {
        const result = await getRun({ runId });
        if (result.ok && result.value.outcome === 'found')
            setRun(result.value.run);
    }, [getRun]);
    refreshRef.current = refresh;
    const refreshHistory = useCallback(async () => {
        const result = await listRuns({ workflowId: target.workflowId });
        if (result.ok)
            setHistory(result.value.runs);
    }, [listRuns, target.workflowId]);
    useEffect(() => {
        void refreshHistory();
    }, [refreshHistory]);
    useEffect(() => {
        if (run === null || run.status !== 'running') {
            void refreshHistory();
            return;
        }
        const timer = setTimeout(() => { void refreshRef.current?.(run.runId); }, POLL_INTERVAL_MS);
        return () => { clearTimeout(timer); };
    }, [run, refreshHistory]);
    const onStart = useCallback(async () => {
        if (input.trim() === '' || busy)
            return;
        setBusy(true);
        try {
            const result = await startRun({ workflowId: target.workflowId, input });
            if (!result.ok) {
                setError(t('runMissing'));
                return;
            }
            const value = result.value;
            if (value.outcome === 'started') {
                setError(null);
                await refresh(value.runId);
            }
            else {
                setError(t('runMissing'));
            }
        }
        finally {
            setBusy(false);
        }
    }, [input, busy, startRun, target.workflowId, refresh, t]);
    const onResume = useCallback(async () => {
        if (run === null || busy)
            return;
        setBusy(true);
        try {
            const result = await resumeRun({ runId: run.runId });
            if (!result.ok) {
                setError(t('runMissing'));
                return;
            }
            const value = result.value;
            if (value.outcome === 'started' || value.outcome === 'running')
                await refresh(run.runId);
            else
                setError(t('runMissing'));
        }
        finally {
            setBusy(false);
        }
    }, [run, busy, resumeRun, refresh, t]);
    const onCancel = useCallback(async () => {
        if (run === null || busy)
            return;
        setBusy(true);
        try {
            await cancelRun({ runId: run.runId });
            await refresh(run.runId);
        }
        finally {
            setBusy(false);
        }
    }, [run, busy, cancelRun, refresh]);
    const statusLabel = (status) => status === 'running' ? t('statusRunning')
        : status === 'completed' ? t('statusCompleted')
            : status === 'failed' ? t('statusFailed')
                : t('statusCancelled');
    return _jsxs("section", { className: css.page, children: [_jsxs("header", { className: css.header, children: [_jsxs(Button, { onClick: onExit, children: [_jsx(IconChevronLeftOutlineRegular, { size: 14 }), t('back')] }), _jsx("h2", { className: css.title, children: target.name }), run !== null && _jsx("span", { className: css.runStatus, children: statusLabel(run.status) }), run !== null && _jsxs(Button, { onClick: () => { void refreshRef.current?.(run.runId); }, children: [_jsx(IconRefreshOutlineRegular, { size: 14 }), t('runRefresh')] }), run?.status === 'running' && _jsxs(Button, { onClick: () => { void onCancel(); }, children: [_jsx(IconStopFillRegular, { size: 14 }), t('runCancel')] }), run?.status === 'failed' && _jsx(Button, { variant: 'primary', onClick: () => { void onResume(); }, children: t('runRetryHint') })] }), error !== null && _jsx("p", { className: css.error, children: error }), _jsx(TriggerPanel, { workflowId: target.workflowId, actions: actions }), run === null
                ? _jsxs("div", { className: css.runBar, children: [_jsx("textarea", { className: css.runInput, rows: 3, value: input, placeholder: t('runInput'), onChange: event => { setInput(event.target.value); } }), _jsx(Button, { variant: 'primary', disabled: busy, onClick: () => { void onStart(); }, children: t('runStart') })] })
                : _jsxs("div", { className: css.runBody, children: [run.nodes.length > 0 && _jsx("div", { className: css.runNodes, children: run.nodes.map(node => _jsx(NodeCard, { node: node, t: t }, node.nodeId)) }), definition !== null && run.nodes.length > 0 && _jsx("div", { className: css.runCanvas, children: _jsx(RunCanvas, { definition: definition, nodes: run.nodes, ...(run.hitl !== undefined ? { hitlNodeId: run.hitl.nodeId } : {}) }) }), run.hitl !== undefined && _jsx(HitlCard, { hitl: run.hitl, t: t }), run.output !== undefined && _jsx("div", { className: css.runOutput, children: run.output }), run.failure !== undefined && _jsxs("div", { className: css.runFailure, children: [t('runFailure'), ": ", run.failure.nodeId, " \u00B7 ", t(ERROR_CLASS_LABEL[run.failure.errorClass]), " \u00B7 ", run.failure.message, " \u00B7 ", run.failure.attempts] }), _jsx("p", { className: css.sectionTitle, children: t('runEvents') }), _jsx("div", { className: css.runEvents, children: run.events.map((event, index) => _jsxs("div", { className: css.eventRow, children: [event.type.replace('agent-multi/', ''), eventText(event.data)] }, index)) }), history.length > 0 && _jsxs("div", { className: css.runNodes, children: [_jsx("p", { className: css.sectionTitle, children: t('runHistory') }), history.map(summary => _jsx("button", { type: 'button', className: `${css.nodeCard} ${summary.status === 'failed' ? css.nodeCardFailed : css.nodeCardCompleted}`, onClick: () => { void refresh(summary.runId); }, children: _jsxs("span", { className: css.nodeMeta, children: [statusLabel(summary.status), " \u00B7 ", summary.runId.slice(0, 8), summary.failure !== undefined ? ` · ${t(ERROR_CLASS_LABEL[summary.failure.errorClass])}` : ''] }) }, summary.runId))] })] })] });
}
/** One kanban card: node identity, live status, output preview, usage, failure. */
function NodeCard(props) {
    const { node, t } = props;
    const statusClass = node.status === 'running' ? css.nodeCardRunning
        : node.status === 'completed' ? css.nodeCardCompleted : css.nodeCardFailed;
    const statusLabel = node.status === 'running' ? t('nodeRunning')
        : node.status === 'completed' ? t('nodeCompleted') : t('nodeFailed');
    const meta = [`${node.nodeKind} · ${statusLabel} · #${node.attempt}`];
    if (node.durationMs !== undefined)
        meta.push(`${node.durationMs}ms`);
    if (node.usage !== undefined) {
        meta.push(`tokens ${node.usage.inputTokens + node.usage.outputTokens} (${node.usage.inputTokens} in / ${node.usage.outputTokens} out)`);
    }
    if (node.errorClass !== undefined && node.errorClass in ERROR_CLASS_LABEL) {
        meta.push(t(ERROR_CLASS_LABEL[node.errorClass]));
    }
    if (node.attempts !== undefined && node.status === 'failed')
        meta.push(`${node.attempts} ${t('runAttempts')}`);
    const preview = node.status === 'running' ? node.streaming : node.output;
    return _jsxs("div", { className: `${css.nodeCard} ${statusClass}`, children: [_jsxs("div", { className: css.nodeHead, children: [_jsx("span", { className: css.nodeName, children: node.nodeId }), _jsx("span", { className: css.nodeStatus, children: statusLabel })] }), _jsx("span", { className: css.nodeMeta, children: meta.join(' · ') }), node.message !== undefined && _jsx("div", { className: css.nodeOutput, children: node.message }), preview !== undefined && preview !== '' && _jsx("div", { className: css.nodeOutput, children: preview })] });
}
/** HITL card: the open question awaiting an answer, or the recorded answer. */
function HitlCard(props) {
    const { hitl, t } = props;
    return _jsxs("div", { className: css.hitlCard, children: [_jsxs("span", { className: css.hitlQuestion, children: [t('hitlOpen'), " \u00B7 ", hitl.nodeId] }), _jsx("span", { children: hitl.question }), hitl.answer !== undefined
                ? _jsxs("span", { className: css.hitlAnswer, children: [t('hitlAnswered'), ": ", hitl.answer] })
                : null] });
}
/** Short one-line summary of one journal event payload. */
function eventText(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data))
        return '';
    const summary = [];
    const record = data;
    for (const key of ['nodeId', 'nodeKind', 'attempt', 'errorClass', 'message', 'reason', 'mode', 'outcome', 'stopReason', 'answer', 'question', 'durationMs', 'prompt', 'delta', 'output', 'payload']) {
        if (key in record) {
            const value = record[key];
            if (value === undefined || value === null)
                continue;
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            summary.push(`${key}=${truncate(text)}`);
        }
    }
    return summary.join(' ');
}
function truncate(text) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}
/** One status-ring canvas card mirroring the editor card shape. */
function RunCanvasCard({ data }) {
    const { spec, state } = data;
    return _jsxs("div", { className: `${css.card} ${css[spec.kind]} ${state === undefined ? '' : css[`ring${state}`]}`, children: [spec.kind !== 'note' && _jsx(Handle, { type: 'target', position: Position.Left, id: 'in' }), _jsx("span", { className: css.cardGlyph, children: spec.name })] });
}
const runCanvasNodeTypes = { agentMulti: RunCanvasCard };
/** Read-only mini canvas: workflow graph with a status ring per live node. */
function RunCanvas(props) {
    const { definition, nodes, hitlNodeId } = props;
    const flow = useMemo(() => {
        const stateOf = new Map(nodes.map(node => [node.nodeId, node.status]));
        const flowNodes = definition.nodes.map(spec => {
            const state = stateOf.get(spec.id);
            return {
                id: spec.id,
                type: 'agentMulti',
                position: spec.position ?? { x: 0, y: 0 },
                data: { spec, ...(state === undefined ? {} : { state }) },
            };
        });
        const flowEdges = definition.edges.map(edge => ({
            id: edge.id, source: edge.from, target: edge.to,
            sourceHandle: edge.fromHandle ?? 'out',
            ...(edge.toHandle === undefined ? {} : { targetHandle: edge.toHandle }),
            markerEnd: { type: MarkerType.ArrowClosed },
        }));
        return { flowNodes, flowEdges };
    }, [definition, nodes, hitlNodeId]);
    return _jsx(ReactFlow, { nodes: flow.flowNodes, edges: flow.flowEdges, nodeTypes: runCanvasNodeTypes, fitView: true, nodesDraggable: false, nodesConnectable: false, elementsSelectable: false, children: _jsx(Background, {}) });
}
/** Workflow-scoped scheduled triggers: list plus create/enable/delete form. */
function TriggerPanel(props) {
    const { workflowId, actions } = props;
    const { createTrigger, setTriggerEnabled, deleteTrigger, listTriggers, t } = actions;
    const [triggers, setTriggers] = useState(null);
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState('cron');
    const [expression, setExpression] = useState('');
    const [time, setTime] = useState('09:00:00');
    const [weekdays, setWeekdays] = useState('1');
    const [timeZone, setTimeZone] = useState('');
    const [input, setInput] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const refresh = useCallback(async () => {
        const result = await listTriggers({ workflowId });
        if (result.ok)
            setTriggers(result.value.triggers);
    }, [listTriggers, workflowId]);
    useEffect(() => { void refresh(); }, [refresh]);
    const onCreate = useCallback(async () => {
        if (busy)
            return;
        const trimmedZone = timeZone.trim();
        const timing = kind === 'cron'
            ? { kind: 'cron', expression: expression.trim(), timeZone: trimmedZone === '' ? 'UTC' : trimmedZone }
            : kind === 'daily'
                ? { kind: 'daily', time, timeZone: trimmedZone === '' ? 'UTC' : trimmedZone }
                : { kind: 'weekly', time, timeZone: trimmedZone === '' ? 'UTC' : trimmedZone, weekdays: weekdays.split(',').map(part => Number.parseInt(part.trim(), 10)).filter(day => day >= 1 && day <= 7) };
        setBusy(true);
        try {
            const result = await createTrigger({ workflowId, timing, input });
            if (!result.ok || result.value.outcome !== 'created') {
                setError(t('triggerCreateFailed'));
                return;
            }
            setError(null);
            setOpen(false);
            setInput('');
            await refresh();
        }
        finally {
            setBusy(false);
        }
    }, [busy, kind, expression, time, weekdays, timeZone, input, createTrigger, workflowId, refresh, t]);
    const onToggle = useCallback(async (entry, enabled) => {
        await setTriggerEnabled({ id: entry.id, enabled });
        await refresh();
    }, [setTriggerEnabled, refresh]);
    const onDelete = useCallback(async (entry) => {
        if (!window.confirm(t('deleteConfirm')))
            return;
        await deleteTrigger({ id: entry.id });
        await refresh();
    }, [deleteTrigger, refresh, t]);
    const timingLabel = (timing) => timing.kind === 'cron'
        ? `${timing.expression} (${timing.timeZone})`
        : timing.kind === 'daily'
            ? `${t('timingDaily')} ${timing.time} (${timing.timeZone})`
            : `${t('timingWeekly')} ${timing.weekdays.join(',')} ${timing.time} (${timing.timeZone})`;
    return _jsxs("div", { className: css.triggerPanel, children: [_jsx("p", { className: css.sectionTitle, children: t('triggersTitle') }), triggers === null
                ? _jsx("span", { className: css.triggerMeta, children: t('triggersEmpty') })
                : triggers.length === 0
                    ? _jsx("span", { className: css.triggerMeta, children: t('triggersEmpty') })
                    : triggers.map(entry => _jsxs("div", { className: css.triggerRow, children: [_jsx("span", { className: css.triggerTiming, children: timingLabel(entry.timing) }), _jsxs("span", { className: css.triggerMeta, children: [entry.enabled ? t('triggerEnabled') : t('triggerDisabled'), ` · ${t('triggerNext')} ${entry.scheduledAt}`, entry.lastRunId !== undefined ? ` · ${t('triggerLastRun')} ${entry.lastRunId.slice(0, 8)}` : ''] }), _jsxs("span", { className: css.rowActions, children: [_jsx(Button, { onClick: () => { void onToggle(entry, !entry.enabled); }, children: entry.enabled ? t('triggerDisabled') : t('triggerEnabled') }), _jsx(Button, { onClick: () => { void onDelete(entry); }, children: t('triggerDelete') })] })] }, entry.id)), error !== null && _jsx("p", { className: css.error, children: error }), !open
                ? _jsx(Button, { onClick: () => { setOpen(true); }, children: t('triggerCreate') })
                : _jsxs("div", { className: css.triggerForm, children: [_jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('triggerTimingKind') }), _jsxs("select", { className: css.select, value: kind, onChange: event => { setKind(event.target.value); }, children: [_jsx("option", { value: 'cron', children: t('timingCron') }), _jsx("option", { value: 'daily', children: t('timingDaily') }), _jsx("option", { value: 'weekly', children: t('timingWeekly') })] })] }), kind === 'cron' && _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('triggerCron') }), _jsx("input", { className: css.input, value: expression, placeholder: '*/10 * * * *', onChange: event => { setExpression(event.target.value); } })] }), (kind === 'daily' || kind === 'weekly') && _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: kind === 'daily' ? t('triggerDailyTime') : t('triggerWeeklyTime') }), _jsx("input", { className: css.input, value: time, placeholder: '09:00:00', onChange: event => { setTime(event.target.value); } })] }), kind === 'weekly' && _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('triggerWeekdays') }), _jsx("input", { className: css.input, value: weekdays, placeholder: '1,3,5', onChange: event => { setWeekdays(event.target.value); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('triggerTimeZone') }), _jsx("input", { className: css.input, value: timeZone, placeholder: 'UTC', onChange: event => { setTimeZone(event.target.value); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('triggerInput') }), _jsx("textarea", { className: css.textarea, rows: 2, value: input, onChange: event => { setInput(event.target.value); } })] }), _jsxs("span", { className: css.rowActions, children: [_jsx(Button, { onClick: () => { setOpen(false); }, children: t('runClose') }), _jsx(Button, { variant: 'primary', disabled: busy, onClick: () => { void onCreate(); }, children: t('triggerCreate') })] })] })] });
}
//# sourceMappingURL=RunPanel.js.map