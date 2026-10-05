// Journal log + status core (issue #18, slice C; §42.2).
// Log is the journal as a timeline; status summarizes reversibility plus
// repository state (or an explicit non-repo note — the journal works
// identically outside git by design, §43.2).

import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import {
  type BridgeFileInfo,
  createNodeFileBridge,
  type FileBridge,
} from './file-bridge.js';
import { type FileJournalStore, isUndoableCreate } from './journal.js';

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
  // because nothing intercepted their change. Usually non-reversible — the
  // baseline holds hashes, never before-content — but NOT a subset of
  // `nonReversible`: when an earlier attributed entry in the same run stored
  // the pre-image for that path, `readBefore` resolves and undo can restore
  // it (pinned by journal-reconcile-run.test.ts). Surfaced on its own
  // because it is the only evidence of work that bypassed every Kubic
  // operation.
  unattributed: number;
  // Issue #111: entries whose content is unexpectedly missing under a
  // recorded hash (corrupt/torn blob, or a delta that refuses to
  // reconstruct) — designed absences (unattributed hash-only pre-images,
  // deletes) are not counted.
  corrupt: number;
  // Issue #343: index lines dropped because they do not parse — a torn
  // tail left by a crash or a full disk. Not the same thing as `corrupt`
  // (that counts missing content); a dropped line has no entry at all, so
  // nothing else in this object would show it.
  corruptLines: number;
  repo: RepoState | null;
}

// Issue #126: resolve the repository's HEAD with pure file reads. In a
// linked worktree — exactly the trees `kubic orchestrate` creates and
// retains — `.git` is a pointer FILE (`gitdir: <path>`) whose target holds
// the real HEAD; reading `.git/HEAD` there would call a live branch
// `(detached)`. The pointer is followed (absolute, or relative to the
// worktree root), and an unreadable or malformed pointer is named
// `(unknown)` — never a throw, never a guessed branch. `null` still means
// "no repository here at all" (the journal works anywhere by design).
type HeadRead = { kind: 'head'; text: string } | { kind: 'unknown' } | null;

function readHead(root: string, bridge: FileBridge): HeadRead {
  const dotGit = join(root, '.git');
  let info: BridgeFileInfo;
  try {
    info = bridge.fileInfo(dotGit);
  } catch {
    return null;
  }
  if (!info.isFile) {
    // The classic layout: .git is a directory (or a symlink to one).
    try {
      return {
        kind: 'head',
        text: bridge.readTextFile(join(dotGit, 'HEAD')).trim(),
      };
    } catch {
      return null;
    }
  }
  let raw: string;
  try {
    raw = bridge.readTextFile(dotGit);
  } catch {
    return { kind: 'unknown' };
  }
  const target = /^gitdir:\s*(.+)$/.exec(raw.trim())?.[1]?.trim();
  if (target === undefined || target === '') return { kind: 'unknown' };
  const headPath = isAbsolute(target) ? target : join(root, target);
  try {
    return {
      kind: 'head',
      text: bridge.readTextFile(join(headPath, 'HEAD')).trim(),
    };
  } catch {
    // Dangling pointer (the worktree's git dir is gone): named, no throw.
    return { kind: 'unknown' };
  }
}

function readRepo(root: string): RepoState | null {
  const bridge = createNodeFileBridge('/');
  const head = readHead(root, bridge);
  if (head === null) return null;
  const branch =
    head.kind === 'unknown'
      ? '(unknown)'
      : head.text.startsWith('ref: ')
        ? head.text.slice(5).replace(/^refs\/heads\//, '') || '(unknown)'
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
  const { entries, corruptLines } = store.readIndex();
  let reversible = 0;
  let unattributed = 0;
  let corrupt = 0;
  for (const e of entries) {
    const before = store.readBefore(e);
    // An agent create reverts by removal: its pre-state is "absent".
    if (before !== null || isUndoableCreate(e)) reversible++;
    if (e.unattributed === true) unattributed++;
    // Same corruption predicate as diffEntries (issue #111): content
    // unexpectedly null while its hash is recorded. An unattributed entry's
    // hash-only pre-image is a designed absence, never corruption — nor is
    // the sweep's hash-only after-side (issue #120).
    const beforeLost =
      e.beforeHash !== null &&
      before === null &&
      e.unattributed !== true &&
      e.beforeOmitted !== true;
    const afterLost =
      e.afterHash !== null &&
      store.readAfter(e) === null &&
      e.afterOmitted !== true;
    if (beforeLost || afterLost) corrupt++;
  }
  return {
    entries: entries.length,
    reversible,
    nonReversible: entries.length - reversible,
    unattributed,
    corrupt,
    corruptLines,
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
