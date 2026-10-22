import { join } from 'node:path';
import type { FileBridge } from '../file-bridge.js';
import { createNodeFileBridge } from '../file-bridge.js';
import type { IgnoreRule } from '../ignore.js';
import { isIgnored, parseIgnoreFile } from '../ignore.js';
import type { BaselineCache } from './baseline-cache.js';
import type { GitBaseline, GitCommand, HeadState } from './git.js';
import { HASH_NOTICE_BYTES, sha256HexOfFile } from './hash.js';
import type { FileJournalStore } from './store.js';
import type { JournalEntry } from './types.js';

// --- Baseline + reconciliation ----------------

export type Baseline = Record<string, string>;

/**
 * The sentinel a walk stores for a path it could SEE but not READ
 * (EACCES/EPERM/EIO — a `chmod 000` secret, a permission-denied mount). It is
 * not a hash, and a real hash is 64 hex characters, so it can never collide.
 * Reconcile skips such a path entirely: it was never observed to change (no
 * read happened) and it was never observed to vanish (lstat succeeded), so
 * neither a delete nor a change is recorded for it. Persisted with the
 * baseline, so a resumed run keeps the distinction.
 */
export const UNREADABLE_HASH = 'unreadable';

export interface BaselineOptions {
  outOfScope?: string[];
  /**
   * Read seam. Production always uses the node bridge; tests
   * inject one to observe read sizes. The hashing bound depends on the
   * bridge implementing `readFileRange`, so the seam is explicit rather than
   * a module-level monkeypatch.
   */
  bridge?: FileBridge;
  /**
   * Report a walk condition the operator should know about. Used for the one
   * case that is reported: a bridge without `readFileRange` reverts to
   * whole-file reads, so a file larger than `HASH_CHUNK_BYTES` costs its size
   * at boot. Production bridges always implement it; the hook exists so the
   * fallback can never be invisible.
   */
  onNotice?: (detail: string) => void;
  /**
   * The previous baseline to carry a subtree forward from when
   * its listing fails mid-walk (a permission change, a directory that
   * vanished). The sweep passes its boot baseline, so an unlistable subtree
   * compares equal to its own previous state instead of reading as deleted;
   * a boot capture has none, and an unlistable directory contributes nothing.
   */
  previous?: Baseline;
  /**
   * Boot-time index blob OIDs for stat-clean tracked files
   * (see `git.ts` `captureGitBaseline`). Absent or null outside git
   * repositories (fail-open): the sweep then records hash-only entries. Carried on the walk options so the run lifecycle can
   * pass it through; `captureBaseline` itself ignores it.
   */
  gitBaseline?: GitBaseline | null;
  /**
   * Seam for the object-store reads (tests script it;
   * production spawns `git cat-file`). reuses it for the
   * sweep's HEAD-state comparison.
   */
  gitRun?: GitCommand;
  /**
   * HEAD state at boot (`captureHeadState`). When present, the
   * sweep compares it against the current state and appends one `marker`
   * entry per observed move. Absent or null outside git repositories
   * (fail-open) — no marker, no error.
   */
  headBaseline?: HeadState | null;
  /**
   * Digests of files a previous walk hashed, reused while a file is provably
   * unchanged (baseline-cache.ts). Absent: every file is read.
   */
  cache?: BaselineCache;
}

// Out-of-scope paths: an entry excludes the path itself and
// everything under it. Operators declare directories (`dist`), so the match is
// path-boundary aware — `dist` excludes `dist` and `dist/a.js`, never `dist-x`
// — and it is one shared rule for both walks and the sweep's
// after-content loop, so a path can never be in scope in one and out in the
// other.
export function isOutOfScope(
  relPath: string,
  entries: readonly string[],
): boolean {
  return entries.some(
    (entry) => relPath === entry || relPath.startsWith(`${entry}/`),
  );
}

