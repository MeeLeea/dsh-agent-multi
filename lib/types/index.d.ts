/**
 * Host service for agent-multi: durable workflow definitions with
 * optimistic-concurrency editing, plus run execution (start, resume,
 * cancel, inspect) over typert remote methods for the Web client.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/index
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { CancelRunRequest, CancelRunResult, CreateLibraryAgentRequest, CreateLibraryAgentResult, CreateTriggerRequest, CreateTriggerResult, CreateWorkflowRequest, CreateWorkflowResult, DeleteTriggerRequest, DeleteTriggerResult, DeleteWorkflowRequest, DeleteWorkflowResult, DryRunNodeRequest, DryRunNodeResult, ExportWorkflowRequest, ExportWorkflowResult, GetRunRequest, GetRunResult, GetWorkflowRequest, GetWorkflowResult, ImportWorkflowRequest, ImportWorkflowResult, ListRunsRequest, ListRunsResult, ListTriggersRequest, ListTriggersResult, ResumeRunRequest, ResumeRunResult, SaveLibraryAgentRequest, SaveLibraryAgentResult, SaveWorkflowRequest, SaveWorkflowResult, SetTriggerEnabledRequest, SetTriggerEnabledResult, StartRunRequest, StartRunResult, ValidateWorkflowRequest, ValidateWorkflowResult, WorkflowSummary, AgentLibraryEntry } from './contract.ts';
import type { AgentLibraryId } from './types.ts';
/** Controller configuration. */
export interface Config {
    /** Provider for the dormant run-root agent (it never makes model calls). */
    runRootProvider?: string;
    /** Model for the dormant run-root agent. */
    runRootModel?: string;
    /** Maximum concurrent node activations per run. */
    maxActive?: number;
    /**
     * Default billed-token budget per run (uncached input + cache reads +
     * cache writes + output). A `startRun` request may override it per run;
     * both absent means unbudgeted.
     */
    tokenBudget?: number;
}
/**
 * Workflow CRUD and run service. Owns the `agent_multi` storage domain: the
 * domain opens with the plugin, validates every stored record, and closes on
 * dispose, so a hot reload never leaks a domain handle. Runs execute in a
 * dedicated session each; the run registry is in-memory, so resuming a run
 * after a host restart requires the run-root session recovery planned for a
 * later phase.
 */
