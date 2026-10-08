// Diff rendering: single-file journal diffs.
// Text only (fallback carries the whole view — no image diffs).
// Pure render functions: the panel (view-panel.ts) owns the document and the
// scrolling, so there is no per-view Component wrapper left here.
//
// Structural DiffFileChange mirrors exec FileChange
// (packages/exec/src/journal-diff.ts) WITHOUT importing it: the tui
// package must never import exec/host/worker implementation (dep-lint),
// so only the fields this view reads are typed here. unifiedHunks
// mirrors exec's algorithm line-for-line so TUI hunks equal
// `kubic diff` hunks; the ---/+++/attribution block below is byte-equal
// to exec renderDiff's per-file block (the op label lives on the
// op-labelled header line, which the CLI does not print).

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

export interface DiffRenderOptions {
  readonly context?: number;
  readonly width?: number;
  readonly maxLines?: number;
  // `(file k/N)` appended to the op-labelled header, so a
  // multi-file panel says which file of how many it is showing. Only the TUI
  // diff panel sets it — `kubic diff` parity output never carries it (the
  // journal view drops the op-labelled header line entirely).
  readonly fileOrdinal?: { readonly index: number; readonly total: number };
}

// Binary detection: journal blobs are text; a NUL byte means the
// tool wrote binary content, which unified hunks must never split.
// Total (never throws): non-string input at runtime (undefined/null
// from a corrupt row) returns false instead of throwing in includes.
export function isBinaryText(content: string): boolean {
  if (typeof content !== 'string') return false;
  return content.includes('\0');
}

// Changed region plus context lines with real @@ -a,b +c,d @@ headers.
// Mirror of exec unifiedHunks (display only — never parsed back); the
// header counts accumulate while emitting so they can never
// disagree with the lines printed.
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

// Path header with the op label (write/edit/create/delete/rename) plus
// the unattributed badge for reconciliation-only entries.
export function renderDiffHeader(change: DiffFileChange): string {
  return `${change.path} — ${change.op}${change.unattributed ? ' [unattributed]' : ''}`;
}

function placeholderFor(change: DiffFileChange): string | null {
  if (
    (change.before !== null && isBinaryText(change.before)) ||
    (change.after !== null && isBinaryText(change.after))
  ) {
    return `~ binary content not shown: ${change.path}`;
  }
  // create/delete legitimately have one null side; any other null side
  // is a missing blob (pruned, corrupt, or reconciliation pre-image).
  if (change.before === null && change.op !== 'create') {
    return `~ content unavailable: ${change.path} (missing before-blob)`;
  }
  if (change.after === null && change.op !== 'delete') {
    return `~ content unavailable: ${change.path} (missing after-blob)`;
  }
  return null;
}

function truncateLine(line: string, width: number): string {
  if (line.length <= width) return line;
  if (width <= 0) return '';
  return `${line.slice(0, width - 1)}…`;
}

// Full single-file view: op-labelled header, then the CLI-identical
// block (---/+++/attribution/hunks) so everything below line 0 matches
// `kubic diff` exactly. Placeholders replace hunks for binary/missing
// content — the view never throws on null or binary sides.
export function renderDiffLines(
  change: DiffFileChange,
  options: DiffRenderOptions = {},
): string[] {
  const who = `toolCall=${change.toolCallId ?? 'none'}`;
  const flags = [
    change.unattributed ? 'unattributed' : null,
    change.reversible ? null : 'non-reversible',
  ].filter((f) => f !== null);
  const header = renderDiffHeader(change);
  let lines = [
    options.fileOrdinal === undefined
      ? header
      : `${header} (file ${options.fileOrdinal.index}/${options.fileOrdinal.total})`,
    `--- a/${change.path}`,
    `+++ b/${change.path}`,
    `# ${who}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`,
  ];
  const placeholder = placeholderFor(change);
  if (placeholder !== null) {
    lines.push(placeholder);
  } else {
    lines.push(
      ...unifiedHunks(
        change.before ?? '',
        change.after ?? '',
        options.context ?? 3,
      ),
    );
  }
  if (options.width !== undefined) {
    const w = Math.max(0, Math.floor(options.width));
    lines = lines.map((line) => truncateLine(line, w));
  }
  if (options.maxLines !== undefined) {
    const max = Math.max(0, Math.floor(options.maxLines));
    if (lines.length > max) {
      const dropped = lines.length - max;
      lines = [...lines.slice(0, max), `… (${dropped} more lines)`];
    }
  }
  return lines;
}
