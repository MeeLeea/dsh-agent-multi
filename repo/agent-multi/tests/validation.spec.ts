/**
 * Semantic graph validation: the full rejection matrix, each
 * {@link WorkflowValidationCode} produced by the exact defect it names, plus
 * the happy path and the loop-guarded-cycle exemption.
 */
import { describe, expect, it } from 'vitest'
import { validateWorkflow } from '../src/validation.ts'
import type { NodeSpec, WorkflowDraft } from '../src/domain.ts'
import type { WorkflowValidationError } from '../src/contract.ts'

/** Fresh minimal runnable draft: input → agent → output. */
function baseDraft(): WorkflowDraft {
  return {
    name: 'demo',
    nodes: [
      { kind: 'input', id: 'in', name: 'Input' },
      {
        kind: 'agent', id: 'a1', name: 'A1', systemPrompt: 'you are A1',
        retry: { maxAttempts: 2, backoffMs: 10 }, hitlEnabled: false,
      },
      { kind: 'output', id: 'out', name: 'Out' },
    ],
    edges: [
      { id: 'e1', from: 'in', to: 'a1', format: 'text', inContext: true },
      { id: 'e2', from: 'a1', to: 'out', format: 'text', inContext: true },
    ],
  }
}

/** Validation codes only, for compact assertions. */
function codes(errors: readonly WorkflowValidationError[]): string[] {
  return errors.map(error => error.code)
}

