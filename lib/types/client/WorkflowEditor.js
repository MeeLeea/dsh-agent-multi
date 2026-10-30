import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * The workflow canvas editor: a React Flow graph over the workflow draft with
 * a node palette, a per-kind inspector for the selected node or edge, and
 * save/validate actions against the stored definition.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useEdgesState, useNodesState, } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, IconChevronLeftOutlineRegular, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { NodeInspector } from "./NodeInspector.js";
import css from './WorkflowEditor.module.css';
const KINDS = ['input', 'agent', 'router', 'join', 'loop', 'output', 'note'];
const KIND_LABEL = {
    input: 'kindInput',
    agent: 'kindAgent',
    router: 'kindRouter',
    join: 'kindJoin',
    loop: 'kindLoop',
    output: 'kindOutput',
    note: 'kindNote',
};
function kindGlyph(kind) {
    return kind === 'agent' ? '⬡' : kind === 'input' ? '→' : kind === 'output' ? '⏹' : kind === 'router' ? '⑃'
        : kind === 'join' ? '⨯' : kind === 'loop' ? '↻' : '✎';
}
/** Render one workflow node card with its per-kind handles. */
function AgentMultiCard({ data, selected }) {
    const { spec } = data;
    return _jsxs("div", { className: `${css.card} ${css[spec.kind]} ${selected === true ? css.cardSelected : ''}`, children: [spec.kind !== 'note' && _jsx(Handle, { type: 'target', position: Position.Left, id: 'in' }), spec.kind === 'loop' && _jsx(Handle, { type: 'target', position: Position.Top, id: 'back', className: css.backHandle }), _jsx("span", { className: css.cardGlyph, children: kindGlyph(spec.kind) }), _jsx("span", { className: css.cardKind, children: spec.kind }), _jsx("span", { className: css.cardName, children: spec.name }), spec.kind === 'input' || spec.kind === 'agent' || spec.kind === 'join'
                ? _jsx(Handle, { type: 'source', position: Position.Right, id: 'out' })
                : spec.kind === 'loop'
                    ? _jsxs(_Fragment, { children: [_jsx(Handle, { type: 'source', position: Position.Right, id: 'iterate', style: { top: '30%' } }), _jsx(Handle, { type: 'source', position: Position.Right, id: 'done', style: { top: '70%' } })] })
                    : spec.kind === 'router'
                        ? _jsxs(_Fragment, { children: [spec.cases.map((label, index) => (_jsx(Handle, { type: 'source', position: Position.Right, id: label, style: { top: `${(index + 1) * (100 / (spec.cases.length + 1))}%` } }, label))), _jsx(Handle, { type: 'source', position: Position.Right, id: 'default', style: { top: `${(spec.cases.length + 1) * (100 / (spec.cases.length + 2))}%` } })] })
                        : undefined] });
}
const nodeTypes = { agentMulti: AgentMultiCard };
function toFlow(definition) {
    const nodes = definition.nodes.map((spec, index) => ({
        id: spec.id,
        type: 'agentMulti',
        position: spec.position ?? { x: 120 + (index % 4) * 220, y: 100 + Math.floor(index / 4) * 180 },
        data: { spec },
    }));
    const edges = definition.edges.map(edge => ({
        id: edge.id,
        source: edge.from,
        sourceHandle: edge.fromHandle ?? 'out',
        target: edge.to,
        ...(edge.toHandle === undefined ? {} : { targetHandle: edge.toHandle }),
        label: edge.format,
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { spec: edge },
    }));
    return { nodes, edges };
}
/**
 * Render the canvas editor with palette, inspector, and save/validate bar.
 * @param props - target definition, framework copy, injected actions, exit and run callbacks.
 * @returns the editor layout.
 */
