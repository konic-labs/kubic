// Journal log + status core.
// Log is the journal as a timeline; status summarizes reversibility plus
// repository state (or an explicit non-repo note — the journal works
// identically outside git by design).

import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import {
  type BridgeFileInfo,
  createNodeFileBridge,
  type FileBridge,
} from '../file-bridge.js';
import type { HeadState } from './git.js';
import { isUndoableCreate } from './restore.js';
import type { FileJournalStore } from './store.js';

/** One side of a head-moved marker, human-readable. */
function formatHeadState(state: HeadState): string {
  const stash =
    state.stash !== undefined && state.stash > 0
      ? ` (stash ${state.stash})`
      : '';
  return `${state.branch}@${state.head.slice(0, 12)}${stash}`;
}

/** `from -> to` for a marker, a status warning, an undo refusal. */
export function formatHeadMove(from: HeadState, to: HeadState): string {
  return `${formatHeadState(from)} -> ${formatHeadState(to)}`;
}

interface RepoState {
  branch: string;
  // null when git is unavailable or the query fails: reported as unknown,
  // never guessed.
  dirty: boolean | null;
  // The repo root (`rev-parse --show-toplevel`), null when it
  // cannot be read.
  repoRoot: string | null;
  // Ahead/behind against the upstream: null when there is no upstream or
  // it cannot be read.
  ahead: number | null;
  behind: number | null;
  // Paths with unresolved merge conflicts (never null: no conflicts is
  // the empty list).
  conflicts: string[];
}

export interface JournalStatus {
  entries: number;
  reversible: number;
  nonReversible: number;
  // Reconciliation finds: entries an end-of-run sweep appended
  // because nothing intercepted their change. Usually non-reversible — the
  // baseline holds hashes, never before-content — but NOT a subset of
  // `nonReversible`: when an earlier attributed entry in the same run stored
  // the pre-image for that path, `readBefore` resolves and undo can restore
  // it (pinned by journal-reconcile-run.test.ts). Surfaced on its own
  // because it is the only evidence of work that bypassed every Kubic
  // operation.
  unattributed: number;
  // Entries whose content is unexpectedly missing under a
  // recorded hash (corrupt/torn blob, or a delta that refuses to
  // reconstruct) — designed absences (unattributed hash-only pre-images,
  // deletes) are not counted.
  corrupt: number;
  // Index lines dropped because they do not parse — a torn
  // tail left by a crash or a full disk. Not the same thing as `corrupt`
  // (that counts missing content); a dropped line has no entry at all, so
  // nothing else in this object would show it.
  corruptLines: number;
  // Index lines a newer Kubic wrote, in a record version this build cannot
  // read: never counted as entries, left in place.
  unknownVersionLines: number;
  // Every HEAD move the sweeps observed, oldest first. `undo`
  // refuses to restore entries from before a move without `--force`.
  headMoves: { from: HeadState; to: HeadState }[];
  repo: RepoState | null;
}

// Resolve the repository's HEAD with pure file reads. In a
// linked worktree `.git` is a pointer FILE (`gitdir: <path>`) whose target holds
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
  // Each query degrades independently: a repo without an upstream still
  // reports its root, and a failed rev-list never takes conflicts with it.
  let repoRoot: string | null = null;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    repoRoot = top === '' ? null : top;
  } catch {
    repoRoot = null;
  }
  let ahead: number | null = null;
  let behind: number | null = null;
  try {
    const counts = execFileSync(
      'git',
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      { cwd: root, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim()
      .split(/\s+/);
    if (counts.length === 2) {
      ahead = Number(counts[0]);
      behind = Number(counts[1]);
      if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
        ahead = null;
        behind = null;
      }
    }
  } catch {
    ahead = null;
    behind = null;
  }
  let conflicts: string[] = [];
  try {
    conflicts = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=U'],
      {
        cwd: root,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    conflicts = [];
  }
  return { branch, dirty, repoRoot, ahead, behind, conflicts };
}

// `store` is undefined when no journal is recorded: every count is 0, and
// only the repository is read.
export function journalStatus(
  store: FileJournalStore | undefined,
  root: string,
): JournalStatus {
  if (store === undefined) {
    return {
      entries: 0,
      reversible: 0,
      nonReversible: 0,
      unattributed: 0,
      corrupt: 0,
      corruptLines: 0,
      unknownVersionLines: 0,
      headMoves: [],
      repo: readRepo(root),
    };
  }
  const { entries, corruptLines, unknownVersionLines } = store.readIndex();
  let reversible = 0;
  let unattributed = 0;
  let corrupt = 0;
  const headMoves: { from: HeadState; to: HeadState }[] = [];
  for (const e of entries) {
    // The marker counts as journaled work (unattributed and,
    // with nothing to restore, non-reversible) and its move is collected
    // for the warning — never a corruption count.
    if (
      e.op === 'marker' &&
      e.headFrom !== undefined &&
      e.headTo !== undefined
    ) {
      unattributed++;
      headMoves.push({ from: e.headFrom, to: e.headTo });
      continue;
    }
    const before = store.readBefore(e);
    // An agent create reverts by removal: its pre-state is "absent".
    if (before !== null || isUndoableCreate(e)) reversible++;
    if (e.unattributed === true) unattributed++;
    // Same corruption predicate as diffEntries: content
    // unexpectedly null while its hash is recorded. An unattributed entry's
    // hash-only pre-image is a designed absence, never corruption — nor is
    // the sweep's hash-only after-side.
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
    unknownVersionLines,
    headMoves,
    repo: readRepo(root),
  };
}

// One-line reconciliation summary for `kubic log`: the count of
// sweep finds over the whole journal, printed after the timeline so an
// operator sees non-tool effects without scanning every line for the
// `reconciled` marker. `log` prints it even when the journal is empty —
// "0 of 0" is the honest answer, and it keeps the surface's shape stable
// for scripts.
export function reconciliationSummary(
  entries: readonly { unattributed?: boolean }[],
): string {
  const unattributed = entries.filter((e) => e.unattributed === true).length;
  return `unattributed: ${unattributed} of ${entries.length} entr(ies) reconciled at run end`;
}