export declare class AgentMultiController extends TypertRemoteService {
    static inject: string[];
    static Config: z<Schemastery.ObjectS<NoInfer<{
        runRootProvider: z<string, string, "defined">;
        runRootModel: z<string, string, "defined">;
        maxActive: z<number, number, "defined">;
        tokenBudget: z<number, number, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        runRootProvider: z<string, string, "defined">;
        runRootModel: z<string, string, "defined">;
        maxActive: z<number, number, "defined">;
        tokenBudget: z<number, number, "plain">;
    }>>, "plain">;
    private readonly ready;
    private readonly runs;
    private readonly config;
    private readonly triggerRuntime;
    /** Resolved domain handle once `ready` settles; the promise never rejects. */
    private resolvedDomain;
    constructor(ctx: Context, config: Config);
    /** Recompute the trigger timer after any durable trigger change. */
    private requestTriggerDrive;
    /** Synchronous domain access when already resolved, for the timer read. */
    private domainOf;
    /** Spike smoke method; retained as the cheapest remote round-trip check. */
    ping(): {
        pong: true;
    };
    /** @param request - Draft content for a new workflow. */
    createWorkflow(request: CreateWorkflowRequest): Promise<CreateWorkflowResult>;
    /** @param request - Draft content plus the revision the editor based it on. */
    saveWorkflow(request: SaveWorkflowRequest): Promise<SaveWorkflowResult>;
    /** Lists every stored workflow, name-ascending with id as tiebreaker. */
    listWorkflows(): Promise<WorkflowSummary[]>;
    /** @param request - Exact workflow identity. */
    getWorkflow(request: GetWorkflowRequest): Promise<GetWorkflowResult>;
    /** @param request - Exact workflow identity. */
    deleteWorkflow(request: DeleteWorkflowRequest): Promise<DeleteWorkflowResult>;
    /** @param request - Draft to validate without storing. */
    validateWorkflow(request: ValidateWorkflowRequest): Promise<ValidateWorkflowResult>;
    /**
     * Export one stored workflow as a portable document: the definition plus a
     * package stamp. The document round-trips through {@link importWorkflow}.
     * @param request - The workflow to export.
     */
    exportWorkflow(request: ExportWorkflowRequest): Promise<ExportWorkflowResult>;
    /**
     * Import a portable workflow document: validated from scratch, stored with
     * either the exported identity (`keepId`) or a fresh id. An id collision
     * under `keepId` fails as `invalid` rather than overwriting.
     * @param request - The document and identity policy.
     */
    importWorkflow(request: ImportWorkflowRequest): Promise<ImportWorkflowResult>;
    /**
     * Save one agent-node spec into the reusable library. The spec is validated
     * structurally (the same schema agent nodes use); a fresh agent id is
     * assigned on create.
     * @param request - Display name and the reusable agent payload.
     */
    createLibraryAgent(request: CreateLibraryAgentRequest): Promise<CreateLibraryAgentResult>;
    /**
     * Replace one library agent's name and spec.
     * @param request - The agent to update and its replacement content.
     */
    saveLibraryAgent(request: SaveLibraryAgentRequest): Promise<SaveLibraryAgentResult>;
    /** Lists every library agent, name-ascending with id as tiebreaker. */
    listLibraryAgents(): Promise<AgentLibraryEntry[]>;
    /**
     * Read the host model catalog: registered providers with their models, so
     * the client can offer provider/model dropdowns instead of free text. A
     * provider whose model listing fails is skipped, not fatal.
     */
    listModelCatalog(): Promise<ModelCatalog>;
    /**
     * Delete one library agent. Stored workflows keep their own node copies,
     * so deleting never breaks an existing workflow.
     * @param request - The agent to remove.
     */
    deleteLibraryAgent(request: {
        readonly id: AgentLibraryId;
    }): Promise<{
        outcome: 'deleted' | 'missing';
    }>;
    /**
     * Start a run: a dedicated session, a dormant run-root agent parenting every
     * node activation, and the engine driving the workflow to a terminal
     * outcome. Returns the run identity immediately; poll `get-run`.
     * @param request - The workflow to execute and the user input.
     */
    startRun(request: StartRunRequest): Promise<StartRunResult>;
    /**
     * Fire one trigger: resolve the workflow, start the run, and return the run
     * id so the runtime can record it as the trigger's latest run. Resolves with
     * `undefined` when the workflow disappeared; the trigger keeps its target.
     * @param trigger - The due trigger record.
     */
    private fireTrigger;
    /**
     * Create a workflow trigger. The timing rule is validated by the schedule
     * package's recurrence arithmetic and armed with its first future target.
     * @param request - Workflow binding, timing rule, and run parameters.
     */
    createTrigger(request: CreateTriggerRequest): Promise<CreateTriggerResult>;
    /**
     * Enable or disable one trigger. Disabling stops the timer obligation; the
     * committed target is preserved, so re-enabling never back-fires missed runs.
     * @param request - The trigger and its new enabled state.
     */
    setTriggerEnabled(request: SetTriggerEnabledRequest): Promise<SetTriggerEnabledResult>;
    /**
     * Delete one trigger. Runs already started by it keep running.
     * @param request - The trigger to remove.
     */
    deleteTrigger(request: DeleteTriggerRequest): Promise<DeleteTriggerResult>;
    /**
     * List triggers, oldest first, optionally narrowed to one workflow.
     * @param request - Workflow filter, or all triggers when omitted.
     */
    listTriggers(request: ListTriggersRequest): Promise<ListTriggersResult>;
    /**
     * Resume a paused or failed run on its existing session: completed nodes
     * are skipped from the journal, the current stored definition is used (so
     * edits between attempts take effect), and the original input replays.
     * @param request - The run to continue.
     */
    resumeRun(request: ResumeRunRequest): Promise<ResumeRunResult>;
    /**
     * Cancel a run: aborts the run signal, which tears down in-flight node
     * activations and settles the run as cancelled. Awaiting the settled
     * status makes the response deterministic.
     * @param request - The run to abort.
     */
    cancelRun(request: CancelRunRequest): Promise<CancelRunResult>;
    /**
     * Inspect a run: status plus the full agent-multi journal projected from
     * the run session (the kanban derives from these events).
     * @param request - Exact run identity.
     */
    getRun(request: GetRunRequest): Promise<GetRunResult>;
    /**
     * List tracked runs, newest first, optionally narrowed to one workflow.
     * Registry is in-memory, so the history covers this host process only.
     * @param request - Workflow filter, or all workflows when omitted.
     */
    listRuns(request: ListRunsRequest): Promise<ListRunsResult>;
    /**
     * Dry-run one agent node in isolation: a throwaway run-root session, no
     * workflow storage, no journal registration. Resolves with the settled
     * node outcome so the caller sees the final output or failure directly.
     * @param request - The node spec to try and the input to feed it.
     */
    dryRunNode(request: DryRunNodeRequest): Promise<DryRunNodeResult>;
    /**
     * Launch (or relaunch) one run and register it. The execution promise never
     * rejects here: the engine maps every outcome to a {@link RunResult}, and a
     * journaling failure is contained as a synthetic failed run.
     */
    private launchRun;
    /** Project a run record into the client view over its session journal and projection. */
    private viewOf;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        agentMultiController: AgentMultiController;
    }
}
export type { CancelRunRequest, CancelRunResult, CreateLibraryAgentRequest, CreateLibraryAgentResult, CreateTriggerRequest, CreateTriggerResult, CreateWorkflowRequest, CreateWorkflowResult, DeleteLibraryAgentResult, DeleteTriggerRequest, DeleteTriggerResult, DeleteWorkflowRequest, DeleteWorkflowResult, DryRunNodeRequest, DryRunNodeResult, ExportWorkflowRequest, ExportWorkflowResult, GetRunRequest, GetRunResult, GetWorkflowRequest, GetWorkflowResult, ImportWorkflowRequest, ImportWorkflowResult, ListRunsRequest, ListRunsResult, ListTriggersRequest, ListTriggersResult, ModelCatalog, ModelCatalogModel, ModelCatalogProvider, ResumeRunRequest, ResumeRunResult, RunHitlView, RunNodeView, RunStatus, RunSummary, RunView, SaveLibraryAgentRequest, SaveLibraryAgentResult, SaveWorkflowRequest, SaveWorkflowResult, SetTriggerEnabledRequest, SetTriggerEnabledResult, StartRunRequest, StartRunResult, TriggerEntry, ValidateWorkflowRequest, ValidateWorkflowResult, WorkflowExportDocument, WorkflowSummary, WorkflowValidationError, } from './contract.ts';
export type { AgentMultiErrorClass } from './engine/events.ts';
export type { AgentLibraryEntry, AgentLibraryId, AgentLibrarySpec, TriggerTiming, EdgeFormat, EdgeSpec, NodeKind, NodeSpec, WorkflowDefinition, WorkflowDraft, WorkflowId, } from './types.ts';
export default AgentMultiController;
//# sourceMappingURL=index.d.ts.map