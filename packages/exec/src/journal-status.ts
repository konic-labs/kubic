// Journal log + status core (issue #18, slice C; §42.2).
// Log is the journal as a timeline; status summarizes reversibility plus
// repository state (or an explicit non-repo note — the journal works
// identically outside git by design, §43.2).

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createNodeFileBridge } from './file-bridge.js';
import type { FileJournalStore } from './journal.js';

export function renderLog(store: FileJournalStore): string[] {
  return store.entries().map((e) => {
    const parts = [
      new Date(e.timestamp).toISOString(),
      e.agentId,
      e.toolCallId ?? 'none',
      e.op,
      e.path,
      `${e.bytesDelta >= 0 ? '+' : ''}${e.bytesDelta}B`,
    ];
    if (e.unattributed === true) parts.push('reconciled');
    return parts.join(' ');
  });
}

export interface RepoState {
  branch: string;
  // null when git is unavailable or the query fails: reported as unknown,
  // never guessed.
  dirty: boolean | null;
}

export interface JournalStatus {
  entries: number;
  reversible: number;
  nonReversible: number;
  // Reconciliation finds (issue #87): entries an end-of-run sweep appended
  // because nothing intercepted their change. Always non-reversible — the
  // baseline holds hashes, never before-content — so this is a subset of
  // `nonReversible`, surfaced on its own because it is the only evidence
  // of work that bypassed every Kubic operation.
  unattributed: number;
  repo: RepoState | null;
}

function readRepo(root: string): RepoState | null {
  const bridge = createNodeFileBridge('/');
  let head: string;
  try {
    head = bridge.readTextFile(join(root, '.git', 'HEAD')).trim();
  } catch {
    return null;
  }
  const branch = head.startsWith('ref: ')
    ? head.slice(5).replace(/^refs\/heads\//, '') || '(unknown)'
    : '(detached)';
  let dirty: boolean | null = null;
  try {
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    dirty = porcelain.trim().length > 0;
  } catch {
    dirty = null;
  }
  return { branch, dirty };
}

export function journalStatus(
  store: FileJournalStore,
  root: string,
): JournalStatus {
  const entries = store.entries();
  let reversible = 0;
  let unattributed = 0;
  for (const e of entries) {
    if (store.readBefore(e) !== null) reversible++;
    if (e.unattributed === true) unattributed++;
  }
  return {
    entries: entries.length,
    reversible,
    nonReversible: entries.length - reversible,
    unattributed,
    repo: readRepo(root),
  };
}

// One-line reconciliation summary for `kubic log` (issue #87): the count of
// sweep finds over the whole journal, printed after the timeline so an
// operator sees non-tool effects without scanning every line for the
// `reconciled` marker. `log` prints it even when the journal is empty —
// "0 of 0" is the honest answer, and it keeps the surface's shape stable
// for scripts.
export function reconciliationSummary(store: FileJournalStore): string {
  const entries = store.entries();
  const unattributed = entries.filter((e) => e.unattributed === true).length;
  return `unattributed: ${unattributed} of ${entries.length} entr(ies) reconciled at run end`;
}
