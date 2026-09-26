// Session-state retention core (issue #119; §21, §42.4): plan the prune of
// per-session state dirs under the sessions root.
//
// Scope: `<root>/<session-id>/` state dirs only — the journal store, spans,
// approvals posture, and the session lock live there. pi's transcripts live
// one level over, in `<root>/--<cwd>--/<ts>_<id>.jsonl`, and are NOT this
// command's scope (documented in docs/cli/commands.md): a prune may only
// take a directory it can prove belongs to one session alone.
//
// Rails (each pinned behaviourally by sessions-prune.test.ts):
// - a session holding a LIVE lock is never a candidate (read-only view:
//   worker `sessionLockIsLive`; a dead holder — a stale lock — never
//   protects);
// - `--keep-session` names are never candidates;
// - age: the session dir's own mtime is the last-touch signal. Create,
//   attach, and close all bump it; appends inside the dir only ever happen
//   while a lock is held, which the rail above already protects — so a
//   recently attached session can never be aged out by stale inner
//   contents;
// - non-session-shaped entries (any non-directory, any name outside
//   `[A-Za-z0-9_-]`, pi's `--<cwd>--` transcript dirs) are skipped;
// - anything that cannot be inspected fails safe: skipped, reported.
//
// I/O goes through the exec FileBridge (I/O confinement, §9): this module
// never imports node:fs.

import { join } from 'node:path';
import type { BridgeFileInfo, FileBridge } from '../../exec/src/file-bridge.js';
import { sessionLockIsLive } from '../../worker/src/lane/session-store.js';
import { MS_PER_DAY } from './config/runtime.js';
import { SESSION_ID_PATTERN } from './run-cli.js';

// A malformed sessions root (exists, but cannot be listed as a directory):
// refused by name, never half-scanned.
export class SessionsRootError extends Error {
  constructor(root: string, detail: string) {
    super(`sessions root ${root} is not a readable directory (${detail})`);
    this.name = 'SessionsRootError';
  }
}

export interface SessionPruneCandidate {
  id: string;
  // Bytes over the session dir tree (regular files only; symlinks are
  // never followed).
  bytes: number;
}

export interface SessionPruneLocked {
  id: string;
  pid: number;
  startedAt?: number;
}

export interface SessionPrunePlan {
  candidates: SessionPruneCandidate[];
  locked: SessionPruneLocked[];
  // Aged sessions protected by name (`--keep-session`).
  kept: string[];
  // Session-shaped entries that could not be inspected — skipped, reported.
  unreadable: string[];
  totalBytes: number;
}

// pi's transcript directories sit one level under the root, named
// `--<cwd with /, \\ and : mapped to -->--` (`--work--` for `/work`). Their
// name satisfies the session-id character class, but they carry the `.jsonl`
// transcripts of EVERY session recorded against that cwd — never one
// session's state dir, so prune must never take one.
const TRANSCRIPT_DIR_PATTERN = /^--.*--$/;

export interface SessionPrunePlanArgs {
  root: string;
  // cwd must be the sessions root: every path below is joined from '.'.
  bridge: FileBridge;
  keepDays: number;
  keep: readonly string[];
  now?: number;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Bytes over one session dir tree. `undefined` when any level cannot be
// listed: a session whose size is unknown is never a candidate (fail-safe —
// prune must not delete what it could not first account for).
function dirBytes(bridge: FileBridge, path: string): number | undefined {
  let total = 0;
  const stack = [path];
  try {
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const entry of bridge.listDir(current)) {
        if (entry.isSymbolicLink) continue;
        if (entry.isDirectory) {
          stack.push(join(current, entry.name));
          continue;
        }
        // FIFO/socket/device entries are never read or counted as content.
        if (entry.isFile === false) continue;
        total += entry.size;
      }
    }
  } catch {
    return undefined;
  }
  return total;
}

function byId(
  a: SessionPruneCandidate | SessionPruneLocked,
  b: SessionPruneCandidate | SessionPruneLocked,
): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function planSessionPrune(args: SessionPrunePlanArgs): SessionPrunePlan {
  const plan: SessionPrunePlan = {
    candidates: [],
    locked: [],
    kept: [],
    unreadable: [],
    totalBytes: 0,
  };
  // 0 (or less) is retention OFF — the caller reports it; the core never
  // interprets a non-positive window as "everything is old".
  if (args.keepDays <= 0) return plan;
  const cutoff = (args.now ?? Date.now()) - args.keepDays * MS_PER_DAY;
  const keep = new Set(args.keep);
  let entries: BridgeFileInfo[];
  try {
    // A missing root is a fresh machine, not a failure: nothing to prune.
    // A root that cannot be listed is malformed and refused by name.
    if (!args.bridge.exists('.')) return plan;
    entries = args.bridge.listDir('.');
  } catch (error) {
    throw new SessionsRootError(args.root, detail(error));
  }
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymbolicLink) continue;
    if (!SESSION_ID_PATTERN.test(entry.name)) continue;
    if (TRANSCRIPT_DIR_PATTERN.test(entry.name)) continue;
    const posture = sessionLockIsLive(join(args.root, entry.name));
    if (posture !== undefined) {
      plan.locked.push({ id: entry.name, ...posture });
      continue;
    }
    let info: BridgeFileInfo;
    try {
      info = args.bridge.fileInfo(entry.name);
    } catch {
      plan.unreadable.push(entry.name);
      continue;
    }
    if (info.mtimeMs > cutoff) continue; // recent: not a candidate
    if (keep.has(entry.name)) {
      plan.kept.push(entry.name);
      continue;
    }
    const bytes = dirBytes(args.bridge, entry.name);
    if (bytes === undefined) {
      plan.unreadable.push(entry.name);
      continue;
    }
    plan.candidates.push({ id: entry.name, bytes });
  }
  plan.candidates.sort(byId);
  plan.locked.sort(byId);
  plan.kept.sort(byName);
  plan.unreadable.sort(byName);
  plan.totalBytes = plan.candidates.reduce(
    (sum, candidate) => sum + candidate.bytes,
    0,
  );
  return plan;
}
