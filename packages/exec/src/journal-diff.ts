// Journal diff core (issue #18, slice A; §42.2).
// Pure over journal entries: one FileChange per path (earliest before,
// latest after, latest attribution), plus unified-hunk rendering shared
// by the CLI and the future TUI views ("TUI consumes same data").

import {
  type FileJournalStore,
  isUndoableCreate,
  type JournalEntry,
  type JournalOp,
} from './journal.js';

/**
 * Issue #378: the file ops — every `JournalOp` except the sweep's HEAD-move
 * `marker`. `diffEntries` skips markers, so a `FileChange` can never carry
 * one; the narrower type keeps the TUI's file-op views (`DiffOp`) assignable
 * without teaching them about journal bookkeeping.
 */
export type FileOp = Exclude<JournalOp, 'marker'>;

export interface FileChange {
  path: string;
  op: FileOp;
  agentId: string;
  toolCallId: string | null;
  sessionId: string;
  timestamp: number;
  unattributed: boolean;
  reversible: boolean;
  before: string | null;
  after: string | null;
  // Issue #111: before/after content is unexpectedly missing while its hash
  // is recorded (corrupt or torn blob, or a delta that cannot be
  // reconstructed) — surfaced so the operator can tell "content is what I
  // think it is" from "the journal lost it". Designed absences (unattributed
  // entries' hash-only pre-images, deletes' null after-side, and the sweep's
  // hash-only after-sides, issue #120) are not corrupt.
  corrupt: boolean;
  // Issue #120: the after-side was deliberately not captured — the sweep
  // found a changed file above MAX_SWEEP_CONTENT_BYTES, or whose utf-8
  // decode was lossy (binary content). A designed absence, never corruption;
  // `afterBytes` carries the observed size for the size-only render.
  afterOmitted: boolean;
  afterBytes?: number;
  // Issue #126: set on the `diff --json` projection when `before`/`after`
  // were clipped to the `--max-content-bytes` bound (the clipped text ends
  // with a marker line naming the bound). Absent — never true — on the full
  // core read, which `undo` and `renderDiff` rely on.
  contentTruncated?: boolean;
  // Issue #335: the intercepting tool's name and the interactive turn, from
  // the group's latest entry. Absent on pre-schema entries, reconciliation
  // finds (no tool ran) and tool entries journaled before turns were
  // threaded — `--stat` and `--json` render them when present.
  toolName?: string;
  turn?: number;
}

export interface DiffFilter {
  path?: string;
  agent?: string;
}

export function diffEntries(
  store: FileJournalStore,
  filter: DiffFilter,
): FileChange[] {
  const byPath = new Map<string, JournalEntry[]>();
  for (const e of store.entries()) {
    // Issue #378: markers are journal bookkeeping, not file changes —
    // never a diff hunk (status/log surface them instead).
    if (e.op === 'marker') continue;
    if (filter.path !== undefined && e.path !== filter.path) continue;
    if (filter.agent !== undefined && e.agentId !== filter.agent) continue;
    const list = byPath.get(e.path) ?? [];
    list.push(e);
    byPath.set(e.path, list);
  }
  const out: FileChange[] = [];
  for (const [path, list] of byPath) {
    const first = list[0];
    const last = list[list.length - 1];
    if (first === undefined || last === undefined) continue;
    const change = buildChange(
      path,
      first,
      last,
      (e) => store.readBefore(e),
      (e) => store.readAfter(e),
    );
    if (change !== null) out.push(change);
  }
  return out;
}

function buildChange(
  path: string,
  first: JournalEntry,
  last: JournalEntry,
  readBeforeOfFirst: (e: JournalEntry) => string | null,
  readAfterOfLast: (e: JournalEntry) => string | null,
): FileChange | null {
  const before = readBeforeOfFirst(first);
  const after = readAfterOfLast(last);
  // "Unexpectedly null while hashes exist" (issue #111): unattributed
  // entries legitimately carry a hash-only pre-image (no before-blob by
  // design), so that absence is not corruption; everything else missing
  // under a recorded hash is.
  const beforeLost =
    first.beforeHash !== null &&
    before === null &&
    first.unattributed !== true &&
    first.beforeOmitted !== true;
  // A hash-only sweep after-side (issue #120) is a designed absence: the
  // entry records the walk hash but deliberately no content.
  const afterLost =
    last.afterHash !== null && after === null && last.afterOmitted !== true;
  // Unreachable (markers never reach the map), but the guard is what
  // narrows `op` to `FileOp` — the grouping above erases the filter's
  // narrowing, and a cast would hide a future leak.
  if (last.op === 'marker') return null;
  return {
    path,
    op: last.op,
    agentId: last.agentId,
    toolCallId: last.toolCallId,
    sessionId: last.sessionId,
    timestamp: last.timestamp,
    ...(last.toolName === undefined ? {} : { toolName: last.toolName }),
    ...(last.turn === undefined ? {} : { turn: last.turn }),
    unattributed: last.unattributed === true,
    reversible: before !== null || isUndoableCreate(first),
    before,
    after,
    corrupt: beforeLost || afterLost,
    afterOmitted: last.afterOmitted === true,
    ...(last.afterBytes === undefined ? {} : { afterBytes: last.afterBytes }),
  };
}

