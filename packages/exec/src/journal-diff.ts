// Journal diff core (issue #18, slice A; §42.2).
// Pure over journal entries: one FileChange per path (earliest before,
// latest after, latest attribution), plus unified-hunk rendering shared
// by the CLI and the future TUI views ("TUI consumes same data").

import type { FileJournalStore, JournalEntry, JournalOp } from './journal.js';

export interface FileChange {
  path: string;
  op: JournalOp;
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
    const before = store.readBefore(first);
    const after = store.readAfter(last);
    // "Unexpectedly null while hashes exist" (issue #111): unattributed
    // entries legitimately carry a hash-only pre-image (no before-blob by
    // design), so that absence is not corruption; everything else missing
    // under a recorded hash is.
    const beforeLost =
      first.beforeHash !== null &&
      before === null &&
      first.unattributed !== true;
    // A hash-only sweep after-side (issue #120) is a designed absence: the
    // entry records the walk hash but deliberately no content.
    const afterLost =
      last.afterHash !== null && after === null && last.afterOmitted !== true;
    out.push({
      path,
      op: last.op,
      agentId: last.agentId,
      toolCallId: last.toolCallId,
      sessionId: last.sessionId,
      timestamp: last.timestamp,
      unattributed: last.unattributed === true,
      reversible: before !== null,
      before,
      after,
      corrupt: beforeLost || afterLost,
      afterOmitted: last.afterOmitted === true,
      ...(last.afterBytes === undefined ? {} : { afterBytes: last.afterBytes }),
    });
  }
  return out;
}

// Minimal unified hunks: changed region plus context lines, with real
// @@ -a,b +c,d @@ headers. Display only — never parsed back.
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
  const lines = [`@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`];
  for (let i = from; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i < endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i < endB; i++) lines.push(`+${b[i]}`);
  for (let i = 0; i < toA - endA && i < toB - endB; i++) {
    lines.push(` ${a[endA + i]}`);
  }
  return lines;
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
