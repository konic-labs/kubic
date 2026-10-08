// JournalView: file→hunks journal diffs.
// Text only. The path filter mirrors `kubic diff --path` (host
// journal-cli.ts over exec diffEntries): exact match on path.
// Each file contributes the ---/+++/`# toolCall=` marker/hunk block exec's
// renderDiff prints for it (the op-labelled header is omitted here — the CLI
// does not print it); the corrupt and content-not-captured markers are not
// drawn. Binary/missing blobs become placeholders via diff-view.ts; this
// module never throws on them.

import type { DiffFileChange, DiffRenderOptions } from './diff-view.js';
import { renderDiffLines } from './diff-view.js';
import type { Component } from './tui-boundary.js';
import { Text } from './tui-boundary.js';

export interface JournalFilter {
  readonly path?: string;
}

// Post-aggregation filter over one FileChange per path (assumes the
// caller passes already-aggregated rows, at most one entry per path): exact
// match on the path.
export function filterJournalChanges(
  changes: ReadonlyArray<DiffFileChange>,
  filter: JournalFilter,
): DiffFileChange[] {
  return changes.filter(
    (change) => filter.path === undefined || change.path === filter.path,
  );
}

// Multi-file text: the per-file blocks of exec's renderDiff, one after the
// other, with the `no changes` empty case journal-cli.ts prints.
export function renderJournalLines(
  changes: ReadonlyArray<DiffFileChange>,
  options: DiffRenderOptions = {},
): string[] {
  if (changes.length === 0) return ['no changes'];
  return changes.flatMap((change) => renderDiffLines(change, options).slice(1));
}

export interface JournalViewOptions extends DiffRenderOptions {
  readonly filter?: JournalFilter;
}

export class JournalView implements Component {
  private readonly body: Text;
  private all: DiffFileChange[];
  private filter: JournalFilter;
  private options: DiffRenderOptions;

  constructor(
    changes: ReadonlyArray<DiffFileChange> = [],
    options: JournalViewOptions = {},
  ) {
    this.body = new Text('');
    this.all = [...changes];
    const { filter, ...rest } = options;
    this.filter = filter ?? {};
    this.options = rest;
    this.paint();
  }

  setChanges(changes: ReadonlyArray<DiffFileChange>): void {
    this.all = [...changes];
    this.paint();
  }

  setFilter(filter: JournalFilter): void {
    this.filter = filter;
    this.paint();
  }

  render(width: number): string[] {
    return this.body.render(width);
  }

  invalidate(): void {
    this.body.invalidate();
  }

  private paint(): void {
    const visible = filterJournalChanges(this.all, this.filter);
    this.body.setText(renderJournalLines(visible, this.options).join('\n'));
  }
}
