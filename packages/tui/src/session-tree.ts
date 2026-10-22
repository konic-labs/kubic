// The session tree's state: the entries, which of them show (the filter, the
// search, the folded branches), the selection and how it moves. The rules
// follow pi's tree selector, so the two behave alike: arrows wrap, a page
// moves by the visible height, a branch key folds a branch or jumps to the
// start of the segment, and a filter or a search keeps the selection on the
// same entry, or on its nearest visible ancestor. Presentation only: the
// composition root builds the entries from the session's branches.
import {
  layoutTree,
  type TreeLayout,
  type TreeRow,
} from './session-tree-layout.js';

/** What an entry is, for its colour and for the filters. */
/** @internal */
export type TreeEntryKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'system'
  | 'compaction'
  | 'reset'
  | 'custom';

export interface TreeEntryLike {
  readonly id: string;
  /** The entry this one follows; null for the first. */
  readonly parentId: string | null;
  readonly kind: TreeEntryKind;
  /**
   * The entry on one line: a prompt's or a reply's text, `bash: ls` for a
   * tool result, the summary of a compaction, the kind of a custom entry.
   */
  readonly text: string;
  /** A reply with no text: aborted, failed (with `text` the error), or empty. */
  readonly state?: 'aborted' | 'error' | 'empty';
  /** The entry's full text, for copying. */
  readonly copyText?: string;
  readonly label?: string;
  /** When the label was set, ISO 8601. */
  readonly labelAt?: string;
}

export type TreeFilter =
  | 'default'
  | 'no-tools'
  | 'user-only'
  | 'labeled-only'
  | 'all';

/** The filters in the order the cycle keys step through them. */
const TREE_FILTERS: readonly TreeFilter[] = [
  'default',
  'no-tools',
  'user-only',
  'labeled-only',
  'all',
];

export interface SessionTreeOptions {
  /** How many rows the list shows; a page moves by this much. */
  readonly maxVisible: number;
  readonly filter?: TreeFilter;
  /** Where the selection starts (default: the current entry). */
  readonly selectedId?: string;
}

// The searchable text of an entry: its label, its kind and its text.
function searchableText(entry: TreeEntryLike): string {
  return [entry.label ?? '', entry.kind, entry.text].join(' ').toLowerCase();
}

/**
 * The tree over `entries`, which come parents first (entry ids only grow, so
 * id order is enough), and the entry the session is at.
 */
export class SessionTreeState {
  readonly maxVisible: number;
  readonly currentId: string | null;
  private readonly entries: readonly TreeEntryLike[];
  private readonly byId: Map<string, TreeEntryLike>;
  // The path from the first entry to the current one.
  private readonly onPath: ReadonlySet<string>;
  private readonly folded = new Set<string>();
  private filterMode: TreeFilter;
  private query = '';
  private layout: TreeLayout = {
    rows: [],
    parentOf: new Map(),
    childrenOf: new Map(),
    multipleRoots: false,
  };
  private index = 0;
  private lastSelected: string | null = null;
  labelTimes = false;

  constructor(
    entries: readonly TreeEntryLike[],
    currentId: string | null,
    options: SessionTreeOptions,
  ) {
    this.entries = entries;
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
    this.currentId = currentId;
    this.maxVisible = Math.max(1, Math.floor(options.maxVisible));
    this.filterMode = options.filter ?? 'default';
    const path = new Set<string>();
    for (let id = currentId; id !== null; ) {
      const entry = this.byId.get(id);
      if (entry === undefined || path.has(id)) break;
      path.add(id);
      id = entry.parentId;
    }
    this.onPath = path;
    this.lastSelected = options.selectedId ?? currentId;
    this.refresh();
  }

  get rows(): readonly TreeRow[] {
    return this.layout.rows;
  }

  get multipleRoots(): boolean {
    return this.layout.multipleRoots;
  }

  get selectedIndex(): number {
    return this.index;
  }

  get filter(): TreeFilter {
    return this.filterMode;
  }

  get search(): string {
    return this.query;
  }

  entry(id: string): TreeEntryLike | undefined {
    return this.byId.get(id);
  }

  selected(): TreeEntryLike | undefined {
    const row = this.layout.rows[this.index];
    return row === undefined ? undefined : this.byId.get(row.id);
  }

  isOnPath(id: string): boolean {
    return this.onPath.has(id);
  }

  isFolded(id: string): boolean {
    return this.folded.has(id);
  }

  /**
   * A row folds when it has visible children and starts a segment: a root,
   * or a child of a branch point.
   */
  isFoldable(id: string): boolean {
    const children = this.layout.childrenOf.get(id);
    if (children === undefined || children.length === 0) return false;
    const parent = this.layout.parentOf.get(id);
    if (parent === null || parent === undefined) return true;
    return (this.layout.childrenOf.get(parent)?.length ?? 0) > 1;
  }

  /** One row up or down, wrapping at the ends. */
  step(delta: 1 | -1): void {
    const count = this.layout.rows.length;
    if (count === 0) return;
    this.index = (this.index + delta + count) % count;
    this.remember();
  }

  /** A page up or down, stopping at the ends. */
  page(delta: 1 | -1): void {
    const last = Math.max(0, this.layout.rows.length - 1);
    this.index = Math.min(
      last,
      Math.max(0, this.index + delta * this.maxVisible),
    );
    this.remember();
  }

