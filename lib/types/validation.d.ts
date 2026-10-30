/**
 * Semantic graph validation for workflow drafts. Structural shape and
 * per-field bounds live in the zod domain schema; this module owns the graph
 * rules: endpoint references, handle completeness, degree legality, guarded
 * cycles, and template references.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/validation
 */
import type { WorkflowDraft } from './types.ts';
import type { WorkflowValidationError } from './contract.ts';
/**
 * Validate a workflow draft against the semantic graph rules. Pure: no
 * context, no storage, no exceptions. Returns every issue found so the
 * inspector can surface the full rejection matrix at once.
 * @param draft - Draft to validate.
 * @returns issues in no guaranteed order; empty means the draft is runnable.
 */
export declare function validateWorkflow(draft: WorkflowDraft): WorkflowValidationError[];
//# sourceMappingURL=validation.d.ts.map