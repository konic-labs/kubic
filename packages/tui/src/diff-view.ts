// Diff rendering: one journal change as a section of the diff and journal
// panels. Pure render functions: the panel (view-panel.ts) owns the document
// and the scrolling.
//
// Structural DiffFileChange mirrors exec FileChange
// (packages/exec/src/journal/diff.ts) WITHOUT importing it: the tui
// package must never import exec/host/agent implementation (dep-lint),
// so only the fields this view reads are typed here. unifiedHunks is a copy
// of exec's unifiedHunks (the TUI cannot import it), so the panels show the
// hunks `kubic diff` prints, drawn the way the transcript's tool cards draw
// theirs (ui/diff-block.ts).

import type { UiTheme } from '@kubic/core/ui/style';
import type { TokenRole } from '@kubic/core/ui/tokens';
import { type DiffRow, renderDiffRows } from './ui/diff-block.js';
import { fitLine, leftRight } from './ui/line.js';
import { fillLine } from './ui/surface.js';

export type DiffOp = 'write' | 'edit' | 'create' | 'delete' | 'rename';

export interface DiffFileChange {
  readonly path: string;
  readonly op: DiffOp;
  readonly toolCallId: string | null;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly unattributed: boolean;
  readonly reversible: boolean;
  readonly before: string | null;
  readonly after: string | null;
}

// Binary detection: journal blobs are text; a NUL byte means the
// tool wrote binary content, which unified hunks must never split.
// Total (never throws): non-string input at runtime (undefined/null
// from a corrupt row) returns false instead of throwing in includes.
/** @internal */
export function isBinaryText(content: string): boolean {
  if (typeof content !== 'string') return false;
  return content.includes('\0');
}

// Changed region plus context lines with real @@ -a,b +c,d @@ headers.
// Mirror of exec unifiedHunks (display only — never parsed back); the
// header counts accumulate while emitting so they can never
// disagree with the lines printed.
/** @internal */
export function unifiedHunks(
  before: string,
  after: string,
  context = 3,
): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];
  const from = Math.max(0, start - context);
  const toA = Math.min(a.length, endA + context);
  const toB = Math.min(b.length, endB + context);
  const body: string[] = [];
  let aCount = 0;
  let bCount = 0;
  const pushCtx = (line: string): void => {
    body.push(` ${line}`);
    aCount++;
    bCount++;
  };
  const pushDel = (line: string): void => {
    body.push(`-${line}`);
    aCount++;
  };
  const pushIns = (line: string): void => {
    body.push(`+${line}`);
    bCount++;
  };
  for (let i = from; i < start; i++) pushCtx(a[i]);
  for (let i = start; i < endA; i++) pushDel(a[i]);
  for (let i = start; i < endB; i++) pushIns(b[i]);
  // The trailing-context min() stays — it is what keeps the hunk honest
  // visually; only the header stops claiming more than was printed.
  for (let i = 0; i < toA - endA && i < toB - endB; i++) {
    pushCtx(a[endA + i]);
  }
  return [`@@ -${from + 1},${aCount} +${from + 1},${bCount} @@`, ...body];
}

// Why a change shows no rows: binary content, or a side whose blob is missing
// (pruned, corrupt, or a reconciliation pre-image). create/delete
// legitimately have one null side.
function placeholderFor(change: DiffFileChange): string | null {
  if (
    (change.before !== null && isBinaryText(change.before)) ||
    (change.after !== null && isBinaryText(change.after))
  ) {
    return 'binary content not shown';
  }
  if (change.before === null && change.op !== 'create') {
    return 'content unavailable (missing before-blob)';
  }
  if (change.after === null && change.op !== 'delete') {
    return 'content unavailable (missing after-blob)';
  }
  return null;
}

// The final newline is a line terminator, not a line: hunked as it is, a
// file ending in `\n` would show an empty last line in every diff.
function withoutFinalNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

const HUNK_HEADER = /^@@ -(\d+),\d+ \+(\d+),\d+ @@$/u;

/**
 * One change as diff-block rows, numbered the way the transcript's tool cards
 * number theirs: removed rows carry the old line number, every other row the
 * new one. A `⋮` gap row stands for unchanged lines left out above or below
 * the hunk. `note` says why there are no rows (binary or missing content, a
 * rename that kept the content, a change to the final newline only).
 */