  /** Fold the selected segment, or go up to the start of its segment. */
  foldOrUp(): void {
    const id = this.layout.rows[this.index]?.id;
    if (id !== undefined && this.isFoldable(id) && !this.folded.has(id)) {
      this.folded.add(id);
      this.refresh();
      return;
    }
    this.index = this.segmentStart('up');
    this.remember();
  }

  /** Unfold the selected segment, or go down to the next branch point. */
  unfoldOrDown(): void {
    const id = this.layout.rows[this.index]?.id;
    if (id !== undefined && this.folded.has(id)) {
      this.folded.delete(id);
      this.refresh();
      return;
    }
    this.index = this.segmentStart('down');
    this.remember();
  }

  /**
   * A filter key: its filter, or back to the default when it is already on
   * (the default key always selects the default).
   */
  toggleFilter(mode: TreeFilter): void {
    this.filterMode =
      mode !== 'default' && this.filterMode === mode ? 'default' : mode;
    this.folded.clear();
    this.refresh();
  }

  cycleFilter(delta: 1 | -1): void {
    const at = TREE_FILTERS.indexOf(this.filterMode);
    this.filterMode = TREE_FILTERS[
      (at + delta + TREE_FILTERS.length) % TREE_FILTERS.length
    ] as TreeFilter;
    this.folded.clear();
    this.refresh();
  }

  /** The search: every word of it must appear in an entry that shows. */
  setSearch(query: string): void {
    if (query === this.query) return;
    this.query = query;
    this.folded.clear();
    this.refresh();
  }

  /** A label set (or removed with `undefined`) from the label input. */
  setLabel(id: string, label: string | undefined, at: string): void {
    const entry = this.byId.get(id);
    if (entry === undefined) return;
    const { label: _old, labelAt: _oldAt, ...rest } = entry;
    this.byId.set(
      id,
      label === undefined ? rest : { ...rest, label, labelAt: at },
    );
    this.refresh();
  }

  private remember(): void {
    const id = this.layout.rows[this.index]?.id;
    if (id !== undefined) this.lastSelected = id;
  }

  private visible(entry: TreeEntryLike): boolean {
    const isCurrent = entry.id === this.currentId;
    // A reply that only called tools says nothing on its own line; it shows
    // when it failed or was cut short, and always when it is the current
    // entry, so the current position is never hidden.
    if (entry.kind === 'assistant' && entry.state === 'empty' && !isCurrent) {
      return false;
    }
    // The positional system entry carries no text of its own, and a custom
    // entry is Kubic's bookkeeping: both show only under `all`.
    const bookkeeping = entry.kind === 'custom' || entry.kind === 'system';
    switch (this.filterMode) {
      case 'user-only':
        return entry.kind === 'user';
      case 'no-tools':
        return !bookkeeping && entry.kind !== 'tool';
      case 'labeled-only':
        return entry.label !== undefined;
      case 'all':
        return true;
      default:
        return !bookkeeping;
    }
  }

  private refresh(): void {
    const tokens = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = new Set<string>();
    for (const entry of this.entries) {
      const current = this.byId.get(entry.id) as TreeEntryLike;
      if (!this.visible(current)) continue;
      const text = searchableText(current);
      if (tokens.every((token) => text.includes(token))) shown.add(entry.id);
    }
    // A folded row hides everything below it. Entries come parents first,
    // so one pass carries the fold down.
    if (this.folded.size > 0) {
      const below = new Set<string>();
      for (const entry of this.entries) {
        const up = entry.parentId;
        if (up !== null && (this.folded.has(up) || below.has(up))) {
          below.add(entry.id);
          shown.delete(entry.id);
        }
      }
    }
    this.layout = layoutTree(this.entries, shown, this.onPath);
    this.index = this.nearestVisible(this.lastSelected);
    this.remember();
  }

  // The row of an entry, or of its nearest visible ancestor; the last row
  // when nothing on its path shows.
  private nearestVisible(id: string | null): number {
    const rows = this.layout.rows;
    if (rows.length === 0) return 0;
    const at = new Map(rows.map((row, index) => [row.id, index]));
    for (let current = id; current !== null; ) {
      const index = at.get(current);
      if (index !== undefined) return index;
      current = this.byId.get(current)?.parentId ?? null;
    }
    return rows.length - 1;
  }

  // The next segment start (the first row after a branch point) up the
  // visible ancestors, or down the first children.
  private segmentStart(direction: 'up' | 'down'): number {
    const rows = this.layout.rows;
    const at = new Map(rows.map((row, index) => [row.id, index]));
    let current = rows[this.index]?.id;
    if (current === undefined) return this.index;
    if (direction === 'down') {
      for (;;) {
        const children: readonly string[] =
          this.layout.childrenOf.get(current) ?? [];
        if (children.length === 0) return at.get(current) ?? this.index;
        if (children.length > 1)
          return at.get(children[0] as string) ?? this.index;
        current = children[0] as string;
      }
    }
    for (;;) {
      const parent: string | null = this.layout.parentOf.get(current) ?? null;
      if (parent === null) return at.get(current) ?? this.index;
      const siblings = this.layout.childrenOf.get(parent) ?? [];
      const start = at.get(current) ?? this.index;
      if (siblings.length > 1 && start < this.index) return start;
      current = parent;
    }
  }
}
