/**
 * Public value-type surface for agent-multi. The zod schemas in domain.ts are
 * the single source of truth; this module re-exports their inferred types so
 * consumers depend on one shape, never a hand-written duplicate that can
 * drift under `exactOptionalPropertyTypes`.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/types
 */
export type { WorkflowId, NodeKind, EdgeFormat, NodeSpec, AgentNodeSpec, EdgeSpec, WorkflowDefinition, WorkflowDraft, AgentLibraryId, AgentLibrarySpec, TriggerTiming, TriggerRecord, } from './domain.ts';
export type { AgentLibraryEntry, AgentMultiErrorClass, AgentMultiJsonValue, CancelRunRequest, CancelRunResult, CreateLibraryAgentRequest, CreateLibraryAgentResult, CreateWorkflowRequest, CreateWorkflowResult, CreateTriggerRequest, CreateTriggerResult, DeleteTriggerRequest, DeleteTriggerResult, DeleteWorkflowRequest, DeleteWorkflowResult, DryRunNodeRequest, DryRunNodeResult, ExportWorkflowRequest, ExportWorkflowResult, GetRunRequest, GetRunResult, GetWorkflowRequest, GetWorkflowResult, ImportWorkflowRequest, ImportWorkflowResult, ListRunsRequest, ListRunsResult, ListTriggersRequest, ListTriggersResult, ResumeRunRequest, ResumeRunResult, SaveLibraryAgentRequest, SaveLibraryAgentResult, RunEventView, RunFailureView, RunHitlView, RunNodeView, RunStatus, RunSummary, RunView, SaveWorkflowRequest, SaveWorkflowResult, SetTriggerEnabledRequest, SetTriggerEnabledResult, StartRunRequest, StartRunResult, TriggerEntry, ValidateWorkflowRequest, ValidateWorkflowResult, WorkflowExportDocument, WorkflowSummary, WorkflowValidationError, WorkflowValidationCode, } from './contract.ts';
//# sourceMappingURL=types.d.ts.map