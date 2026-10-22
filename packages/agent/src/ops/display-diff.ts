// The display record of a file change: what the TUI
// renders inline under an `edit` or `write` card. It rides the tool result's
// `details` — the UI's record — never the model-facing text, so the model's
// context does not pay for it.
//
// The diff is Pi's display form, one row per line: `+<n> text` (added, new
// line number), `-<n> text` (removed, old line number), ` <n> text`
// (context, new line number) and ` <pad> ...` for a skipped run. The common
// prefix and suffix are trimmed first; the middle is diffed by lines with a
// bounded LCS (a middle too large for it is shown as removed-then-added).

export interface DiffDisplay {
  readonly kind: 'diff';
  readonly text: string;
  /** The first changed line in the new content (1-based). */
  readonly firstChangedLine: number;
  readonly added: number;
  readonly removed: number;
  /** The rows were cut at DISPLAY_DIFF_MAX_ROWS. */
  readonly truncated?: boolean;
}

export interface WriteDisplay {
  readonly kind: 'write';
  readonly newFile: boolean;
  readonly lines: number;
  /** The first PREVIEW lines written. */
  readonly preview: string;
}

export type ToolDisplay = DiffDisplay | WriteDisplay;

const DISPLAY_DIFF_CONTEXT = 3;
/** @internal */
export const DISPLAY_DIFF_MAX_ROWS = 400;
const WRITE_PREVIEW_LINES = 40;
// The LCS table's cell budget (rows × columns of the changed middle).
const LCS_MAX_CELLS = 250_000;

type Op =
  | { readonly kind: 'eq'; readonly text: string }
  | { readonly kind: 'del'; readonly text: string }
  | { readonly kind: 'add'; readonly text: string };

function lcsOps(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length * b.length > LCS_MAX_CELLS) {
    return [
      ...a.map((text): Op => ({ kind: 'del', text })),
      ...b.map((text): Op => ({ kind: 'add', text })),
    ];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', text: a[i] as string });
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      ops.push({ kind: 'del', text: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: b[j] as string });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ kind: 'del', text: a[i++] as string });
  while (j < b.length) ops.push({ kind: 'add', text: b[j++] as string });
  return ops;
}

/** The display diff of two LF texts; undefined when they are equal. */
export function displayDiff(
  before: string,
  after: string,
  context = DISPLAY_DIFF_CONTEXT,
): DiffDisplay | undefined {
  if (before === after) return undefined;
  // A file's final newline ends its last line; it is not an empty line.
  const lines = (text: string): string[] =>
    (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const a = lines(before);
  const b = lines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const lead = Math.min(context, prefix);
  const trail = Math.min(context, suffix);
  const ops: Op[] = [
    ...a.slice(prefix - lead, prefix).map((text): Op => ({ kind: 'eq', text })),
    ...lcsOps(
      a.slice(prefix, a.length - suffix),
      b.slice(prefix, b.length - suffix),
    ),
    ...a
      .slice(a.length - suffix, a.length - suffix + trail)
      .map((text): Op => ({ kind: 'eq', text })),
  ];
  // Number every op, then keep the changes and `context` lines around each.
  let oldLine = prefix - lead + 1;
  let newLine = prefix - lead + 1;
  const numbered = ops.map((op) => {
    const row = { op, oldLine, newLine };
    if (op.kind !== 'add') oldLine += 1;
    if (op.kind !== 'del') newLine += 1;
    return row;
  });
  const keep = new Array<boolean>(numbered.length).fill(false);
  numbered.forEach((row, index) => {
    if (row.op.kind === 'eq') return;
    for (
      let at = Math.max(0, index - context);
      at <= Math.min(numbered.length - 1, index + context);
      at += 1
    ) {
      keep[at] = true;
    }
  });
  const digits = String(Math.max(oldLine, newLine)).length;
  const rows: string[] = [];
  let added = 0;
  let removed = 0;
  let first: number | undefined;
  let skipped = false;
  numbered.forEach((row, index) => {
    if (row.op.kind === 'add') added += 1;
    if (row.op.kind === 'del') removed += 1;
    if (first === undefined && row.op.kind !== 'eq') first = row.newLine;
    if (!keep[index]) {
      if (!skipped && rows.length > 0) rows.push(` ${' '.repeat(digits)} ...`);
      skipped = true;
      return;
    }
    skipped = false;
    if (row.op.kind === 'del') {
      rows.push(`-${String(row.oldLine).padStart(digits)} ${row.op.text}`);
    } else if (row.op.kind === 'add') {
      rows.push(`+${String(row.newLine).padStart(digits)} ${row.op.text}`);
    } else {
      rows.push(` ${String(row.newLine).padStart(digits)} ${row.op.text}`);
    }
  });
  // A gap row cannot end the diff: the skipped run was the trailing context.
  if ((rows.at(-1) ?? '').endsWith(' ...') && skipped) rows.pop();
  const truncated = rows.length > DISPLAY_DIFF_MAX_ROWS;
  return {
    kind: 'diff',
    text: rows.slice(0, DISPLAY_DIFF_MAX_ROWS).join('\n'),
    firstChangedLine: first ?? prefix + 1,
    added,
    removed,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** What a write put down: its size and the first lines. */
export function writeDisplay(content: string, newFile = true): WriteDisplay {
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  return {
    kind: 'write',
    newFile,
    lines: lines.length,
    preview: lines.slice(0, WRITE_PREVIEW_LINES).join('\n'),
  };
}
