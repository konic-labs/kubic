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
    out.push(...unifiedHunks(c.before ?? '', c.after ?? ''));
  }
  return out.join('\n');
}
