// Session-state retention core: plan and execute
// the prune of per-session state dirs under the sessions root.
//
// Scope: `<root>/<session-id>/` state dirs only — the journal store, spans,
// approvals posture, and the session lock live there. A folder that holds no
// session file is not a session and is never this command's scope
// (documented in docs/cli/commands.md): a prune may only take a directory it
// can prove belongs to one session alone.
//
// Rails (each pinned behaviourally by sessions-prune.test.ts):
// - a session holding a LIVE lock is never a candidate (read-only view:
//   worker `sessionLockIsLive`; a dead holder — a stale lock — never
//   protects), and the lock is re-checked immediately before each delete —
//   a lock acquired between the plan and the delete pass still stops it;
// - `--keep-session` names are never candidates;
// - age: the session dir's own mtime is the last-touch signal. Create,
//   attach, and close all bump it; appends inside the dir only ever happen
//   while a lock is held, which the rail above already protects — so a
//   recently attached session can never be aged out by stale inner
//   contents;
// - non-session-shaped entries (any non-directory, any name outside
//   `[A-Za-z0-9_-]`, any folder holding no session file) are skipped;
// - anything that cannot be inspected fails safe: skipped, reported.
//
// I/O goes through the exec FileBridge (I/O confinement): this module
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

interface SessionPruneCandidate {
  id: string;
  // Bytes over the session dir tree (regular files only; symlinks are
  // never followed).
  bytes: number;
}

interface SessionPruneLocked {
  id: string;
  pid: number;
  startedAt?: number;
}

interface SessionPruneKept {
  id: string;
  // `--keep-session` for an explicit name; `child of <id>` for a run
  // member kept with its explicitly kept parent.
  why: string;
}

export interface SessionPrunePlan {
  candidates: SessionPruneCandidate[];
  locked: SessionPruneLocked[];
  // Aged sessions protected by name (`--keep-session`).
  kept: SessionPruneKept[];
  // Session-shaped entries that could not be inspected — skipped, reported.
  unreadable: string[];
  totalBytes: number;
}

// Kubic's session files, one of which every session state dir holds. A folder
// with none of them is not a session state dir, so prune never takes it.
const SESSION_FILES = ['main.jsonl', 'session.json', 'lock.json'] as const;

function holdsSessionFile(bridge: FileBridge, name: string): boolean {
  return SESSION_FILES.some((file) => bridge.exists(join(name, file)));
}

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
  // First pass: locks and mtimes. Locked sessions are reported, never
  // candidates.
  const mtimes = new Map<string, number>();
  const lockedIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymbolicLink) continue;
    if (!SESSION_ID_PATTERN.test(entry.name)) continue;
    if (!holdsSessionFile(args.bridge, entry.name)) continue;
    const posture = sessionLockIsLive(join(args.root, entry.name));
    if (posture !== undefined) {
      plan.locked.push({ id: entry.name, ...posture });
      lockedIds.add(entry.name);
    }
    let info: BridgeFileInfo;
    try {
      info = args.bridge.fileInfo(entry.name);
    } catch {
      // A locked session whose header cannot be statted is
      // already reported in exactly one bucket (locked) — the live lock
      // read succeeded, only the stat failed.
      if (!lockedIds.has(entry.name)) plan.unreadable.push(entry.name);
      continue;
    }
    mtimes.set(entry.name, info.mtimeMs);
  }
  for (const id of mtimes.keys()) {
    if (lockedIds.has(id)) continue; // locked: reported, never a candidate
    if ((mtimes.get(id) ?? 0) > cutoff) continue; // recent: not a candidate
    if (keep.has(id)) {
      plan.kept.push({ id, why: '--keep-session' });
      continue;
    }
    const bytes = dirBytes(args.bridge, id);
    if (bytes === undefined) {
      plan.unreadable.push(id);
      continue;
    }
    plan.candidates.push({ id, bytes });
  }
  plan.candidates.sort(byId);
  plan.locked.sort(byId);
  plan.kept.sort((left, right) => byName(left.id, right.id));
  plan.unreadable.sort(byName);
  plan.totalBytes = plan.candidates.reduce(
    (sum, candidate) => sum + candidate.bytes,
    0,
  );
  return plan;
}

// One candidate's fate in the delete pass. `deleted` was
// removed and accounted; `locked` had a lock go live between planning and
// this candidate's delete — skipped and reported exactly like a
// planning-time lock, never removed, never counted as deleted; `failed`
// was refused by the bridge (the caller reports it and exits non-zero).
export type SessionPruneDeleteOutcome =
  | { status: 'deleted'; candidate: SessionPruneCandidate }
  | {
      status: 'locked';
      candidate: SessionPruneCandidate;
      pid: number;
      startedAt?: number;
    }
  | { status: 'failed'; candidate: SessionPruneCandidate; message: string };

export interface SessionPruneDeleteArgs {
  root: string;
  bridge: FileBridge;
  candidates: readonly SessionPruneCandidate[];
}

// Delete the planned candidates. Planning and deletion are two
// passes, so a lock acquired in between must still stop the delete: the
// liveness re-check sits immediately before each remove by construction —
// a candidate that went live is skipped, reported, and never counted as
// deleted.
export function deleteSessionPruneCandidates(
  args: SessionPruneDeleteArgs,
): SessionPruneDeleteOutcome[] {
  const outcomes: SessionPruneDeleteOutcome[] = [];
  for (const candidate of args.candidates) {
    const posture = sessionLockIsLive(join(args.root, candidate.id));
    if (posture !== undefined) {
      outcomes.push({ status: 'locked', candidate, ...posture });
      continue;
    }
    try {
      args.bridge.remove(candidate.id, true, true);
    } catch (error) {
      outcomes.push({ status: 'failed', candidate, message: detail(error) });
      continue;
    }
    outcomes.push({ status: 'deleted', candidate });
  }
  return outcomes;
}
