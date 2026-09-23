// Journal log + status core (issue #18, slice C; §42.2).
// Log is the journal as a timeline; status summarizes reversibility plus
// repository state (or an explicit non-repo note — the journal works
// identically outside git by design, §43.2).

import { execFileSync } from 'node:child_process';
import { createNodeFileBridge } from './file-bridge.js';
import { FileJournalStore } from './journal.js';
import { join } from 'node:path';

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
    ? (head.slice(5).split('/').pop() ?? '(unknown)')
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
  for (const e of entries) {
    if (store.readBefore(e) !== null) reversible++;
  }
  return {
    entries: entries.length,
    reversible,
    nonReversible: entries.length - reversible,
    repo: readRepo(root),
  };
}
