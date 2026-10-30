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
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm'
import type { EdgeFormat, EdgeSpec, AgentNodeSpec } from '../types.ts'
import { TEMPLATE_NODE_REF_RE } from '../contract.ts'

/** The run ledger: nodeId → stored output blocks. The shared global memory for one run. */
export type Ledger = ReadonlyMap<string, readonly ContentBlock[]>

const TEXT_BLOCK_TYPE = 'text' as const

/** Concatenate the text content of text blocks; non-text blocks contribute nothing in v1. */
export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is TextBlock => block.type === TEXT_BLOCK_TYPE)
    .map((block) => block.text)
    .join('')
}

/**
 * Render a node's output as the intermediate payload for an edge of the given format.
 *
 * - `text`: the raw text content.
 * - `md`: the raw text content (the node's output is already authored markdown).
 * - `json`: when the text content is valid JSON, return it pretty-printed so the
 *   downstream node receives structured data; otherwise wrap the text in an object.
 */
export function renderNodeOutput(output: readonly ContentBlock[], format: EdgeFormat): string {
  const text = textOf(output)
  if (format === 'json') {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return JSON.stringify({ text }, null, 2)
    }
  }
  return text
}

/**
 * Apply an edge template to a rendered predecessor payload.
 *
 * Substitutions:
 * - `{{output}}` → the rendered predecessor payload for this edge.
 * - `{{nodes.<id>}}` → the text-formatted payload of any node in the ledger.
 *
 * Without a template the caller uses the rendered payload verbatim.
 */
export function applyEdgeTemplate(template: string, currentOutput: string, ledger: Ledger): string {
  return template
    .replaceAll('{{output}}', currentOutput)
    .replace(TEMPLATE_NODE_REF_RE, (match, id: string | undefined) => {
      if (id === undefined) return match
      const output = ledger.get(id)
      if (output === undefined) return match
      return renderNodeOutput(output, 'text')
    })
}

/** Rough token estimate: ~4 characters per token. Sufficient for budget gating. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Trim an assembled prompt body to a token budget, dropping predecessor sections
 * from the end (lowest priority) before the user input or system prompt.
 *
 * Returns the surviving body text and whether any section was dropped.
 */
export function trimToBudget(
  systemPrompt: string,
  userInput: string,
  predecessorSections: readonly { readonly label: string; readonly body: string }[],
  budgetTokens?: number,
): { text: string; trimmed: boolean } {
  const head = systemPrompt.length > 0 ? `${systemPrompt}\n\n---\n\n` : ''
  const userSection = `## User Input\n${userInput}`
  const keep: string[] = []
  let tokens = estimateTokens(head) + estimateTokens(userSection)
  let trimmed = false
  for (const section of predecessorSections) {
    const block = `${section.label}\n${section.body}`
    if (budgetTokens !== undefined && tokens + estimateTokens(block) > budgetTokens) {
      trimmed = true
      continue
    }
    tokens += estimateTokens(block)
    keep.push(block)
  }
  const sections = [userSection, ...keep].join('\n\n')
  return { text: `${head}${sections}`, trimmed }
}

/**
 * Assemble the prompt blocks for an agent node from its direct predecessors and
 * the user input, applying edge formats, templates, and the context budget.
 *
 * Direct predecessors are rendered in edge order. An edge with `inContext: false`
 * contributes nothing to the prompt but still records its payload in the ledger.
 */
export function assembleAgentPrompt(
  node: AgentNodeSpec,
  inEdges: readonly EdgeSpec[],
  ledger: Ledger,
  userInput: string,
): ContentBlock[] {
  const predecessorSections: { label: string; body: string }[] = []
  for (const edge of inEdges) {
    if (!edge.inContext) continue
    const output = ledger.get(edge.from)
    if (output === undefined) continue
    const rendered = renderNodeOutput(output, edge.format)
    const body = edge.template !== undefined ? applyEdgeTemplate(edge.template, rendered, ledger) : rendered
    predecessorSections.push({ label: `## ${edge.from} (${edge.format})`, body })
  }
  const { text } = trimToBudget(node.systemPrompt, userInput, predecessorSections, node.contextBudgetTokens)
  return [{ type: 'text', text }]
}
