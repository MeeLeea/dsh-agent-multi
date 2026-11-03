import { AgentMultiIcon } from "./AgentMultiIcon.js";
import { WorkflowPage } from "./WorkflowPage.js";
import { NS, en, zh } from "./locales.js";
/** The main-panel key the sidebar row navigates to. */
const PANEL_ID = 'agent-multi';
/** Services used by the agent-multi client UI. */
export const inject = ['remote', 'slots', 'locale'];
/**
 * Bind the workflow actions to the client-module apply context.
 *
 * The Remote namespace is mounted in a sibling fiber under the API gateway, so
 * the composed key `remote.agentMulti` is only visible through the shared
 * reflection store. `ctx.reflect.get` bypasses the context proxy's ancestor-only
 * resolution and returns the namespace service directly.
 * @param ctx - browser services.
 * @returns workflow actions invoking the agent-multi Remote namespace.
 */
function bindActions(ctx) {
    const ns = ctx.reflect.get('remote.agentMulti');
    if (ns === undefined) {
        throw new Error('remote.agentMulti namespace is not mounted');
    }
    return {
        createWorkflow: draft => ns.createWorkflow({ draft }),
        saveWorkflow: request => ns.saveWorkflow(request),
        listWorkflows: () => ns.listWorkflows(),
        getWorkflow: request => ns.getWorkflow(request),
        deleteWorkflow: request => ns.deleteWorkflow(request),
        validateWorkflow: request => ns.validateWorkflow(request),
        startRun: request => ns.startRun(request),
        resumeRun: request => ns.resumeRun(request),
        cancelRun: request => ns.cancelRun(request),
        getRun: request => ns.getRun(request),
        listRuns: request => ns.listRuns(request),
        dryRunNode: request => ns.dryRunNode(request),
        exportWorkflow: request => ns.exportWorkflow(request),
        importWorkflow: request => ns.importWorkflow(request),
        listLibraryAgents: () => ns.listLibraryAgents(),
        createLibraryAgent: request => ns.createLibraryAgent(request),
        saveLibraryAgent: request => ns.saveLibraryAgent(request),
        deleteLibraryAgent: request => ns.deleteLibraryAgent(request),
        createTrigger: request => ns.createTrigger(request),
        setTriggerEnabled: request => ns.setTriggerEnabled(request),
        deleteTrigger: request => ns.deleteTrigger(request),
        listTriggers: request => ns.listTriggers(request),
        listModelCatalog: () => ns.listModelCatalog(),
    };
}
/**
 * Mount the Remote contribution, then register the localized panel surfaces.
 * Disposal withdraws both the Remote namespace and the slot entries.
 * @param ctx - browser services.
 * @param contribution - generated agent-multi Remote contribution.
 * @returns combined disposer.
 */
export async function mount(ctx, contribution) {
    const disposeRemote = await ctx.remote.$mount(contribution);
    const actions = bindActions(ctx);
    try {
        const ui = await ctx.inject(inject, uiCtx => registerUi(uiCtx, actions));
        return async () => {
            await ui.dispose();
            await disposeRemote();
        };
    }
    catch (error) {
        await disposeRemote();
        throw error;
    }
}
/**
 * Register the dictionaries, the workflow panel, and the sidebar icon row.
 * @param ctx - browser services.
 * @param actions - workflow actions bound to the apply context.
 */
function registerUi(ctx, actions) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-agent-multi: dictionaries');
    const t = ctx.locale.bind(NS);
    ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => actions,
    }, WorkflowPage));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        locale: NS,
        label: () => t('panel'),
    }, AgentMultiIcon));
}
