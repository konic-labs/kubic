// JournalView: file→hunks journal diffs (issue #25; §80, §42).
// Text only. Filters mirror `kubic diff --path/--agent` (host
// journal-cli.ts over exec diffEntries): exact match on path and agent.
// The flattened text is line-for-line equal to `kubic diff` output:
// each file contributes the CLI-identical ---/+++/attribution/hunk
// block (the DiffView op-labelled header is omitted here — the CLI
// does not print it). Binary/missing blobs become placeholders via
// diff-view.ts; this module never throws on them.

import type { DiffFileChange, DiffRenderOptions } from './diff-view.js';
import { renderDiffLines } from './diff-view.js';
import type { Component } from './tui-boundary.js';
import { Text } from './tui-boundary.js';

export interface JournalFilter {
  readonly path?: string;
  readonly agent?: string;
}

// Post-aggregation filter over one FileChange per path (assumes the
// caller passes already-aggregated rows, at most one entry per path).
// NOTE: this diverges from CLI diffEntries (exec journal-diff.ts),
// which filters raw journal rows BEFORE aggregation: a path with
// mixed-agent history keeps only matching rows there, while here the
// agent predicate tests the aggregated row's last-agentId. Same exact-
// match predicate otherwise: path (resp. agentId) equals the filter.
export function filterJournalChanges(
  changes: ReadonlyArray<DiffFileChange>,
  filter: JournalFilter,
): DiffFileChange[] {
  return changes.filter(
    (change) =>
      (filter.path === undefined || change.path === filter.path) &&
      (filter.agent === undefined || change.agentId === filter.agent),
  );
}

// CLI-identical multi-file text (mirrors exec renderDiff joined per
// file, including the `no changes` empty case from journal-cli.ts).
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