// Metadata walk, not a content copy: hashes only, no blobs. Always skips
// .git/ and .kubic/ (journal state is never journaled), honors every
// `.gitignore` on the way down — the root's rules plus each nested file's,
// child rules appended after the parent's (last-match-wins, so a nested
// negation overrides a parent ignore — the ordering git uses) — and excludes
// caller-declared out-of-scope paths (an entry excludes the path itself
// and everything under it).
export function captureBaseline(
  root: string,
  options: BaselineOptions = {},
): Baseline {
  const bridge = options.bridge ?? createNodeFileBridge('/');
  const outOfScope = options.outOfScope ?? [];
  const baseline: Baseline = {};
  const walk = (dir: string, rel: string, rules: IgnoreRule[]): void => {
    let infos: ReturnType<typeof bridge.listDir> = [];
    try {
      infos = bridge.listDir(dir);
    } catch (error) {
      // The subtree's CURRENT state is unknown, so its previous
      // hashes stand in for it — reconcile then sees "unchanged" instead of
      // "every file under it was deleted". Without a previous baseline
      // there is nothing to carry, and an unreadable directory simply
      // contributes no entries (never invented ones).
      //
      // Only "could not look" (EACCES/EPERM/EIO) carries
      // forward. ENOENT means the directory really went away between the
      // parent's listing and this recursion, and the walk's own race window
      // must record that subtree's files as deletes like any other
      // disappearance — carrying them forward would silently lose them, and
      // the next run's baseline would not contain them either.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return;
      const prefix = rel === '' ? '' : `${rel}/`;
      for (const [path, hash] of Object.entries(options.previous ?? {})) {
        if (prefix === '' || path.startsWith(prefix)) baseline[path] = hash;
      }
      return;
    }
    // One `exists` per directory entered: the same
    // order as the `listDir` already paid, and no read at all for a directory
    // without an ignore file.
    let localRules = rules;
    const nested = join(dir, '.gitignore');
    if (bridge.exists(nested)) {
      try {
        // Child rules are appended AFTER the parent's: `isIgnored` is
        // last-match-wins, so a nested negation overrides the parent ignore —
        // the ordering git uses. The array is path-depth-bounded (one copy per
        // directory that has an ignore file) and dropped on recursion exit, so
        // siblings never see each other's rules.
        localRules = [
          ...rules,
          ...parseIgnoreFile(bridge.readTextFile(nested)),
        ];
      } catch {
        // Unreadable nested ignore (chmod 000, a permission-denied mount):
        // keep the parent rules and keep walking — the documented widening,
        // never a throw.
      }
    }
    for (const info of [...infos].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (info.isSymbolicLink) continue;
      const relPath = rel === '' ? info.name : `${rel}/${info.name}`;
      if (relPath === '.git' || relPath.startsWith('.git/')) continue;
      if (relPath === '.kubic' || relPath.startsWith('.kubic/')) continue;
      if (isOutOfScope(relPath, outOfScope)) continue;
      if (isIgnored(localRules, relPath, info.isDirectory)) continue;
      if (info.isDirectory) {
        walk(join(dir, info.name), relPath, localRules);
      } else if (info.isFile === false) {
        // Not a regular file: a FIFO/socket/device must never be read. A
        // synchronous read of a named pipe blocks until a writer opens it,
        // which would wedge baseline capture at boot with no way to time out.
        // `undefined` means the bridge did not classify it: assume regular.
        // Skipped deliberately (biome's noUselessContinue fix deletes a bare
        // trailing `continue` together with this rationale — do not re-add it).
      } else {
        const reused = options.cache?.reuse(relPath, info);
        if (reused !== undefined) {
          baseline[relPath] = reused;
          options.cache?.record(relPath, info, reused);
          continue;
        }
        try {
          const abs = join(dir, info.name);
          if (info.size > HASH_NOTICE_BYTES) {
            // Hashed anyway (a skipped file would hide real changes) but named,
            // so an operator can see why boot took as long as it did.
            options.onNotice?.(
              `hashing a very large file: ${relPath} (${info.size} bytes) — boot reads its full apparent size`,
            );
          }
          const digest = sha256HexOfFile(
            bridge,
            abs,
            info.size,
            options.onNotice,
          );
          baseline[relPath] = digest;
          options.cache?.record(relPath, info, digest);
        } catch (error) {
          // A real disappearance (ENOENT) leaves the path out of
          // the walk, and reconcile records the delete it is. Anything else —
          // EACCES/EPERM/EIO, a `chmod 000` file or a permission-denied mount
          // — means the path is still there and its content was never
          // observed: it is kept with the unreadable sentinel, so reconcile
          // records neither a delete nor a change for it.
          if ((error as { code?: string } | null)?.code !== 'ENOENT') {
            baseline[relPath] = UNREADABLE_HASH;
          }
        }
      }
    }
  };
  walk(root, '', []);
  return baseline;
}

export function saveBaseline(
  dir: string,
  runId: string,
  baseline: Baseline,
): void {
  createNodeFileBridge('/').writeFile(
    join(dir, `baseline-${runId}.json`),
    JSON.stringify(baseline),
    { mode: 0o600 },
  );
}

/**
 * The journal position at the moment a run's baseline was captured: the
 * entry count and the last entry then. The last entry is the marker — a
 * retention pass that drops head entries mid-run shifts indexes, so the
 * marker is re-found by content rather than trusted by position.
 */
export interface JournalRunStart {
  count: number;
  last: JournalEntry | null;
}

export function journalRunStart(store: FileJournalStore): JournalRunStart {
  const all = store.entries();
  return { count: all.length, last: all.at(-1) ?? null };
}

// The entries appended since `start`. The fast path trusts the
// recorded index when the marker is still there; otherwise the marker's
// last occurrence is searched, and a marker retention already dropped
// means everything left is newer than it.
export function entriesSinceRunStart(
  all: JournalEntry[],
  start: JournalRunStart | undefined,
): JournalEntry[] {
  if (start === undefined || start.last === null) return all;
  const marker = JSON.stringify(start.last);
  const at = start.count - 1;
  if (at < all.length && JSON.stringify(all[at]) === marker) {
    return all.slice(start.count);
  }
  for (let i = Math.min(at, all.length - 1); i >= 0; i--) {
    if (JSON.stringify(all[i]) === marker) return all.slice(i + 1);
  }
  return all;
}
