import { AgentMultiIcon } from "./AgentMultiIcon.js";
import { WorkflowPage } from "./WorkflowPage.js";
import { NS, en, zh } from "./locales.js";
/** The main-panel key the sidebar row navigates to. */
const PANEL_ID = 'agent-multi';
/** Services used by the agent-multi client UI. */
export const inject = ['remote', 'slots', 'locale'];
/**
 * Mount the Remote contribution, then register the localized panel surfaces.
 * Disposal withdraws both the Remote namespace and the slot entries.
 * @param ctx - browser services.
 * @param contribution - generated agent-multi Remote contribution.
 * @returns combined disposer.
 */
export async function mount(ctx, contribution) {
    const disposeRemote = await ctx.remote.$mount(contribution);
    try {
        const ui = await ctx.inject(inject, registerUi);
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
 */
function registerUi(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-agent-multi: dictionaries');
    const t = ctx.locale.bind(NS);
    const actions = {
        createWorkflow: draft => ctx.remote.agentMulti.createWorkflow({ draft }),
        saveWorkflow: request => ctx.remote.agentMulti.saveWorkflow(request),
        listWorkflows: () => ctx.remote.agentMulti.listWorkflows(),
        getWorkflow: request => ctx.remote.agentMulti.getWorkflow(request),
        deleteWorkflow: request => ctx.remote.agentMulti.deleteWorkflow(request),
        validateWorkflow: request => ctx.remote.agentMulti.validateWorkflow(request),
        startRun: request => ctx.remote.agentMulti.startRun(request),
        resumeRun: request => ctx.remote.agentMulti.resumeRun(request),
        cancelRun: request => ctx.remote.agentMulti.cancelRun(request),
        getRun: request => ctx.remote.agentMulti.getRun(request),
        listRuns: request => ctx.remote.agentMulti.listRuns(request),
        dryRunNode: request => ctx.remote.agentMulti.dryRunNode(request),
        exportWorkflow: request => ctx.remote.agentMulti.exportWorkflow(request),
        importWorkflow: request => ctx.remote.agentMulti.importWorkflow(request),
        listLibraryAgents: () => ctx.remote.agentMulti.listLibraryAgents(),
        listModelCatalog: () => ctx.remote.agentMulti.listModelCatalog(),
        createLibraryAgent: request => ctx.remote.agentMulti.createLibraryAgent(request),
        saveLibraryAgent: request => ctx.remote.agentMulti.saveLibraryAgent(request),
        deleteLibraryAgent: request => ctx.remote.agentMulti.deleteLibraryAgent(request),
        createTrigger: request => ctx.remote.agentMulti.createTrigger(request),
        setTriggerEnabled: request => ctx.remote.agentMulti.setTriggerEnabled(request),
        deleteTrigger: request => ctx.remote.agentMulti.deleteTrigger(request),
        listTriggers: request => ctx.remote.agentMulti.listTriggers(request),
    };
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
//# sourceMappingURL=mount.js.map