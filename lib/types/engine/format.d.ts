/**
 * Pure context assembly and intermediate-format conversion for agent-multi runs.
 *
 * These functions hold no runtime state and take no `ctx`; the executor composes
 * them with the live ledger and node graph. The two-layer memory model (plan §5.4)
 * lives here: the ledger is the shared global memory, and a node's *input* layer
 * defaults to the user input plus only its direct predecessors — suppressing
 * exponential context growth across a chain — with opt-in `{{nodes.<id>}}`
 * template references to pull any node's payload from the ledger.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { EdgeFormat, EdgeSpec, AgentNodeSpec } from '../types.ts';
/** The run ledger: nodeId → stored output blocks. The shared global memory for one run. */
export type Ledger = ReadonlyMap<string, readonly ContentBlock[]>;
/** Concatenate the text content of text blocks; non-text blocks contribute nothing in v1. */
export declare function textOf(blocks: readonly ContentBlock[]): string;
/**
 * Render a node's output as the intermediate payload for an edge of the given format.
 *
 * - `text`: the raw text content.
 * - `md`: the raw text content (the node's output is already authored markdown).
 * - `json`: when the text content is valid JSON, return it pretty-printed so the
 *   downstream node receives structured data; otherwise wrap the text in an object.
 */
export declare function renderNodeOutput(output: readonly ContentBlock[], format: EdgeFormat): string;
/**
 * Apply an edge template to a rendered predecessor payload.
 *
 * Substitutions:
 * - `{{output}}` → the rendered predecessor payload for this edge.
 * - `{{nodes.<id>}}` → the text-formatted payload of any node in the ledger.
 *
 * Without a template the caller uses the rendered payload verbatim.
 */
export declare function applyEdgeTemplate(template: string, currentOutput: string, ledger: Ledger): string;
/** Rough token estimate: ~4 characters per token. Sufficient for budget gating. */
export declare function estimateTokens(text: string): number;
/**
 * Trim an assembled prompt body to a token budget, dropping predecessor sections
 * from the end (lowest priority) before the user input or system prompt.
 *
 * Returns the surviving body text and whether any section was dropped.
 */
export declare function trimToBudget(systemPrompt: string, userInput: string, predecessorSections: readonly {
    readonly label: string;
    readonly body: string;
}[], budgetTokens?: number): {
    text: string;
    trimmed: boolean;
};
/**
 * Assemble the prompt blocks for an agent node from its direct predecessors and
 * the user input, applying edge formats, templates, and the context budget.
 *
 * Direct predecessors are rendered in edge order. An edge with `inContext: false`
 * contributes nothing to the prompt but still records its payload in the ledger.
 */
export declare function assembleAgentPrompt(node: AgentNodeSpec, inEdges: readonly EdgeSpec[], ledger: Ledger, userInput: string): ContentBlock[];
//# sourceMappingURL=format.d.ts.map