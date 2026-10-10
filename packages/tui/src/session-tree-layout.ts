// The session tree's shape on screen, drawn the way pi draws its tree. Each
// child of a branch point gets a connector (├─, └─ for the last) and one more
// level of indent; a chain of single children stays flat; the first
// generation after a branch steps in once more, so a subtree reads as a
// group; and a gutter (│) carries each open branch down past its
// descendants. At every branch point the branch holding the current entry is
// listed first. Several roots hang off a virtual root that is never drawn.

export interface LayoutNode {
  readonly id: string;
  /** The entry this one follows; null for a root. */
  readonly parentId: string | null;
}

/** A gutter at an indent level: `│` while its branch has more siblings. */
interface Gutter {
  readonly position: number;
  readonly show: boolean;
}

export interface TreeRow {
  readonly id: string;
  /** Indent level; each level is three cells. */
  readonly indent: number;
  /** Drawn with ├─ or └─: its parent branches. */
  readonly showConnector: boolean;
  /** The last sibling (└─). */
  readonly isLast: boolean;
  readonly gutters: readonly Gutter[];
  /** A root under the virtual root: its connector is not drawn. */
  readonly virtualRootChild: boolean;
}

export interface TreeLayout {
  /** The visible rows, in reading order. */
  readonly rows: readonly TreeRow[];
  /** Each visible row's nearest visible ancestor (null for a root). */
  readonly parentOf: ReadonlyMap<string, string | null>;
  /** Each visible row's visible children, in reading order (null: roots). */
  readonly childrenOf: ReadonlyMap<string | null, readonly string[]>;
  readonly multipleRoots: boolean;
}

// Every node in reading order: depth first, children in their given order
// except that the child on the current path comes first.
function readingOrder(
  nodes: readonly LayoutNode[],
  onPath: ReadonlySet<string>,
): string[] {
  const known = new Set(nodes.map((node) => node.id));
  const children = new Map<string | null, string[]>();
  for (const node of nodes) {
    const parent =
      node.parentId !== null && known.has(node.parentId) ? node.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(node.id);
    children.set(parent, list);
  }
  const pathFirst = (ids: readonly string[]): string[] => [
    ...ids.filter((id) => onPath.has(id)),
    ...ids.filter((id) => !onPath.has(id)),
  ];
  const order: string[] = [];
  const stack = pathFirst(children.get(null) ?? []).reverse();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    order.push(id);
    stack.push(...pathFirst(children.get(id) ?? []).reverse());
  }
  return order;
}

type Pending = {
  readonly id: string;
  readonly indent: number;
  readonly justBranched: boolean;
  readonly showConnector: boolean;
  readonly isLast: boolean;
  readonly gutters: readonly Gutter[];
  readonly virtualRootChild: boolean;
};

/**
 * Lay out the visible nodes. A hidden node's children attach to its nearest
 * visible ancestor, so filtering never leaves a row floating.
 */
export function layoutTree(
  nodes: readonly LayoutNode[],
  visible: ReadonlySet<string>,
  onPath: ReadonlySet<string>,
): TreeLayout {
  const parent = new Map(nodes.map((node) => [node.id, node.parentId]));
  const nearestVisible = (id: string): string | null => {
    let current = parent.get(id) ?? null;
    while (current !== null && !visible.has(current)) {
      current = parent.get(current) ?? null;
    }
    return current;
  };
  const parentOf = new Map<string, string | null>();
  const childrenOf = new Map<string | null, string[]>([[null, []]]);
  for (const id of readingOrder(nodes, onPath)) {
    if (!visible.has(id)) continue;
    const above = nearestVisible(id);
    parentOf.set(id, above);
    const list = childrenOf.get(above) ?? [];
    list.push(id);
    childrenOf.set(above, list);
  }
  const roots = childrenOf.get(null) ?? [];
  const multipleRoots = roots.length > 1;
  const rows: TreeRow[] = [];
  const stack: Pending[] = roots
    .map((id, index) => ({
      id,
      indent: multipleRoots ? 1 : 0,
      justBranched: multipleRoots,
      showConnector: multipleRoots,
      isLast: index === roots.length - 1,
      gutters: [],
      virtualRootChild: multipleRoots,
    }))
    .reverse();
  while (stack.length > 0) {
    const row = stack.pop() as Pending;
    rows.push({
      id: row.id,
      indent: row.indent,
      showConnector: row.showConnector,
      isLast: row.isLast,
      gutters: row.gutters,
      virtualRootChild: row.virtualRootChild,
    });
    const children = childrenOf.get(row.id) ?? [];
    const branches = children.length > 1;
    // A branch point steps its children in; so does the first generation
    // after a branch (below the top level); a single-child chain stays flat.
    const childIndent =
      branches || (row.justBranched && row.indent > 0)
        ? row.indent + 1
        : row.indent;
    // A drawn connector leaves a gutter at its column for the descendants.
    const drawn = row.showConnector && !row.virtualRootChild;
    const displayIndent = multipleRoots
      ? Math.max(0, row.indent - 1)
      : row.indent;
    const childGutters = drawn
      ? [
          ...row.gutters,
          { position: Math.max(0, displayIndent - 1), show: !row.isLast },
        ]
      : row.gutters;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        id: children[index] as string,
        indent: childIndent,
        justBranched: branches,
        showConnector: branches,
        isLast: index === children.length - 1,
        gutters: childGutters,
        virtualRootChild: false,
      });
    }
  }
  return { rows, parentOf, childrenOf, multipleRoots };
}