export function changeRows(
  change: DiffFileChange,
  context = 3,
): { readonly rows: readonly DiffRow[]; readonly note?: string } {
  const placeholder = placeholderFor(change);
  if (placeholder !== null) return { rows: [], note: placeholder };
  const before = withoutFinalNewline(change.before ?? '');
  const after = withoutFinalNewline(change.after ?? '');
  // An empty side has no lines at all (split would give it one empty line),
  // so a created or emptied file is all one kind of row.
  if (before === '' || after === '') {
    if (before === after) return { rows: [], note: 'empty file' };
    const kind = before === '' ? 'add' : 'del';
    return {
      rows: (before === '' ? after : before)
        .split('\n')
        .map((text, index) => ({ kind, number: String(index + 1), text })),
    };
  }
  const [header, ...body] = unifiedHunks(before, after, context);
  const at = header === undefined ? null : HUNK_HEADER.exec(header);
  if (at === null) {
    if (change.op === 'rename') return { rows: [], note: 'content unchanged' };
    return { rows: [], note: 'only the final newline changed' };
  }
  let oldLine = Number(at[1]);
  let newLine = Number(at[2]);
  const rows: DiffRow[] = [];
  const gap: DiffRow = { kind: 'gap', number: '', text: '' };
  if (oldLine > 1) rows.push(gap);
  for (const line of body) {
    const text = line.slice(1);
    if (line.startsWith('-')) {
      rows.push({ kind: 'del', number: String(oldLine), text });
      oldLine += 1;
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', number: String(newLine), text });
      newLine += 1;
    } else {
      rows.push({ kind: 'context', number: String(newLine), text });
      oldLine += 1;
      newLine += 1;
    }
  }
  if (oldLine <= before.split('\n').length) rows.push(gap);
  return { rows };
}

export interface ChangeCounts {
  readonly added: number;
  readonly removed: number;
}

export function countRows(rows: readonly DiffRow[]): ChangeCounts {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added += 1;
    else if (row.kind === 'del') removed += 1;
  }
  return { added, removed };
}

/** `+12 −4` in the diff colours; a zero stays quiet. */
export function renderCounts(ui: UiTheme, counts: ChangeCounts): string {
  const added = ui.fg(counts.added === 0 ? 'fg3' : 'add')(`+${counts.added}`);
  const removed = ui.fg(counts.removed === 0 ? 'fg3' : 'del')(
    `−${counts.removed}`,
  );
  return `${added} ${removed}`;
}

// The op as a word in its own colour: what was born, what died, what moved.
const OP_ROLE: Record<DiffOp, TokenRole> = {
  write: 'info',
  edit: 'info',
  create: 'ok',
  delete: 'err',
  rename: 'warn',
};

/** The op word, padded to `width` so a column of them lines up. */
export function renderOp(ui: UiTheme, op: DiffOp, width = 0): string {
  return ui.fg(OP_ROLE[op])(op.padEnd(width));
}

export interface ChangeRenderOptions {
  /** `1/3` on the header, when the change is one file of several. */
  readonly ordinal?: { readonly index: number; readonly total: number };
}

/**
 * One file's section: a header band (path, op, flags, counts) and its rows,
 * or a note when there are none.
 */
export function renderChange(
  ui: UiTheme,
  change: DiffFileChange,
  width: number,
  options: ChangeRenderOptions = {},
): string[] {
  const { rows, note } = changeRows(change);
  const flags = [
    change.unattributed ? 'unattributed' : null,
    change.reversible ? null : 'not reversible',
  ].filter((flag) => flag !== null);
  const left = `${ui.style({ fg: 'fg0', bold: true })(change.path)}  ${renderOp(ui, change.op)}${
    flags.length === 0 ? '' : ` ${ui.fg('warn')(flags.join(' · '))}`
  }`;
  const ordinal =
    options.ordinal === undefined || options.ordinal.total < 2
      ? ''
      : `  ${ui.fg('fg2')(`${options.ordinal.index}/${options.ordinal.total}`)}`;
  const right = `${renderCounts(ui, countRows(rows))}${ordinal}`;
  const header = fillLine(
    ui,
    ` ${leftRight(left, `${right} `, width - 1)}`,
    width,
    'bg2',
  );
  if (note !== undefined)
    return [header, fitLine(ui.fg('fg2')(`  ~ ${note}`), width)];
  return [header, ...renderDiffRows(ui, rows, width)];
}
