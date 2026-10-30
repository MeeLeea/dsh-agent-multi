import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { CancelRunResult, CreateWorkflowResult, DeleteWorkflowResult, DryRunNodeResult, GetRunResult, GetWorkflowResult, ListRunsResult, ResumeRunResult, SaveWorkflowRequest, SaveWorkflowResult, StartRunResult, ValidateWorkflowResult, WorkflowDraft, WorkflowId, WorkflowSummary, AgentNodeSpec, ExportWorkflowResult, ImportWorkflowResult, WorkflowExportDocument, AgentLibraryEntry, AgentLibraryId, AgentLibrarySpec, CreateLibraryAgentResult, SaveLibraryAgentResult, CreateTriggerRequest, CreateTriggerResult, ListTriggersResult, SetTriggerEnabledResult, DeleteTriggerResult, ModelCatalog } from '@deepseek-ai/dsh-experimental-agent-multi/types';
/** Remote-backed actions injected into the panel. */
export interface AgentMultiInjected {
    readonly createWorkflow: (draft: WorkflowDraft) => Promise<RemoteResult<CreateWorkflowResult>>;
    readonly saveWorkflow: (request: SaveWorkflowRequest) => Promise<RemoteResult<SaveWorkflowResult>>;
    readonly listWorkflows: () => Promise<RemoteResult<readonly WorkflowSummary[]>>;
    readonly getWorkflow: (request: {
        id: WorkflowId;
    }) => Promise<RemoteResult<GetWorkflowResult>>;
    readonly deleteWorkflow: (request: {
        id: WorkflowId;
    }) => Promise<RemoteResult<DeleteWorkflowResult>>;
    readonly validateWorkflow: (request: {
        draft: WorkflowDraft;
    }) => Promise<RemoteResult<ValidateWorkflowResult>>;
    readonly startRun: (request: {
        workflowId: WorkflowId;
        input: string;
    }) => Promise<RemoteResult<StartRunResult>>;
    readonly resumeRun: (request: {
        runId: string;
    }) => Promise<RemoteResult<ResumeRunResult>>;
    readonly cancelRun: (request: {
        runId: string;
    }) => Promise<RemoteResult<CancelRunResult>>;
    readonly getRun: (request: {
        runId: string;
    }) => Promise<RemoteResult<GetRunResult>>;
    readonly listRuns: (request: {
        workflowId?: WorkflowId;
    }) => Promise<RemoteResult<ListRunsResult>>;
    readonly dryRunNode: (request: {
        node: AgentNodeSpec;
        input: string;
    }) => Promise<RemoteResult<DryRunNodeResult>>;
    readonly exportWorkflow: (request: {
        id: WorkflowId;
    }) => Promise<RemoteResult<ExportWorkflowResult>>;
    readonly importWorkflow: (request: {
        document: WorkflowExportDocument;
        keepId?: boolean;
    }) => Promise<RemoteResult<ImportWorkflowResult>>;
    readonly listLibraryAgents: () => Promise<RemoteResult<readonly AgentLibraryEntry[]>>;
    readonly listModelCatalog: () => Promise<RemoteResult<ModelCatalog>>;
    readonly createLibraryAgent: (request: {
        name: string;
        spec: AgentLibrarySpec;
    }) => Promise<RemoteResult<CreateLibraryAgentResult>>;
    readonly saveLibraryAgent: (request: {
        id: AgentLibraryId;
        name: string;
        spec: AgentLibrarySpec;
    }) => Promise<RemoteResult<SaveLibraryAgentResult>>;
    readonly deleteLibraryAgent: (request: {
        id: AgentLibraryId;
    }) => Promise<RemoteResult<{
        outcome: 'deleted' | 'missing';
    }>>;
    readonly createTrigger: (request: CreateTriggerRequest) => Promise<RemoteResult<CreateTriggerResult>>;
    readonly setTriggerEnabled: (request: {
        id: string;
        enabled: boolean;
    }) => Promise<RemoteResult<SetTriggerEnabledResult>>;
    readonly deleteTrigger: (request: {
        id: string;
    }) => Promise<RemoteResult<DeleteTriggerResult>>;
    readonly listTriggers: (request: {
        workflowId?: WorkflowId;
    }) => Promise<RemoteResult<ListTriggersResult>>;
}
/** Root-scoped panel props derived from the framework and injected actions. */
export type WorkflowPageProps = PropsRuntime<'main'> & InjectFace<AgentMultiInjected> & PropsLocale<'agent-multi'>;
/**
 * Render the workflow list, editor, or run panel.
 * @param props - framework props, injected actions, and localized copy.
 * @returns the panel contents.
 */
export declare function WorkflowPage(props: WorkflowPageProps): import("react").JSX.Element;
//# sourceMappingURL=WorkflowPage.d.ts.map