describe('agent-multi workflow validation', () => {
  it('accepts the minimal happy path', () => {
    expect(validateWorkflow(baseDraft())).toEqual([])
  })

  it('rejects a blank name', () => {
    const draft = baseDraft()
    draft.name = '   '
    expect(codes(validateWorkflow(draft))).toContain('name-empty')
  })

  it('rejects a template-unsafe node id', () => {
    const draft = baseDraft()
    draft.nodes[1]!.id = 'bad id!'
    expect(codes(validateWorkflow(draft))).toContain('node-id-invalid')
  })

  it('rejects duplicate node and edge ids', () => {
    const draft = baseDraft()
    draft.nodes.push({ ...draft.nodes[2]! })
    draft.edges.push({ ...draft.edges[1]! })
    const found = codes(validateWorkflow(draft))
    expect(found).toContain('node-id-duplicate')
    expect(found).toContain('edge-id-duplicate')
  })

  it('rejects edges to unknown endpoints and self edges', () => {
    const draft = baseDraft()
    draft.edges.push({ id: 'e3', from: 'ghost', to: 'a1', format: 'text', inContext: true })
    draft.edges.push({ id: 'e4', from: 'a1', to: 'a1', format: 'text', inContext: true })
    const found = codes(validateWorkflow(draft))
    expect(found).toContain('edge-endpoint-unknown')
    expect(found).toContain('edge-self')
  })

  it('rejects edges touching note nodes', () => {
    const draft = baseDraft()
    draft.nodes.push({ kind: 'note', id: 'n1', name: 'Note', text: 'annotation' })
    draft.edges.push({ id: 'e5', from: 'a1', to: 'n1', format: 'text', inContext: true })
    expect(codes(validateWorkflow(draft))).toContain('edge-note')
  })

  it('rejects fromHandle on a handle-less source', () => {
    const draft = baseDraft()
    draft.edges[1]!.fromHandle = 'why'
    expect(codes(validateWorkflow(draft))).toContain('edge-handle-unexpected')
  })

  it('rejects toHandle other than back into a loop', () => {
    const draft = baseDraft()
    draft.edges[1]!.toHandle = 'back'
    expect(codes(validateWorkflow(draft))).toContain('edge-tohandle-invalid')
  })

  it('requires exactly one input and at least one output', () => {
    const draft = baseDraft()
    draft.nodes = draft.nodes.filter((node: NodeSpec) => node.kind !== 'input')
    expect(codes(validateWorkflow(draft))).toContain('input-count')
    const draft2 = baseDraft()
    draft2.nodes = draft2.nodes.filter((node: NodeSpec) => node.kind !== 'output')
    expect(codes(validateWorkflow(draft2))).toContain('output-count')
  })

  it('rejects incoming edges at an input and outgoing edges at an output', () => {
    const draft = baseDraft()
    draft.edges.push({ id: 'e6', from: 'a1', to: 'in', format: 'text', inContext: true })
    draft.edges.push({ id: 'e7', from: 'out', to: 'a1', format: 'text', inContext: true })
    const found = codes(validateWorkflow(draft))
    expect(found).toContain('input-indegree')
    expect(found).toContain('output-outdegree')
  })

  it('rejects router case defects: blank, duplicate, unwired', () => {
    const draft = baseDraft()
    draft.nodes[1] = {
      kind: 'router', id: 'a1', name: 'R',
      cases: ['yes', 'yes', ''],
    }
    draft.edges[1]!.fromHandle = 'yes'
    const found = codes(validateWorkflow(draft))
    expect(found).toContain('router-case-duplicate')
    expect(found).toContain('router-case-blank')
    expect(found).toContain('router-case-unwired')
  })

  it('rejects router out-edges without or with unknown handles', () => {
    const draft = baseDraft()
    draft.nodes[1] = { kind: 'router', id: 'a1', name: 'R', cases: ['yes'] }
    const found = codes(validateWorkflow(draft))
    expect(found).toContain('router-handle-missing')
    draft.edges[1]!.fromHandle = 'nope'
    const found2 = codes(validateWorkflow(draft))
    expect(found2).toContain('router-handle-unknown')
  })

  it('rejects loop out-edges with unknown handles', () => {
    const draft = baseDraft()
    draft.nodes[1] = {
      kind: 'loop', id: 'a1', name: 'L', mode: 'count', count: 2,
      maxIters: 10, collect: true,
    }
    draft.edges[1]!.fromHandle = 'exit'
    expect(codes(validateWorkflow(draft))).toContain('loop-handle-unknown')
  })

  it('requires iterate, done, and back handles on loops, plus mode params', () => {
    const draft = baseDraft()
    draft.nodes[1] = {
      kind: 'loop', id: 'a1', name: 'L', mode: 'items',
      maxIters: 10, collect: true,
    }
    const found = codes(validateWorkflow(draft))
    expect(found).toContain('loop-handle-missing')
    expect(found).toContain('loop-params')
  })

  it('rejects joins with fewer than two in-edges or an out-of-range quorum', () => {
    const draft = baseDraft()
    draft.nodes[2] = { kind: 'join', id: 'out', name: 'J', strategy: 'quorum', quorum: 5 }
    expect(codes(validateWorkflow(draft))).toContain('join-indegree')
    expect(codes(validateWorkflow(draft))).toContain('join-quorum-range')
  })

  it('rejects cycles that bypass every loop back edge', () => {
    const draft = baseDraft()
    draft.nodes.push({
      kind: 'agent', id: 'b1', name: 'B1', systemPrompt: 'you are B1',
      retry: { maxAttempts: 1, backoffMs: 0 }, hitlEnabled: false,
    })
    draft.edges.push({ id: 'e8', from: 'out', to: 'b1', format: 'text', inContext: true })
    draft.edges.push({ id: 'e9', from: 'b1', to: 'a1', format: 'text', inContext: true })
    expect(codes(validateWorkflow(draft))).toContain('cycle-illegal')
  })

  it('accepts a cycle routed through a loop back edge', () => {
    const draft = baseDraft()
    draft.nodes[1] = {
      kind: 'loop', id: 'a1', name: 'L', mode: 'count', count: 2,
      maxIters: 10, collect: true,
    }
    draft.nodes.push({
      kind: 'agent', id: 'b1', name: 'B1', systemPrompt: 'you are B1',
      retry: { maxAttempts: 1, backoffMs: 0 }, hitlEnabled: false,
    })
    draft.edges[1] = { id: 'e2', from: 'a1', fromHandle: 'iterate', to: 'b1', format: 'text', inContext: true }
    draft.edges.push({ id: 'e3', from: 'b1', to: 'a1', toHandle: 'back', format: 'text', inContext: true })
    draft.edges.push({ id: 'e4', from: 'a1', fromHandle: 'done', to: 'out', format: 'text', inContext: true })
    expect(validateWorkflow(draft)).toEqual([])
  })

  it('rejects template references to unknown nodes', () => {
    const draft = baseDraft()
    draft.edges[1]!.template = 'see {{nodes.ghost}} output'
    expect(codes(validateWorkflow(draft))).toContain('template-node-unknown')
  })
})
