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

describe('attachGraph error paths (issue #220)', () => {
  it("rejects 'not json' as invalid JSON", () => {
    expect(() => attachGraph('not json')).toThrow(
      'graph snapshot is not valid JSON',
    );
  });

  it("rejects '{}' without nodes[]/edges[]", () => {
    expect(() => attachGraph('{}')).toThrow(
      'graph snapshot must hold nodes[] and edges[]',
    );
    expect(() => attachGraph('[]')).toThrow(
      'graph snapshot must hold nodes[] and edges[]',
    );
  });

  it('rejects a non-object edge', () => {
    expect(() =>
      attachGraph(JSON.stringify({ nodes: ['a'], edges: [1] })),
    ).toThrow('graph edge must be an object');
  });

  it('rejects a cyclic payload instead of smuggling history', () => {
    const snapshot = JSON.stringify({
      nodes: ['a', 'b'],
      edges: [
        { from: 'a', to: 'b', kind: 'handoff' },
        { from: 'b', to: 'a', kind: 'handoff' },
      ],
    });
    expect(() => attachGraph(snapshot)).toThrow(/would close a cycle/);
  });

  it('rejects a duplicate edge in the payload', () => {
    const snapshot = JSON.stringify({
      nodes: ['a', 'b'],
      edges: [
        { from: 'a', to: 'b', kind: 'handoff' },
        { from: 'a', to: 'b', kind: 'handoff' },
      ],
    });
    expect(() => attachGraph(snapshot)).toThrow('duplicate edge a -> b');
  });

  it('rejects an unknown endpoint in the payload', () => {
    const snapshot = JSON.stringify({
      nodes: ['a'],
      edges: [{ from: 'a', to: 'ghost', kind: 'handoff' }],
    });
    expect(() => attachGraph(snapshot)).toThrow(
      "unknown session endpoint: 'ghost'",
    );
  });

  it('rejects a bad node id in the payload', () => {
    const snapshot = JSON.stringify({ nodes: [''], edges: [] });
    expect(() => attachGraph(snapshot)).toThrow(
      'session id must be 1-128 chars of [A-Za-z0-9._-] (no path separators)',
    );
  });

  it("drops an extra 'transcript' field instead of storing it", () => {
    const snapshot = JSON.stringify({
      nodes: ['a', 'b'],
      edges: [{ from: 'a', to: 'b', kind: 'handoff', transcript: 'smuggled' }],
    });
    const revived = attachGraph(snapshot);
    expect('transcript' in revived.edges[0]).toBe(false);
    expect(consumers(revived, 'a')).toEqual(['b']);
  });
});

describe('addEdge refusals (issue #220)', () => {
  function linked(): ReturnType<typeof createGraph> {
    const store = createGraph();
    addNode(store, 'a');
    addNode(store, 'b');
    return store;
  }

  it("rejects diffRef '' and blank diffRefs", () => {
    for (const diffRef of ['', '   ']) {
      expect(() =>
        addEdge(linked(), { from: 'a', to: 'b', kind: 'handoff', diffRef }),
      ).toThrow('diffRef must be a non-empty string when present');
    }
  });

  it('rejects bad artifactRefs', () => {
    for (const artifactRefs of [['ok', ''], 'nope', [1]]) {
      expect(() =>
        addEdge(linked(), {
          from: 'a',
          to: 'b',
          kind: 'handoff',
          artifactRefs: artifactRefs as unknown as string[],
        }),
      ).toThrow('artifactRefs must be an array of non-empty strings');
    }
  });

  it('rejects a duplicate edge', () => {
    const store = linked();
    addEdge(store, { from: 'a', to: 'b', kind: 'handoff' });
    expect(() =>
      addEdge(store, { from: 'a', to: 'b', kind: 'reviewed_by' }),
    ).toThrow('duplicate edge a -> b');
  });

  it('rejects malformed session ids', () => {
    expect(() => addNode(createGraph(), 'has space')).toThrow(
      'session id must be 1-128 chars of [A-Za-z0-9._-] (no path separators)',
    );
    expect(() =>
      addEdge(linked(), { from: 'a/b', to: 'b', kind: 'handoff' }),
    ).toThrow(
      'edge from must be 1-128 chars of [A-Za-z0-9._-] (no path separators)',
    );
  });

  it('topoOrder fails closed on a hand-built cycle', () => {
    expect(() =>
      topoOrder({
        nodes: ['a', 'b'],
        edges: [
          { from: 'a', to: 'b', kind: 'handoff' },
          { from: 'b', to: 'a', kind: 'handoff' },
        ],
      }),
    ).toThrow('graph contains a cycle (§54)');
  });

  it('rollupCost refuses negative costs by name', () => {
    const store = linked();
    expect(() => rollupCost(store, { a: -1, b: 0 })).toThrow(
      "cost for 'a' must be a non-negative number",
    );
  });
});
