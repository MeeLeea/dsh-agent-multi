/**
 * Agent attribute profiles for agent-multi node activations.
 *
 * Every agent node the engine activates can carry additional attributes —
 * provider, reasoning effort, output-token ceiling, turn budget, delegation
 * depth, preset and working directory — that the Web client does not edit.
 * They live in `.agents.json` at the plugin root: a `default` block listing
 * every property together with its meaning, plus one `agents.<name>` entry
 * per agent (matched by node name). An agent without a property falls back
 * to `default`; `null` anywhere means "unset" so the host default applies.
 *
 * The file is reread whenever its stat signature changes, so edits take
 * effect for agents created afterwards without a host restart. Loading is
 * best-effort: a missing file, broken JSON, or an invalid entry degrades to
 * an empty profile (with one warning) and never fails a node.
 * @module @deepseek-ai/dsh-experimental-agent-multi/src/engine/profile
 */

import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/**
 * Attributes an agent node can receive from `.agents.json`. Every field is
 * optional: absent (or `null` in the file) means the host default applies.
 * Fields the Web client already edits (name, systemPrompt, model,
 * permissionPreset, hitlEnabled, allowSubagents) are deliberately absent.
 */
export interface AgentProfile {
  /** LLM provider id routing the child activation away from the run root. */
  readonly provider?: string
  /** Reasoning-effort id; must be one the resolved provider/model supports. */
  readonly reasoningEffort?: string
  /** Output-token ceiling per model reply (positive integer). */
  readonly maxTokens?: number
  /** Model-call budget for the child activation (positive integer). */
  readonly maxTurns?: number
  /** Absolute delegation-depth cap granted to the child (non-negative integer). */
  readonly maxDepth?: number
  /** Agent preset id composing the child session instead of the default. */
  readonly agentPreset?: string
  /** Child working directory: absolute, or relative to the run root's. */
  readonly cwd?: string
}

/** Minimal logger the loader warns through; cordis' Context.logger satisfies it. */
export interface ProfileLogger {
  warn(message: string): void
}

/** One nullable attribute: `null` is accepted and normalized to unset. */
const nullableText = z.union([z.string().min(1), z.null()])
const nullableCount = (min: number) => z.union([z.number().int().min(min), z.null()])

/** Structural contract of one `default` or `agents.<name>` entry. */
export const agentProfileSchema = z.object({
  provider: nullableText.optional(),
  reasoningEffort: nullableText.optional(),
  maxTokens: nullableCount(1).optional(),
  maxTurns: nullableCount(1).optional(),
  maxDepth: nullableCount(0).optional(),
  agentPreset: nullableText.optional(),
  cwd: nullableText.optional(),
}).strict()

/** Parsed `.agents.json` content with normalized (null-free) entries. */
export interface AgentProfilesFile {
  readonly default: AgentProfile
  readonly agents: Readonly<Record<string, AgentProfile>>
}

const EMPTY_FILE: AgentProfilesFile = { default: {}, agents: {} }

/**
 * Drop `_`-prefixed keys from one entry: JSON has no comments, so keys like
 * `_doc` document the file in place and are ignored by parsing.
 */
function stripCommentKeys(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (key.startsWith('_')) continue
    clone[key] = value
  }
  return clone
}

/** Mutable twin of {@link AgentProfile} used while normalizing an entry. */
type MutableAgentProfile = { -readonly [K in keyof AgentProfile]?: AgentProfile[K] }

/** Turn a validated raw entry (fields possibly `null`) into a clean profile. */
function normalizeProfile(raw: z.infer<typeof agentProfileSchema>): AgentProfile {
  const profile: MutableAgentProfile = {}
  // Each typeof check narrows the zod field (string | null | undefined or
  // number | null | undefined) to its concrete type, dropping `null` back to
  // "unset" — the value is already schema-validated, this is pure narrowing.
  if (typeof raw.provider === 'string') profile.provider = raw.provider
  if (typeof raw.reasoningEffort === 'string') profile.reasoningEffort = raw.reasoningEffort
  if (typeof raw.maxTokens === 'number') profile.maxTokens = raw.maxTokens
  if (typeof raw.maxTurns === 'number') profile.maxTurns = raw.maxTurns
  if (typeof raw.maxDepth === 'number') profile.maxDepth = raw.maxDepth
  if (typeof raw.agentPreset === 'string') profile.agentPreset = raw.agentPreset
  if (typeof raw.cwd === 'string') profile.cwd = raw.cwd
  return profile
}

