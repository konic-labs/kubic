import { describe, expect, it } from 'vitest';
import type { EdgeKind } from './graph.js';
import {
  addEdge,
  addNode,
  attachGraph,
  consumers,
  createGraph,
  EDGE_FIELDS,
  estimateEdgeTokens,
  producers,
  renderDag,
  rollupCost,
  serializeGraph,
  subgraph,
  topoOrder,
} from './graph.js';

// §54 fixture: backend + frontend both feed one shared reviewer.
function diamondGraph() {
  const store = createGraph();
  addNode(store, 'backend');
  addNode(store, 'frontend');
  addNode(store, 'reviewer');
  addEdge(store, { from: 'backend', to: 'reviewer', kind: 'reviewed_by' });
  addEdge(store, { from: 'frontend', to: 'reviewer', kind: 'reviewed_by' });
  return store;
}

describe('graph (issue #49, §54)', () => {
  it('§54 fixture: consumers(backend)={reviewer}, producers(reviewer)={backend,frontend}', () => {
    const store = diamondGraph();
    expect(consumers(store, 'backend')).toEqual(['reviewer']);
    expect(producers(store, 'reviewer')).toEqual(['backend', 'frontend']);
  });

  it('DAG projection renders the shared reviewer once with two parents', () => {
    const store = diamondGraph();
    const lines = renderDag(store);
    expect(lines.filter((line) => line === 'node reviewer')).toHaveLength(1);
    expect(lines.filter((line) => line.includes('-> reviewer'))).toHaveLength(
      2,
    );
  });

  it('cycle rejected: reviewer->backend would close a loop', () => {
    const store = diamondGraph();
    expect(() =>
      addEdge(store, { from: 'reviewer', to: 'backend', kind: 'handoff' }),
    ).toThrow(/cycle/i);
  });

  it('self-edge rejected as a cycle', () => {
    const store = createGraph();
    addNode(store, 'solo');
    expect(() =>
      addEdge(store, { from: 'solo', to: 'solo', kind: 'delegated' }),
    ).toThrow(/cycle/i);
  });

  it('missing endpoint rejected', () => {
    const store = createGraph();
    addNode(store, 'backend');
    expect(() =>
      addEdge(store, { from: 'backend', to: 'ghost', kind: 'handoff' }),
    ).toThrow(/unknown session/i);
    expect(() =>
      addEdge(store, { from: 'ghost', to: 'backend', kind: 'handoff' }),
    ).toThrow(/unknown session/i);
  });

  it('edges survive persist/attach round-trip', () => {
    const store = diamondGraph();
    const revived = attachGraph(serializeGraph(store));
    expect(consumers(revived, 'backend')).toEqual(['reviewer']);
    expect(producers(revived, 'reviewer')).toEqual(['backend', 'frontend']);
    expect(topoOrder(revived)).toEqual(topoOrder(store));
  });

  it('shared reviewer cost counted once', () => {
    const store = diamondGraph();
    const costs = { backend: 10, frontend: 20, reviewer: 5 };
    expect(rollupCost(store, costs).total).toBe(35);
  });

  it('implementer→debugger edge carries refs; debugger starts with no transcript copy (§25.4)', () => {
    const store = createGraph();
    addNode(store, 'implementer');
    addNode(store, 'debugger');
    addEdge(store, {
      from: 'implementer',
      to: 'debugger',
      kind: 'handoff',
      artifactRefs: ['artifact-1'],
      diffRef: 'diffs/impl-1.diff',
    });
    const revived = attachGraph(serializeGraph(store));
    const edge = revived.edges[0] as unknown as Record<string, unknown>;
    expect(edge.artifactRefs).toEqual(['artifact-1']);
    expect(edge.diffRef).toBe('diffs/impl-1.diff');
    expect('transcript' in edge).toBe(false);
    const estimate = estimateEdgeTokens(revived.edges[0]);
    expect(estimate.fields).not.toContain('transcript');
    expect(estimate.approxTokens).toBeLessThan(100);
  });

  it('topoOrder places producers before consumers', () => {
    const store = diamondGraph();
    const order = topoOrder(store);
    expect(order.indexOf('backend')).toBeLessThan(order.indexOf('reviewer'));
    expect(order.indexOf('frontend')).toBeLessThan(order.indexOf('reviewer'));
  });

  it('subgraph returns the downstream closure of the roots', () => {
    const store = diamondGraph();
    const sub = subgraph(store, ['backend']);
    expect([...sub.nodes].sort()).toEqual(['backend', 'reviewer']);
    expect(sub.edges).toHaveLength(1);
  });

  it('unknown edge kind rejected', () => {
    const store = createGraph();
    addNode(store, 'a');
    addNode(store, 'b');
    expect(() =>
      addEdge(store, {
        from: 'a',
        to: 'b',
        kind: 'merged' as unknown as EdgeKind,
      }),
    ).toThrow(/kind/i);
  });

  it('edge closed-world fields are exactly the five markers', () => {
    expect(Object.keys(EDGE_FIELDS).sort()).toEqual([
      'artifactRefs',
      'diffRef',
      'from',
      'kind',
      'to',
    ]);
    // Values are the closed-world marker: flipping any field to false must
    // fail (mutation: BooleanLiteral true→false).
    expect(EDGE_FIELDS).toEqual({
      from: true,
      to: true,
      kind: true,
      artifactRefs: true,
      diffRef: true,
    });
  });
});
