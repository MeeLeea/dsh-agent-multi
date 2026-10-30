import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm'
import type { WorkflowDefinition, WorkflowId, NodeSpec, EdgeSpec } from '../src/types.ts'
import { Scheduler } from '../src/engine/scheduler.ts'

const t = (text: string): TextBlock => ({ type: 'text', text })
const out = (text: string): readonly ContentBlock[] => [t(text)]

const id = brandString<WorkflowId>('w1')

const agent = (nodeId: string, name = nodeId): NodeSpec =>
  ({ kind: 'agent', id: nodeId, name, systemPrompt: '', retry: { maxAttempts: 1, backoffMs: 0 } }) as NodeSpec
const input = (): NodeSpec => ({ kind: 'input', id: 'in', name: 'in' }) as NodeSpec
const output = (): NodeSpec => ({ kind: 'output', id: 'out', name: 'out' }) as NodeSpec
const router = (nodeId: string, labels: string[]): NodeSpec =>
  ({ kind: 'router', id: nodeId, name: nodeId, cases: labels }) as NodeSpec
const join = (nodeId: string, strategy: 'all' | 'any' | 'quorum' = 'all', quorum?: number): NodeSpec =>
  ({ kind: 'join', id: nodeId, name: nodeId, strategy, quorum }) as NodeSpec
const loop = (nodeId: string, count: number, collect = true): NodeSpec =>
  ({ kind: 'loop', id: nodeId, name: nodeId, mode: 'count', count, maxIters: 10, collect }) as NodeSpec
const note = (nodeId: string): NodeSpec => ({ kind: 'note', id: nodeId, name: nodeId, text: '' }) as NodeSpec

const edge = (from: string, to: string, overrides: Partial<EdgeSpec> = {}): EdgeSpec =>
  ({ id: `${from}-${to}`, from, to, format: 'text', inContext: true, ...overrides }) as EdgeSpec

const def = (nodes: NodeSpec[], edges: EdgeSpec[]): WorkflowDefinition =>
  ({ version: 1, id, name: 'w', revision: 1, nodes, edges }) as WorkflowDefinition

const readyIds = (s: Scheduler): string[] => s.readyAgentNodes().map((n) => n.id)

describe('Scheduler — linear chain', () => {
  it('advances input → A → B → output in order', () => {
    const s = new Scheduler(def([input(), agent('A'), agent('B'), output()], [
      edge('in', 'A'),
      edge('A', 'B'),
      edge('B', 'out'),
    ]))
    s.setInput('hello')
    expect(readyIds(s)).toEqual(['A'])
    s.completeAgent('A', out('a-result'))
    expect(readyIds(s)).toEqual(['B'])
    s.completeAgent('B', out('b-result'))
    expect(readyIds(s)).toEqual([])
    expect(s.isFinished()).toBe(true)
    expect(s.getOutput()).toBe('b-result')
  })
})

describe('Scheduler — parallel fan-out', () => {
  it('runs siblings concurrently and merges at output', () => {
    const s = new Scheduler(def([input(), agent('A'), agent('B'), agent('C'), output()], [
      edge('in', 'A'),
      edge('A', 'B'),
      edge('A', 'C'),
      edge('B', 'out'),
      edge('C', 'out'),
    ]))
    s.setInput('go')
    expect(readyIds(s)).toEqual(['A'])
    s.completeAgent('A', out('A'))
    expect(readyIds(s).sort()).toEqual(['B', 'C'])
    s.completeAgent('B', out('B'))
    expect(readyIds(s)).toEqual(['C']) // C still pending; output waits for both
    expect(s.getOutput()).toBeUndefined()
    s.completeAgent('C', out('C'))
    expect(readyIds(s)).toEqual([])
    expect(s.isFinished()).toBe(true)
    expect(s.getOutput()).toBe('B\n\nC')
  })
})