/** Parse and normalize one entry; invalid shapes warn and yield an empty profile. */
function parseEntry(raw: unknown, where: string, logger?: ProfileLogger): AgentProfile {
  if (raw === undefined) return {}
  const result = agentProfileSchema.safeParse(stripCommentKeys(raw))
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
    logger?.warn(`agent-multi: .agents.json ${where} is invalid and ignored: ${issues}`)
    return {}
  }
  return normalizeProfile(result.data)
}

/**
 * Parse the whole file body into normalized entries. Structural failures
 * (bad JSON, non-object root, non-object `agents`) warn and yield the empty
 * file; a single bad `agents.<name>` entry is skipped with its own warning
 * so the rest of the file keeps working.
 */
export function parseAgentProfilesFile(text: string, logger?: ProfileLogger): AgentProfilesFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    logger?.warn(`agent-multi: .agents.json is not valid JSON and is ignored: ${error instanceof Error ? error.message : String(error)}`)
    return EMPTY_FILE
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger?.warn('agent-multi: .agents.json must be a JSON object and is ignored')
    return EMPTY_FILE
  }
  const root = parsed as Record<string, unknown>
  const agents: Record<string, AgentProfile> = {}
  const rawAgents = root.agents
  if (rawAgents !== undefined) {
    if (typeof rawAgents !== 'object' || rawAgents === null || Array.isArray(rawAgents)) {
      logger?.warn('agent-multi: .agents.json "agents" must be an object of name-to-entry maps and is ignored')
    } else {
      for (const [name, entry] of Object.entries(rawAgents)) {
        agents[name] = parseEntry(entry, `agents."${name}"`, logger)
      }
    }
  }
  return { default: parseEntry(root.default, 'default', logger), agents }
}

/** Stat signature detecting content changes; `missing` covers ENOENT. */
async function statKeyOf(path: string): Promise<string> {
  try {
    const stats = await stat(path)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return 'missing'
  }
}

/**
 * Walk up from this module to the plugin root — the nearest ancestor whose
 * `package.json` names `dsh-agent-multi` — and return its `.agents.json`
 * path. Works from the bundled `lib/index.js` (one level up) and from the
 * source tree under test (three levels up); `undefined` disables profiles.
 */
function discoverProfilesPath(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let level = 0; level < 8; level += 1) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (raw.name === 'dsh-agent-multi') return join(dir, '.agents.json')
    } catch {
      // No readable package.json here — keep walking.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Resolve the effective profile for one agent name: the `default` entry
 * overlaid by `agents.<name>` (exact, case-sensitive name match).
 */
export interface AgentProfileReader {
  resolve(name: string, logger?: ProfileLogger): Promise<AgentProfile>
}

/** Options for {@link createAgentProfileReader}. */
export interface AgentProfileReaderOptions {
  /** Explicit `.agents.json` path; defaults to the plugin-root discovery. */
  readonly path?: string
}

/**
 * Create a file-backed profile reader. The file is stat-checked on every
 * resolve and reread when its signature changes, so edits apply to agents
 * created afterwards. Read errors beyond a missing file warn once per file
 * state and degrade to the empty profile; the reader never throws.
 */
export function createAgentProfileReader(options: AgentProfileReaderOptions = {}): AgentProfileReader {
  let path: string | undefined = options.path
  let cachedKey: string | undefined
  let cachedFile: AgentProfilesFile = EMPTY_FILE
  const resolvePath = (): string | undefined => {
    path ??= discoverProfilesPath()
    return path
  }
  return {
    async resolve(name: string, logger?: ProfileLogger): Promise<AgentProfile> {
      const filePath = resolvePath()
      if (filePath === undefined) return {}
      const key = await statKeyOf(filePath)
      if (key !== cachedKey) {
        // New file state: reread once; a broken read warns once and keeps
        // profiles empty until the file changes again.
        cachedKey = key
        cachedFile = EMPTY_FILE
        if (key !== 'missing') {
          try {
            cachedFile = parseAgentProfilesFile(await readFile(filePath, 'utf8'), logger)
          } catch (error: unknown) {
            // stat succeeded but the read failed (permissions, racing delete).
            logger?.warn(`agent-multi: reading .agents.json at "${filePath}" failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      const override = cachedFile.agents[name]
      if (override === undefined) return cachedFile.default
      // normalizeProfile never emits undefined-valued keys, so the overlay
      // keeps default values for every property the agent entry omits.
      return { ...cachedFile.default, ...override }
    },
  }
}

let defaultReader: AgentProfileReader | undefined

/**
 * The process-wide reader over the plugin-root `.agents.json`, shared by
 * every node activation (runs and dry-runs) unless deps inject one.
 */
export function defaultAgentProfiles(): AgentProfileReader {
  defaultReader ??= createAgentProfileReader()
  return defaultReader
}