// Minimal unified hunks: changed region plus context lines, with real
// @@ -a,b +c,d @@ headers. Display only — never parsed back.
// The header counts accumulate while emitting (issue #126): they describe
// exactly the lines the hunk prints for each side, so a consumer (the TUI
// view, a future patch applier) can trust them.
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

// `kubic diff --json` content bound (issue #126): one change's before/after
// can be a whole file, so the JSON surface clips each side at this many
// bytes by default — the envelope stays readable, and the clipped text
// names the bound. `--max-content-bytes 0` opts out (unlimited).
export const DEFAULT_MAX_CONTENT_BYTES = 64 * 1024;

// Clip one side of a change to `maxBytes` UTF-8 bytes (0 = unlimited). The
// clipped text ends with a named marker line so a consumer never mistakes
// the bound for the whole file.
export function clipContent(
  text: string | null,
  maxBytes: number,
): { text: string | null; truncated: boolean } {
  if (
    text === null ||
    maxBytes === 0 ||
    Buffer.byteLength(text, 'utf8') <= maxBytes
  ) {
    return { text, truncated: false };
  }
  const clipped = Buffer.from(text, 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8');
  return {
    text: `${clipped}\n[kubic: content truncated at ${maxBytes} bytes]`,
    truncated: true,
  };
}

// The `--json` projection of one change: clip both sides and record whether
// either was clipped (`contentTruncated`). The human renderDiff path never
// goes through here — it renders hunks, not whole files.
export function clipChangeContent(
  change: FileChange,
  maxBytes: number,
): FileChange {
  const before = clipContent(change.before, maxBytes);
  const after = clipContent(change.after, maxBytes);
  return {
    ...change,
    before: before.text,
    after: after.text,
    contentTruncated: before.truncated || after.truncated,
  };
}

export function renderDiff(changes: FileChange[]): string {
  const out: string[] = [];
  for (const c of changes) {
    const who = `agent=${c.agentId} toolCall=${c.toolCallId ?? 'none'}`;
    const flags = [
      c.unattributed ? 'unattributed' : null,
      c.reversible ? null : 'non-reversible',
    ].filter((f) => f !== null);
    out.push(`--- a/${c.path}`);
    out.push(`+++ b/${c.path}`);
    out.push(`# ${who}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`);
    // Corruption is named, never silent (issue #111): the marker tells the
    // operator the hunk below may be incomplete rather than faithful.
    if (c.corrupt) out.push('# [corrupt journal content]');
    // A designed absence is named too (issue #120): the sweep recorded the
    // walk hash and the size but declined to capture content (above the
    // bound, or a lossy decode). Say so instead of rendering the change as
    // if the file became empty.
    if (c.afterOmitted && c.after === null) {
      out.push(
        c.afterBytes === undefined
          ? '# [content not captured]'
          : `# [content not captured — ${c.afterBytes} bytes changed]`,
      );
    }
    out.push(...unifiedHunks(c.before ?? '', c.after ?? ''));
  }
  return out.join('\n');
}

// Issue #335 (§84 flow): the per-file summary — path, added/removed line
// counts, the intercepting tool and the turn. The counts come from the
// same `unifiedHunks` the full render prints, so `--stat` can never
// disagree with the hunks; a missing side counts as empty (a create reads
// as all-added, a delete as all-removed). Tool and turn render only when
// the entry carries them — pre-schema entries and reconciliation finds
// show the op (or `reconciled`) instead of a blank.
export function renderDiffStat(changes: FileChange[]): string[] {
  return changes.map((c) => {
    let added = 0;
    let removed = 0;
    for (const line of unifiedHunks(c.before ?? '', c.after ?? '')) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    const what = c.toolName ?? (c.unattributed ? 'reconciled' : c.op);
    const turn = c.turn === undefined ? '' : `, turn ${c.turn}`;
    return `${c.path} +${added} -${removed} ${what}${turn}`;
  });
}
