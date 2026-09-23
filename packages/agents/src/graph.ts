// Agent graph: DAG projection over sessions (issue #49; design §54, §7,
// §64, §23, §25.2, §69, §49.1).
// Explicit edges over parent/child sessions — first-class queryable
// renderable handoffs without changing the spawn substrate. Refs only:
// edges carry artifact ids + diff refs, never transcripts (§25.2/69).
// Pure data module: no processes, no IPC, no filesystem — faux-tested.
//
// Self-contained on purpose: the agents package must not import host,
// worker, or trajectory (dep-lint), so session ids here are plain strings
// read from task/transfer/spec shapes without importing them.

export const EDGE_KINDS = [
  'produced_by',
  'reviewed_by',
  'handoff',
  'delegated',
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface AgentEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  artifactRefs?: string[];
  diffRef?: string;
}

// Closed-world field coverage: adding or removing an AgentEdge field breaks
// compilation here, so the shape cannot drift silently.
export const EDGE_FIELDS = {
  from: true,
  to: true,
  kind: true,
  artifactRefs: true,
  diffRef: true,
} satisfies Record<keyof AgentEdge, true>;

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

// Append-only store: nodes register once, edges only push. No update or
// remove operation exists — history is never rewritten.
export interface GraphStore {
  nodes: string[];
  edges: AgentEdge[];
}

function checkSessionId(value: unknown, role: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new GraphError(
      `${role} must be 1-128 chars of [A-Za-z0-9._-] (no path separators)`,
    );
  }
  return value;
}

function isEdgeKind(value: unknown): value is EdgeKind {
  return (
    typeof value === 'string' &&
    (EDGE_KINDS as readonly string[]).includes(value)
  );
}

function checkRefList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new GraphError(`${field} must be an array of non-empty strings`);
  }
  return [...value];
}

export function createGraph(): GraphStore {
  return { nodes: [], edges: [] };
}

export function addNode(store: GraphStore, sessionId: string): string {
  const id = checkSessionId(sessionId, 'session id');
  if (!store.nodes.includes(id)) store.nodes.push(id);
  return id;
}

// Reachability over outgoing edges: used to reject an edge that would close
// a cycle before it is appended.
function reaches(
  store: GraphStore,
  from: string,
  target: string,
  seen: Set<string> = new Set(),
): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return store.edges
    .filter((edge) => edge.from === from)
    .some((edge) => reaches(store, edge.to, target, seen));
}

export function addEdge(store: GraphStore, edge: AgentEdge): AgentEdge {
  const from = checkSessionId(edge.from, 'edge from');
  const to = checkSessionId(edge.to, 'edge to');
  if (!isEdgeKind(edge.kind)) {
    throw new GraphError(
      `edge kind must be one of ${EDGE_KINDS.join(', ')} (§54)`,
    );
  }
  if (!store.nodes.includes(from)) {
    throw new GraphError(`unknown session endpoint: '${from}'`);
  }
  if (!store.nodes.includes(to)) {
    throw new GraphError(`unknown session endpoint: '${to}'`);
  }
  if (reaches(store, to, from)) {
    throw new GraphError(`edge ${from} -> ${to} would close a cycle (§54)`);
  }
  if (
    store.edges.some((existing) => existing.from === from && existing.to === to)
  ) {
    throw new GraphError(`duplicate edge ${from} -> ${to}`);
  }
  const stored: AgentEdge = {
    from,
    to,
    kind: edge.kind,
    ...(() => {
      const artifactRefs = checkRefList(edge.artifactRefs, 'artifactRefs');
      return artifactRefs === undefined ? {} : { artifactRefs };
    })(),
    ...(edge.diffRef === undefined ? {} : { diffRef: edge.diffRef }),
  };
  if (
    stored.diffRef !== undefined &&
    (typeof stored.diffRef !== 'string' || stored.diffRef.trim() === '')
  ) {
    throw new GraphError('diffRef must be a non-empty string when present');
  }
  store.edges.push(stored);
  return stored;
}

// Direct downstream neighbours: sessions this session feeds into.
export function consumers(store: GraphStore, sessionId: string): string[] {
  const id = checkSessionId(sessionId, 'session id');
  return store.edges.filter((edge) => edge.from === id).map((edge) => edge.to);
}

// Direct upstream neighbours: sessions feeding into this session.
export function producers(store: GraphStore, sessionId: string): string[] {
  const id = checkSessionId(sessionId, 'session id');
  return store.edges.filter((edge) => edge.to === id).map((edge) => edge.from);
}