export function WorkflowEditor(props) {
    const { target, actions, onExit, onRun } = props;
    const { saveWorkflow, validateWorkflow, listLibraryAgents, listModelCatalog, t } = actions;
    const initial = useMemo(() => toFlow(target.definition), [target.definition]);
    const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
    const [selection, setSelection] = useState(null);
    const [name, setName] = useState(target.definition.name);
    const [issues, setIssues] = useState(null);
    const [notice, setNotice] = useState(null);
    const [dirty, setDirty] = useState(false);
    const [library, setLibrary] = useState([]);
    const [modelCatalog, setModelCatalog] = useState(null);
    useEffect(() => {
        let cancelled = false;
        void listLibraryAgents().then(result => {
            if (cancelled)
                return;
            if (result.ok)
                setLibrary(result.value);
        });
        return () => { cancelled = true; };
    }, [listLibraryAgents]);
    useEffect(() => {
        let cancelled = false;
        void listModelCatalog().then(result => {
            if (cancelled)
                return;
            if (result.ok)
                setModelCatalog(result.value);
        });
        return () => { cancelled = true; };
    }, [listModelCatalog]);
    const markDirty = useCallback(() => { setDirty(true); setIssues(null); }, []);
    const onConnect = useCallback((connection) => {
        setEdges(current => [...current, {
                id: `e${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
                source: connection.source,
                sourceHandle: connection.sourceHandle ?? 'out',
                target: connection.target,
                ...(connection.targetHandle === 'back' ? { targetHandle: 'back' } : {}),
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
                        ...(connection.targetHandle === 'back' ? { toHandle: 'back' } : {}),
                        format: 'text',
                        inContext: true,
                    },
                },
            }]);
        markDirty();
    }, [setEdges, markDirty]);
    const onNodeClick = useCallback(() => { setSelection(null); }, []);
    const onEdgeClick = useCallback((_event, edge) => { setSelection({ kind: 'edge', id: edge.id }); }, []);
    const addNode = useCallback((kind) => {
        const index = nodes.length + 1;
        const id = `${kind}${index}`;
        const base = { id, name: `${kind} ${index}`, position: { x: 120 + (index % 4) * 220, y: 100 + Math.floor(index / 4) * 180 } };
        const spec = kind === 'input' ? { kind, ...base }
            : kind === 'agent' ? { kind, ...base, systemPrompt: '', retry: { maxAttempts: 1, backoffMs: 0 }, hitlEnabled: false }
                : kind === 'router' ? { kind, ...base, cases: ['yes'] }
                    : kind === 'join' ? { kind, ...base, strategy: 'all' }
                        : kind === 'loop' ? { kind, ...base, mode: 'count', count: 2, maxIters: 8, collect: true }
                            : kind === 'output' ? { kind, ...base }
                                : { kind, ...base, text: '' };
        setNodes(current => [...current, { id, type: 'agentMulti', position: base.position, data: { spec } }]);
        setSelection({ kind: 'node', id });
        markDirty();
    }, [nodes.length, setNodes, markDirty]);
    /** Insert a library agent as a fresh canvas node carrying a spec copy. */
    const insertLibraryAgent = useCallback((entry) => {
        const index = nodes.length + 1;
        const id = `agent${index}`;
        const position = { x: 120 + (index % 4) * 220, y: 100 + Math.floor(index / 4) * 180 };
        const spec = {
            id, name: entry.name,
            ...libraryNodeFields(entry.spec),
            position,
        };
        setNodes(current => [...current, { id, type: 'agentMulti', position, data: { spec } }]);
        setSelection({ kind: 'node', id });
        markDirty();
    }, [nodes.length, setNodes, markDirty]);
    const updateSpec = useCallback((id, next) => {
        setNodes(current => current.map(node => node.id === id ? { ...node, data: { spec: next } } : node));
        markDirty();
    }, [setNodes, markDirty]);
    const deleteNode = useCallback((id) => {
        setNodes(current => current.filter(node => node.id !== id));
        setEdges(current => current.filter(edge => edge.source !== id && edge.target !== id));
        setSelection(null);
        markDirty();
    }, [setNodes, setEdges, markDirty]);
    const updateEdgeSpec = useCallback((id, next) => {
        setEdges(current => current.map(edge => edge.id === id
            ? { ...edge, label: next.format, data: { spec: next } }
            : edge));
        markDirty();
    }, [setEdges, markDirty]);
    const deleteEdge = useCallback((id) => {
        setEdges(current => current.filter(edge => edge.id !== id));
        setSelection(null);
        markDirty();
    }, [setEdges, markDirty]);
    const buildDraft = useCallback(() => ({
        name,
        nodes: nodes.map(node => ({ ...node.data.spec, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } })),
        edges: edges.map(edge => edge.data?.spec),
    }), [name, nodes, edges]);
    const onSave = useCallback(async () => {
        const result = await saveWorkflow({ id: target.definition.id, draft: buildDraft(), expectedRevision: target.definition.revision });
        if (!result.ok) {
            setNotice(t('saveFailed'));
            return;
        }
        const value = result.value;
        if (value.outcome === 'saved') {
            setDirty(false);
            setIssues(null);
            setNotice(null);
        }
        else if (value.outcome === 'conflict') {
            setNotice(t('saveConflict'));
        }
        else if (value.outcome === 'invalid') {
            setIssues(value.errors);
        }
    }, [saveWorkflow, target.definition, buildDraft, t]);
    const onValidate = useCallback(async () => {
        const result = await validateWorkflow({ draft: buildDraft() });
        if (result.ok)
            setIssues(result.value.errors);
    }, [validateWorkflow, buildDraft]);
    const selectedNode = selection?.kind === 'node' ? nodes.find(node => node.id === selection.id) : undefined;
    const selectedEdge = selection?.kind === 'edge' ? edges.find(edge => edge.id === selection.id) : undefined;
    return _jsxs("section", { className: css.editor, children: [_jsxs("header", { className: css.toolbar, children: [_jsxs(Button, { onClick: onExit, children: [_jsx(IconChevronLeftOutlineRegular, { size: 14 }), t('back')] }), _jsx("input", { className: css.nameInput, value: name, "aria-label": t('nodeName'), onChange: event => { setName(event.target.value); markDirty(); } }), _jsxs("span", { className: css.revision, children: [t('revision'), " ", target.definition.revision, dirty ? ` · ${t('unsaved')}` : ''] }), _jsx(Button, { onClick: () => { void onValidate(); }, children: t('validate') }), _jsx(Button, { variant: 'primary', onClick: () => { void onSave(); }, children: t('save') }), _jsxs(Button, { onClick: () => onRun(target.definition.id, target.definition.name), children: [_jsx(IconPlayOutlineRegular, { size: 14 }), t('run')] })] }), notice !== null && _jsx("p", { className: css.error, children: notice }), issues !== null && issues.length > 0 && _jsx("ul", { className: css.issues, children: issues.map((issue, index) => _jsx("li", { className: css.issueItem, children: issue.message }, index)) }), _jsxs("div", { className: css.body, children: [_jsxs("div", { className: css.palette, children: [_jsx("span", { className: css.paletteTitle, children: t('palette') }), KINDS.map(kind => (_jsxs(Button, { onClick: () => addNode(kind), children: [_jsx("span", { className: css.paletteGlyph, children: kindGlyph(kind) }), t(KIND_LABEL[kind])] }, kind))), library.length > 0 && _jsxs(_Fragment, { children: [_jsx("span", { className: css.paletteTitle, children: t('libraryTitle') }), library.map(entry => (_jsxs(Button, { onClick: () => insertLibraryAgent(entry), children: [_jsx("span", { className: css.paletteGlyph, children: kindGlyph('agent') }), entry.name] }, entry.id)))] })] }), _jsx("div", { className: css.canvasWrap, children: _jsxs(ReactFlow, { nodes: nodes, edges: edges, nodeTypes: nodeTypes, onNodesChange: changes => { onNodesChange(changes); if (changes.some(change => change.type !== 'select' && change.type !== 'dimensions'))
                                markDirty(); }, onEdgesChange: changes => { onEdgesChange(changes); if (changes.some(change => change.type === 'remove'))
                                markDirty(); }, onConnect: onConnect, onNodeClick: onNodeClick, onEdgeClick: onEdgeClick, onNodeDoubleClick: (_event, node) => { setSelection({ kind: 'node', id: node.id }); }, fitView: true, children: [_jsx(Background, {}), _jsx(Controls, {})] }) }), _jsx("aside", { className: css.inspector, children: selectedNode !== undefined
                            ? _jsx(NodeInspector, { spec: selectedNode.data?.spec, onChange: next => { updateSpec(selectedNode.id, next); }, onDelete: () => { deleteNode(selectedNode.id); }, dryRun: actions, library: actions, labels: actions, catalog: modelCatalog === null ? undefined : { load: () => Promise.resolve({ ok: true, value: modelCatalog }) } })
                            : selectedEdge !== undefined
                                ? _jsx(EdgeInspector, { spec: selectedEdge.data?.spec, onChange: next => { updateEdgeSpec(selectedEdge.id, next); }, onDelete: () => { deleteEdge(selectedEdge.id); }, labels: actions })
                                : _jsx("p", { className: css.hint, children: t('noSelection') }) })] })] });
}
/** Edge-format choice for the selected connection. */
function EdgeInspector(props) {
    const { spec, onChange, onDelete, labels } = props;
    const { t } = labels;
    const formats = ['json', 'md', 'text'];
    return _jsxs("div", { className: css.inspectorBody, children: [_jsx("h3", { className: css.inspectorTitle, children: t('selectedEdge') }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('edgeFormat') }), _jsx("select", { className: css.select, value: spec.format, onChange: event => { onChange({ ...spec, format: event.target.value }); }, children: formats.map(format => _jsx("option", { value: format, children: format }, format)) })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('edgeInContext') }), _jsx("input", { type: 'checkbox', checked: spec.inContext, onChange: event => { onChange({ ...spec, inContext: event.target.checked }); } })] }), _jsxs("label", { className: css.field, children: [_jsx("span", { className: css.fieldLabel, children: t('edgeTemplate') }), _jsx("input", { className: css.input, value: spec.template ?? '', placeholder: t('edgeTemplateHint'), onChange: event => {
                            const template = event.target.value;
                            onChange(template === '' ? { ...stripTemplate(spec) } : { ...spec, template });
                        } })] }), _jsx(Button, { onClick: onDelete, children: t('edgeDelete') })] });
}
/** Copy of the spec without a template entry, for exactOptionalPropertyTypes. */
function stripTemplate(spec) {
    const { template: _template, ...rest } = spec;
    return rest;
}
/** Mutable agent-node fields from a library entry, with readonly arrays copied. */
function libraryNodeFields(spec) {
    const { kind, systemPrompt, provider, model, toolFilter, permissionPreset, contextBudgetTokens, timeoutMs, hitlEnabled } = spec;
    const { maxAttempts, backoffMs, fallbackModel } = spec.retry;
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
    };
}
//# sourceMappingURL=WorkflowEditor.js.map