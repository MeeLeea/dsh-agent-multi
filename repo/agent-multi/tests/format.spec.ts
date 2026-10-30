import { describe, expect, it } from 'vitest'
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm'
import type { AgentNodeSpec, EdgeSpec } from '../src/types.ts'
import {
  applyEdgeTemplate,
  assembleAgentPrompt,
  estimateTokens,
  renderNodeOutput,
  trimToBudget,
  type Ledger,
} from '../src/engine/format.ts'

const t = (text: string): TextBlock => ({ type: 'text', text })
const output = (text: string): readonly ContentBlock[] => [t(text)]

const baseAgent = (overrides: Partial<AgentNodeSpec> = {}): AgentNodeSpec => ({
  kind: 'agent',
  id: 'B',
  name: 'B',
  systemPrompt: '',
  retry: { maxAttempts: 1, backoffMs: 0 },
  ...overrides,
}) as AgentNodeSpec

const edge = (overrides: Partial<EdgeSpec> & { from: string }): EdgeSpec => ({
  id: 'e1',
  to: 'B',
  format: 'text',
  inContext: true,
  ...overrides,
}) as EdgeSpec

describe('renderNodeOutput', () => {
  it('text format concatenates text blocks', () => {
    expect(renderNodeOutput([t('hello'), t(' world')], 'text')).toBe('hello world')
  })

  it('md format passes text through', () => {
    expect(renderNodeOutput(output('# Hi\nbody'), 'md')).toBe('# Hi\nbody')
  })

  it('json format pretty-prints valid json text', () => {
    expect(renderNodeOutput(output('{"a":1}'), 'json')).toBe('{\n  "a": 1\n}')
  })

  it('json format wraps non-json text in an object', () => {
    expect(renderNodeOutput(output('not json'), 'json')).toBe('{\n  "text": "not json"\n}')
  })
})

describe('applyEdgeTemplate', () => {
  const ledger: Ledger = new Map([
    ['A', output('alpha')],
    ['Z', output('zulu')],
  ])

  it('substitutes {{output}} with the rendered predecessor payload', () => {
    expect(applyEdgeTemplate('Result:\n{{output}}', 'alpha', ledger)).toBe('Result:\nalpha')
  })

  it('substitutes {{nodes.<id>}} with any ledger node payload', () => {
    expect(applyEdgeTemplate('see {{nodes.Z}}', 'alpha', ledger)).toBe('see zulu')
  })

  it('leaves unknown node refs untouched', () => {
    expect(applyEdgeTemplate('{{nodes.X}}', 'alpha', ledger)).toBe('{{nodes.X}}')
  })

  it('combines both substitutions', () => {
    expect(applyEdgeTemplate('{{output}} + {{nodes.Z}}', 'alpha', ledger)).toBe('alpha + zulu')
  })
})

describe('estimateTokens', () => {
  it('estimates ~4 chars per token, rounded up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
})

describe('trimToBudget', () => {
  it('joins all sections when no budget is set', () => {
    const res = trimToBudget('', 'u', [{ label: '## A (text)', body: 'aaa' }])
    expect(res.trimmed).toBe(false)
    expect(res.text).toBe('## User Input\nu\n\n## A (text)\naaa')
  })

  it('prepends the system prompt before sections', () => {
    const res = trimToBudget('SYS', 'u', [])
    expect(res.text).toBe('SYS\n\n---\n\n## User Input\nu')
  })

  it('drops predecessor sections from the end when over budget', () => {
    // head+user ≈ 5 tokens; each "longbody..." section is large; budget 6 keeps none of them.
    const res = trimToBudget('', 'u', [
      { label: '## A', body: 'x'.repeat(200) },
      { label: '## B', body: 'y'.repeat(200) },
    ], 6)
    expect(res.trimmed).toBe(true)
    expect(res.text).toBe('## User Input\nu')
  })

  it('keeps sections that fit within budget', () => {
    const res = trimToBudget('', 'u', [
      { label: '## A', body: 'aaa' },
      { label: '## B', body: 'bbb' },
    ], 20)
    expect(res.trimmed).toBe(false)
    expect(res.text).toContain('## A')
    expect(res.text).toContain('## B')
  })
})

describe('assembleAgentPrompt', () => {
  it('renders direct predecessors and prepends the system prompt', () => {
    const ledger: Ledger = new Map([['A', output('answer-42')]])
    const prompt = assembleAgentPrompt(
      baseAgent({ systemPrompt: 'You are a summarizer.' }),
      [edge({ from: 'A' })],
      ledger,
      'hi',
    )
    expect(prompt).toHaveLength(1)
    expect(prompt[0]?.type).toBe('text')
    const text = (prompt[0] as TextBlock).text
    expect(text).toContain('You are a summarizer.')
    expect(text).toContain('## User Input\nhi')
    expect(text).toContain('## A (text)')
    expect(text).toContain('answer-42')
  })

  it('skips edges with inContext false', () => {
    const ledger: Ledger = new Map([['A', output('hidden')]])
    const prompt = assembleAgentPrompt(baseAgent(), [edge({ from: 'A', inContext: false })], ledger, 'hi')
    const text = (prompt[0] as TextBlock).text
    expect(text).not.toContain('hidden')
    expect(text).toContain('## User Input\nhi')
  })

  it('applies the edge template and format', () => {
    const ledger: Ledger = new Map([['A', output('{"k":1}')]])
    const prompt = assembleAgentPrompt(
      baseAgent(),
      [edge({ from: 'A', format: 'json', template: 'A says:\n{{output}}' })],
      ledger,
      'hi',
    )
    const text = (prompt[0] as TextBlock).text
    expect(text).toContain('A says:')
    expect(text).toContain('{\n  "k": 1\n}')
  })

  it('trims predecessor sections to the context budget', () => {
    const ledger: Ledger = new Map([
      ['A', output('x'.repeat(400))],
      ['C', output('y'.repeat(400))],
    ])
    const prompt = assembleAgentPrompt(
      baseAgent({ contextBudgetTokens: 6 }),
      [edge({ from: 'A' }), edge({ from: 'C' })],
      ledger,
      'hi',
    )
    const text = (prompt[0] as TextBlock).text
    expect(text).toContain('## User Input\nhi')
    expect(text).not.toContain('xxxx')
  })
})
