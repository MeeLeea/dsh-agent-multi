/**
 * Wire contracts shared by the host controller, the remote client, and the
 * tests: validation issue vocabulary, request and result interfaces, and the
 * template reference grammar.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/contract
 */
/** Matches `{{nodes.<id>}}` template references (any spacing inside braces). */
export const TEMPLATE_NODE_REF_RE = /\{\{\s*nodes\.([A-Za-z0-9_-]+)\s*\}\}/g;
//# sourceMappingURL=contract.js.map