import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { createNodeFileBridge } from '../file-bridge.js';
import { sha256HexOfFile } from './hash.js';
import type { FileJournalStore } from './store.js';
import type { JournalEntry } from './types.js';

export type RestoreResult =
  | { restored: true }
  | { restored: false; reason: string };

// True when any existing component of target's parent chain (up to but
// excluding root) is a symlink. Missing components cannot be symlinks.
function hasSymlinkParent(target: string, root: string): boolean {
  const bridge = createNodeFileBridge('/');
  let dir = dirname(target);
  const stop = resolve(root);
  while (dir.startsWith(stop + sep) || dir === stop) {
    if (dir === stop) return false;
    try {
      if (bridge.fileInfo(dir).isSymbolicLink) return true;
    } catch {
      return false;
    }
    dir = dirname(dir);
  }
  return false;
}

// Undo primitive for the `kubic undo` command: writes the recorded
// before-content back. Entries without before-content (unattributed
// reconciliation finds) are reported non-reversible — never guessed.
// Entry paths are contained to the workspace root: a path escaping via
// ../ (or an absolute path) is refused, never written.
//
// Before any write, the file's CURRENT state must match the
// entry's recorded after-state — restoring over a file that changed after
// the entry was journaled (manual edit, another run, another tool) would
// silently destroy those changes. `allowStale` is the operator's explicit
// --force override, per-invocation only, never persisted.
export interface RestoreOptions {
  /** Skip the staleness check (explicit operator override). */
  allowStale?: boolean;
}

// Staleness probe shared by the undo planner/dry-run and restoreEntry, so every
// path compares the same state. Pure read.
//
//   { missing: true,  hash: null }     file absent
//   { missing: false, hash: <sha256> } readable current content
//   { missing: false, hash: null }     exists but unreadable — cannot
//                                       verify, so callers refuse
export interface FileCurrentState {
  missing: boolean;
  hash: string | null;
}

export function probeFileState(root: string, path: string): FileCurrentState {
  const bridge = createNodeFileBridge('/');
  const target = resolve(root, path);
  try {
    const info = bridge.fileInfo(target);
    try {
      return {
        missing: false,
        hash: sha256HexOfFile(bridge, target, info.size),
      };
    } catch {
      return { missing: false, hash: null };
    }
  } catch {
    return { missing: true, hash: null };
  }
}

// Best-effort sweep of stale restore residue: a crash
// mid-restore can leave a `<target>.kubic-restore-<pid>.tmp` sibling behind
// when the best-effort cleanup itself never ran. A successful restore of
// that target removes any such siblings — they are this tool's own
// predictable residue, never user files. Errors are ignored (a leftover is
// litter, not corruption) and only the exact `<target>.kubic-restore-*.tmp`
// name shape matches, so nothing else in the directory is ever touched.
function sweepStaleRestoreTmps(
  bridge: ReturnType<typeof createNodeFileBridge>,
  target: string,
): void {
  const dir = dirname(target);
  const prefix = `${basename(target)}.kubic-restore-`;
  try {
    for (const info of bridge.listDir(dir)) {
      if (info.isDirectory || info.isSymbolicLink) continue;
      if (!info.name.startsWith(prefix) || !info.name.endsWith('.tmp'))
        continue;
      try {
        bridge.remove(join(dir, info.name), false, true);
      } catch {
        // Best-effort: residue that cannot be removed is litter.
      }
    }
  } catch {
    // Unreadable directory: nothing to sweep.
  }
}

// Containment guard shared by every undo primitive: the resolved target
// must sit strictly inside the root, and no existing parent component may
// be a symlink. Returns the absolute target, or the refusal.
function guardTarget(
  entry: JournalEntry,
  root: string,
): string | { restored: false; reason: string } {
  const target = resolve(root, entry.path);
  const rel = relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return {
      restored: false,
      reason: `entry path escapes the workspace root: ${entry.path}`,
    };
  }
  // Lexical containment is not enough: a symlinked directory inside the
  // root would redirect the write outside. Refuse symlink parents.
  // (Check-then-write races against a local attacker swapping links
  // mid-restore are out of scope: the journal is a local recovery tool.)
  if (hasSymlinkParent(target, root)) {
    return {
      restored: false,
      reason: `entry path crosses a symlink: ${entry.path}`,
    };
  }
  return target;
}

// An agent-authored create: the pre-state is "absent", which the journal
// knows exactly even though no before-blob exists — so undo reverts it by
// removing the file ("kubic undo reverts the run"). Unattributed
// reconciliation creates stay non-reversible: the sweep saw the file
// appear but cannot vouch that nothing else depends on it.
export function isUndoableCreate(entry: JournalEntry): boolean {
  return (
    entry.op === 'create' &&
    entry.beforeHash === null &&
    entry.afterHash !== null &&
    entry.unattributed !== true
  );
}