// Kahn's algorithm over the append-only edge list. Every producer lands
// before its consumers; a cycle here is unreachable (addEdge rejects) but
// fails closed regardless.
export function topoOrder(store: GraphStore): string[] {
  const indegree = new Map<string, number>();
  for (const node of store.nodes) indegree.set(node, 0);
  for (const edge of store.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const queue = store.nodes.filter((node) => indegree.get(node) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    order.push(node);
    for (const edge of store.edges.filter((entry) => entry.from === node)) {
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }
  if (order.length !== store.nodes.length) {
    throw new GraphError('graph contains a cycle (§54)');
  }
  return order;
}

// Downstream closure of the roots: the roots plus everything reachable from
// them, with only the edges among that set. Nodes keep insertion order.
export function subgraph(store: GraphStore, roots: string[]): GraphStore {
  const seen = new Set<string>();
  const queue = roots.map((root) => checkSessionId(root, 'subgraph root'));
  for (const root of queue) {
    if (!store.nodes.includes(root)) {
      throw new GraphError(`unknown session endpoint: '${root}'`);
    }
    seen.add(root);
  }
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const next of consumers(store, node)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return {
    nodes: store.nodes.filter((node) => seen.has(node)),
    edges: store.edges
      .filter((edge) => seen.has(edge.from) && seen.has(edge.to))
      .map((edge) => ({
        ...edge,
        artifactRefs:
          edge.artifactRefs === undefined ? undefined : [...edge.artifactRefs],
      })),
  };
}

// DAG projection (§49.1): every session renders exactly once as a node line,
// then one line per edge. A shared reviewer with two parents still occupies
// a single node line — the tree-duplication the DAG replaces.
export function renderDag(store: GraphStore): string[] {
  const lines = store.nodes.map((node) => `node ${node}`);
  for (const edge of store.edges) {
    lines.push(`edge ${edge.from} -> ${edge.to} [${edge.kind}]`);
  }
  return lines;
}

export interface CostRollup {
  total: number;
  perNode: Record<string, number>;
}

// DAG cost roll-up (§23): each session counts exactly once however many
// parents share it. Sessions missing from the cost map count zero.
export function rollupCost(
  store: GraphStore,
  costs: Record<string, number>,
): CostRollup {
  const perNode: Record<string, number> = {};
  for (const node of store.nodes) {
    const cost = costs[node] ?? 0;
    if (typeof cost !== 'number' || Number.isNaN(cost) || cost < 0) {
      throw new GraphError(`cost for '${node}' must be a non-negative number`);
    }
    perNode[node] = cost;
  }
  const total = Object.values(perNode).reduce((sum, cost) => sum + cost, 0);
  return { total, perNode };
}

// Persist/attach: plain-JSON snapshot round-trip so edges registered in one
// session reappear intact in another. Re-validated on attach — corrupt or
// cyclic payloads fail closed instead of smuggling history.
export function serializeGraph(store: GraphStore): string {
  return JSON.stringify({ nodes: store.nodes, edges: store.edges });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function attachGraph(snapshot: string): GraphStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot) as unknown;
  } catch {
    throw new GraphError('graph snapshot is not valid JSON');
  }
  if (
    !isObject(parsed) ||
    !Array.isArray(parsed.nodes) ||
    !Array.isArray(parsed.edges)
  ) {
    throw new GraphError('graph snapshot must hold nodes[] and edges[]');
  }
  const store = createGraph();
  for (const node of parsed.nodes) addNode(store, node as string);
  for (const edge of parsed.edges) {
    if (!isObject(edge)) throw new GraphError('graph edge must be an object');
    addEdge(store, {
      from: edge.from as string,
      to: edge.to as string,
      kind: edge.kind as EdgeKind,
      ...(edge.artifactRefs === undefined
        ? {}
        : { artifactRefs: edge.artifactRefs as string[] }),
      ...(edge.diffRef === undefined
        ? {}
        : { diffRef: edge.diffRef as string }),
    });
  }
  return store;
}

// Token economics (§25.4): an edge carries refs + kind, never a transcript,
// so a handoff costs one bounded prompt. The field list is closed —
// 'transcript' can never appear — and the estimate bounds the assertion.
export function estimateEdgeTokens(edge: AgentEdge): {
  approxTokens: number;
  fields: string[];
} {
  const fields = ['from', 'to', 'kind', 'artifactRefs', 'diffRef'];
  return {
    approxTokens: Math.ceil(JSON.stringify(edge).length / 4),
    fields,
  };
}
