// The journal panel's document: every change in the session journal as one
// row (what happened to which file, how many lines, when), then each file's
// own section of hunks. The path filter mirrors `kubic diff --path` (host
// journal-cli.ts over exec diffEntries): exact match on the path.

import type { UiTheme } from '@kubic/core/ui/style';
import {
  type ChangeCounts,
  changeRows,
  countRows,
  type DiffFileChange,
  renderChange,
  renderCounts,
  renderOp,
} from './diff-view.js';
import { fitLine, leftRight } from './ui/line.js';

export interface JournalFilter {
  readonly path?: string;
}

// Post-aggregation filter over one FileChange per path (assumes the
// caller passes already-aggregated rows, at most one entry per path): exact
// match on the path.
/** @internal */
export function filterJournalChanges(
  changes: ReadonlyArray<DiffFileChange>,
  filter: JournalFilter,
): DiffFileChange[] {
  return changes.filter(
    (change) => filter.path === undefined || change.path === filter.path,
  );
}

// The local wall-clock minute of a change: `14:05`.
function clock(timestamp: number): string {
  const at = new Date(timestamp);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(at.getHours())}:${two(at.getMinutes())}`;
}

const countsText = (counts: ChangeCounts): string =>
  `+${counts.added} −${counts.removed}`;

/** The added and removed lines of every change, summed. */
export function totalCounts(
  changes: ReadonlyArray<DiffFileChange>,
): ChangeCounts {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const counts = countRows(changeRows(change).rows);
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed };
}

/**
 * The list, then the sections. The counts column is right-aligned across the
 * rows, so a long session reads as a table.
 */
export function renderJournalLines(
  ui: UiTheme,
  changes: ReadonlyArray<DiffFileChange>,
  width: number,
): string[] {
  if (changes.length === 0) return [fitLine(ui.fg('fg2')('no changes'), width)];
  const counted = changes.map((change) => ({
    change,
    counts: countRows(changeRows(change).rows),
  }));
  const column = Math.max(
    ...counted.map(({ counts }) => countsText(counts).length),
  );
  const list = counted.map(({ change, counts }) => {
    const pad = ' '.repeat(column - countsText(counts).length);
    const flag = change.unattributed
      ? `  ${ui.fg('warn')('unattributed')}`
      : '';
    const left = ` ${renderOp(ui, change.op, 6)}  ${ui.fg('fg0')(change.path)}${flag}`;
    const right = `${pad}${renderCounts(ui, counts)}  ${ui.fg('fg2')(clock(change.timestamp))} `;
    return leftRight(left, right, width);
  });
  const sections = changes.flatMap((change) => [
    '',
    ...renderChange(ui, change, width),
  ]);
  return [...list, ...sections];
}