// Undo primitive for an agent-authored create: removes the file. Carries
// the same containment guards as restoreEntry; the staleness verdict is
// the caller's (the undo walk), exactly as restoreEntry's allowStale path.
export function removeCreatedEntry(
  entry: JournalEntry,
  root: string,
): RestoreResult {
  if (!isUndoableCreate(entry)) {
    return {
      restored: false,
      reason: `not an agent-created file entry: ${entry.path}`,
    };
  }
  const guarded = guardTarget(entry, root);
  if (typeof guarded !== 'string') return guarded;
  const bridge = createNodeFileBridge('/');
  try {
    bridge.remove(guarded, false, true);
  } catch (error) {
    return {
      restored: false,
      reason: `remove failed: ${(error as Error).message}`,
    };
  }
  sweepStaleRestoreTmps(bridge, guarded);
  return { restored: true };
}

export function restoreEntry(
  store: FileJournalStore,
  entry: JournalEntry,
  root: string,
  options?: RestoreOptions,
): RestoreResult {
  const before = store.readBefore(entry);
  if (before === null) {
    return {
      restored: false,
      reason:
        'no before-content: no retrievable pre-image for this entry — nothing to restore',
    };
  }
  const guarded = guardTarget(entry, root);
  if (typeof guarded !== 'string') return guarded;
  const target = guarded;
  if (options?.allowStale !== true) {
    // Direct-caller safety net: the walk-aware undo planner
    // performs the same check with full plan context and then calls
    // restoreEntry with allowStale; a bare caller still gets the matrix.
    //
    //   current file   entry.afterHash   action
    //   exists, ==afterHash   set        safe: restore
    //   exists, !=afterHash   set        STALE: refuse (clobber)
    //   missing               set        restore (recreates; no data lost)
    //   exists                null       STALE: refuse (recreated after delete)
    //   missing               null       restore (pre-delete content back)
    const state = probeFileState(root, entry.path);
    if (!state.missing && state.hash !== entry.afterHash) {
      return {
        restored: false,
        reason:
          state.hash === null
            ? `stale: '${entry.path}' exists but its current content could not be read to verify state — use --force`
            : `stale: '${entry.path}' changed after this entry was journaled (current sha256 ${state.hash.slice(0, 12)}… ≠ recorded after ${entry.afterHash?.slice(0, 12) ?? 'none'}…) — restoring would discard those changes; use --force`,
      };
    }
  }
  // The restore writes through a tmp+rename sibling — the same
  // care the write/edit ops have always taken. A crash mid-undo can
  // therefore never leave a half-written file (the worst failure mode for a
  // recovery tool): the target either keeps its old content or receives the
  // restored content wholesale. The tmp lives beside the target in the same
  // directory (same filesystem), so the rename is atomic; a failed
  // write/rename cleans the tmp up best-effort and reports the failure
  // without touching the target.
  //
  // The rename replaces the target's inode, so the tmp must
  // carry the target's own mode — a plain writeFile would hand a 0600 secret
  // the umask default (0644) and strip a script's exec bit. The tmp is
  // created 0600 first, so crash residue is never world-readable, then the
  // existing target's mode is copied onto it before the rename; a missing
  // target (the recreate path) keeps the restrictive default.
  const bridge = createNodeFileBridge('/');
  const tmp = `${target}.kubic-restore-${process.pid}.tmp`;
  let targetMode: number | undefined;
  try {
    const info = bridge.fileInfo(target);
    // A symlink's lstat mode is 0777 on every platform, and the rename would
    // replace the link itself: copying those bits onto the replacement would
    // hand the workspace a world-writable file. The mode is preserved for a
    // regular file only (an unclassified double counts as regular).
    if (info.isSymbolicLink === false && info.isFile !== false) {
      targetMode = info.mode;
    }
  } catch {
    // Target absent (recreate path): no mode to preserve.
  }
  try {
    // `writeFileSync` applies the creation mode only to a fresh file, and a
    // same-pid stale tmp (pid reuse) could otherwise keep its old mode:
    // clearing it first makes the 0600 creation unconditional. Best-effort —
    // the write below reports real failures.
    if (bridge.exists(tmp)) bridge.remove(tmp, false, true);
  } catch {
    // Best-effort; the restore write is what must succeed.
  }
  try {
    bridge.writeFile(tmp, before, { mode: 0o600 });
    if (targetMode !== undefined) bridge.chmod?.(tmp, targetMode);
    bridge.renameFile(tmp, target);
  } catch (error) {
    try {
      bridge.remove(tmp, false, true);
    } catch {
      // Best-effort tmp cleanup; the untouched target is what matters.
    }
    return {
      restored: false,
      reason: `restore write failed: ${(error as Error).message}`,
    };
  }
  sweepStaleRestoreTmps(bridge, target);
  return { restored: true };
}