describe('Scheduler — join', () => {
  it('all strategy waits for every predecessor', () => {
    const s = new Scheduler(def([input(), agent('A'), agent('B'), agent('C'), join('J'), output()], [
      edge('in', 'A'),
      edge('A', 'B'),
      edge('A', 'C'),
      edge('B', 'J'),
      edge('C', 'J'),
      edge('J', 'out'),
    ]))
    s.setInput('go')
    s.completeAgent('A', out('A'))
    s.completeAgent('B', out('B'))
    expect(readyIds(s)).toEqual(['C']) // join waits for C
    s.completeAgent('C', out('C'))
    expect(readyIds(s)).toEqual([]) // join + output resolved
    expect(s.getOutput()).toBe('B\n\nC')
    expect(s.isFinished()).toBe(true)
  })

  it('quorum strategy proceeds once the threshold is met', () => {
    const s = new Scheduler(
      def(
        [input(), agent('A'), agent('B'), agent('C'), agent('D'), join('J', 'quorum', 2), output()],
        [
          edge('in', 'A'),
          edge('A', 'B'),
          edge('A', 'C'),
          edge('A', 'D'),
          edge('B', 'J'),
          edge('C', 'J'),
          edge('D', 'J'),
          edge('J', 'out'),
        ],
      ),
    )
    s.setInput('go')
    s.completeAgent('A', out('A'))
    s.completeAgent('B', out('B'))
    // only 1 of 3 → quorum 2 not met
    expect(s.getOutput()).toBeUndefined()
    s.completeAgent('C', out('C'))
    // 2 of 3 → quorum met → join + output resolved with the two ready predecessors
    expect(s.getOutput()).toBe('B\n\nC')
  })
})

describe('Scheduler — router', () => {
  it('routes to the matching case branch', () => {
    const s = new Scheduler(
      def([input(), agent('A'), router('R', ['yes', 'no']), agent('Yes'), agent('No'), output()], [
        edge('in', 'A'),
        edge('A', 'R'),
        edge('R', 'Yes', { fromHandle: 'yes' }),
        edge('R', 'No', { fromHandle: 'no' }),
        edge('Yes', 'out'),
        edge('No', 'out'),
      ]),
    )
    s.setInput('go')
    s.completeAgent('A', out('yes please'))
    expect(readyIds(s)).toEqual(['Yes'])
    s.completeAgent('Yes', out('done-yes'))
    expect(s.getOutput()).toBe('done-yes')
    expect(s.isFinished()).toBe(true)
  })

  it('falls back to default when no case matches', () => {
    const s = new Scheduler(
      def([input(), agent('A'), router('R', ['yes', 'no']), agent('D'), output()], [
        edge('in', 'A'),
        edge('A', 'R'),
        edge('R', 'D', { fromHandle: 'default' }),
        edge('D', 'out'),
      ]),
    )
    s.setInput('go')
    s.completeAgent('A', out('maybe'))
    expect(readyIds(s)).toEqual(['D'])
    s.completeAgent('D', out('defaulted'))
    expect(s.getOutput()).toBe('defaulted')
  })
})

describe('Scheduler — count loop', () => {
  it('iterates the body twice then exits via done', () => {
    const s = new Scheduler(def([input(), loop('L', 2, true), agent('B'), output()], [
      edge('in', 'L'),
      edge('L', 'B', { fromHandle: 'iterate' }),
      edge('B', 'L', { toHandle: 'back' }),
      edge('L', 'out', { fromHandle: 'done' }),
    ]))
    s.setInput('go')
    // iteration 1
    expect(readyIds(s)).toEqual(['B'])
    s.completeAgent('B', out('iter1'))
    // iteration 2
    expect(readyIds(s)).toEqual(['B'])
    s.completeAgent('B', out('iter2'))
    // done → output
    expect(readyIds(s)).toEqual([])
    expect(s.getOutput()).toBe('iter1\n\niter2')
    expect(s.isFinished()).toBe(true)
  })
})

describe('Scheduler — note', () => {
  it('skips note nodes and never runs them', () => {
    const s = new Scheduler(def([input(), agent('A'), note('N'), output()], [
      edge('in', 'A'),
      edge('A', 'out'),
    ]))
    s.setInput('go')
    s.completeAgent('A', out('A'))
    expect(s.isFinished()).toBe(true)
    expect(s.getOutput()).toBe('A')
  })
})
