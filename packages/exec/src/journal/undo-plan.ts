// Planning an undo: the entries a scope selects, and each step's verdict
// (restore, already-undone or stale), judged against the state the earlier
// steps of the same walk leave. undo.ts states the rules and applies a plan.
import type { HeadState } from './git.js';
import type { FileCurrentState } from './restore.js';
import { isUndoableCreate, probeFileState } from './restore.js';
import type { FileJournalStore } from './store.js';
import type { JournalEntry } from './types.js';

export interface UndoScope {
  path?: string;
  step?: boolean;
}

interface HeadMove {
  from: HeadState;
  to: HeadState;
}

export interface UndoPlan {
  steps: JournalEntry[];
  reversible: number;
  nonReversible: string[];
  /** Paths whose current content is stale relative to their entry (read-only count). */
  stale: number;
  stalePaths: string[];
  /**
   * In-scope markers newer than at least one step — restoring
   * such a step would write pre-move content onto the moved HEAD, so it
   * needs `--force`. Oldest first. Empty when no marker blocks a step.
   */
  headMoves: HeadMove[];
}

// The HEAD-move barrier over one read of the index: the markers in
// chronological order, and each entry's earliest position. Positions match
// by value, not reference: applyUndo re-reads the index, so its entry
// objects differ from the plan's. Duplicate-shaped entries (identical JSON
// at two positions) resolve conservatively — the earliest position counts,
// so the step crosses if ANY copy is older than a marker — the safe
// direction, and `--force` is the override either way.
interface HeadMoveBarrier {
  markers: Array<{ at: number; move: HeadMove }>;
  firstAt: Map<string, number>;
}

export function headMoveBarrier(all: JournalEntry[]): HeadMoveBarrier {
  const markers: HeadMoveBarrier['markers'] = [];
  all.forEach((e, at) => {
    if (
      e.op === 'marker' &&
      e.headFrom !== undefined &&
      e.headTo !== undefined
    ) {
      markers.push({ at, move: { from: e.headFrom, to: e.headTo } });
    }
  });
  const firstAt = new Map<string, number>();
  // Without a marker nothing can cross: no entry is keyed.
  if (markers.length > 0) {
    all.forEach((e, at) => {
      const key = JSON.stringify(e);
      if (!firstAt.has(key)) firstAt.set(key, at);
    });
  }
  return { markers, firstAt };
}

// The move restoring `step` would cross: the oldest marker newer than it.
export function stepCrosses(
  barrier: HeadMoveBarrier,
  step: JournalEntry,
): HeadMove | null {
  if (barrier.markers.length === 0) return null;
  const at = barrier.firstAt.get(JSON.stringify(step));
  if (at === undefined) return null;
  return barrier.markers.find((marker) => marker.at > at)?.move ?? null;
}

// A step is reversible when its pre-state is recoverable: a before-blob,
// or — for an agent-authored create — the known pre-state "absent".
export function canUndo(store: FileJournalStore, entry: JournalEntry): boolean {
  return store.readBefore(entry) !== null || isUndoableCreate(entry);
}

// Per-path journaled before-states of a plan: content hashes, plus the
// steps for which "absent" is a journaled earlier state — the steps at or
// after an agent create with no delete in between. Order matters: absence
// after a create masks nothing, but absence that follows a DELETE is that
// delete's after-state, which undo must still restore (a later
// create must never make an earlier delete read as already undone).
interface PlanBefore {
  hashes: Set<string>;
  absentSteps: Set<JournalEntry>;
}

export function collectPlanBefore(
  store: FileJournalStore,
  steps: JournalEntry[],
): Map<string, PlanBefore> {
  const out = new Map<string, PlanBefore>();
  const sinceCreate = new Map<string, boolean>();
  // Plans are reverse-chronological; walk forward in time.
  for (const step of [...steps].reverse()) {
    if (isUndoableCreate(step)) sinceCreate.set(step.path, true);
    else if (step.afterHash === null) sinceCreate.set(step.path, false);
    if (!canUndo(store, step)) continue;
    const slot = out.get(step.path) ?? {
      hashes: new Set<string>(),
      absentSteps: new Set<JournalEntry>(),
    };
    if (step.beforeHash !== null) slot.hashes.add(step.beforeHash);
    if (sinceCreate.get(step.path) === true) slot.absentSteps.add(step);
    out.set(step.path, slot);
  }
  return out;
}

// The state a successful step leaves behind — what the walk simulates.
export function stateAfterUndo(step: JournalEntry): FileCurrentState {
  return isUndoableCreate(step)
    ? { missing: true, hash: null }
    : { missing: false, hash: step.beforeHash };
}

type Verdict =
  | { kind: 'restore' }
  | { kind: 'already-undone'; reason: string }
  | { kind: 'stale'; reason: string }
  | { kind: 'contested'; reason: string };

// The already-undone rule needs the plan's journaled before-states per
// path: a disk state matching ANY of them means the file sits at a state
// the journal itself recorded — no unjournaled data is at risk.
export function verdictFor(
  state: FileCurrentState,
  entry: JournalEntry,
  planBefore: PlanBefore | undefined,
  force: boolean,
): Verdict {
  if (state.missing && planBefore?.absentSteps.has(entry) === true) {
    // Absent is a journaled before-state for this path (an agent create
    // is in the plan): the file already sits where undo would take it.
    // Checked before --force — removing a missing file restores nothing.
    return {
      kind: 'already-undone',
      reason: `already undone: '${entry.path}' is absent, its journaled pre-create state — nothing to restore`,
    };
  }
  if (force) return { kind: 'restore' };
  // Swept while another session was live here: the change may be that
  // session's work, which a restore would discard.
  if (entry.contested !== undefined && entry.contested.length > 0) {
    return {
      kind: 'contested',
      reason: `contested: '${entry.path}' changed while session ${entry.contested.join(', ')} was running in this workspace — it may be that session's work; use --force`,
    };
  }
  if (state.missing) {
    // The recreate path of the matrix: a missing file can always be
    // restored — there is nothing on disk for the restore to destroy.
    return { kind: 'restore' };
  }
  if (state.hash === null) {
    return {
      kind: 'stale',
      reason: `stale: '${entry.path}' exists but its current content could not be read to verify state — use --force`,
    };
  }
  if (state.hash === entry.afterHash) return { kind: 'restore' };
  if (
    (entry.beforeHash !== null && state.hash === entry.beforeHash) ||
    planBefore?.hashes.has(state.hash) === true
  ) {
    return {
      kind: 'already-undone',
      reason: `already undone: '${entry.path}' sits at an earlier journaled state — nothing to restore`,
    };
  }
  return {
    kind: 'stale',
    reason:
      `stale: '${entry.path}' changed after this entry was journaled ` +
      `(current sha256 ${state.hash.slice(0, 12)}… ` +
      `≠ recorded after ${entry.afterHash?.slice(0, 12) ?? 'none'}…) — ` +
      'restoring would discard those changes; use --force',
  };
}

export function planUndo(
  store: FileJournalStore,
  scope: UndoScope,
  root?: string,
): UndoPlan {
  // Markers are scope-less bookkeeping — never steps, but the
  // barrier applies in every scope (a `--path` restore crosses the move
  // exactly like a whole-run one), so they survive the path filter and are
  // dropped only when steps are selected.
  const all = store.entries();
  const barrier = headMoveBarrier(all);
  let steps = [...all].reverse();
  if (scope.path !== undefined) {
    const path = scope.path;
    steps = steps.filter((e) => e.path === path || e.op === 'marker');
  }
  // Markers are never steps: `--step` lands on the newest file entry even
  // when a marker is newer, and plain undo never tries to restore one.
  steps = steps.filter((e) => e.op !== 'marker');
  if (scope.step === true) {
    // One step: the newest entry for the scope, undo records included. That
    // is the redo path — undoing the undo record re-applies the pre-undo
    // content — so --step must never skip bookkeeping.
    steps = steps.slice(0, 1);
  } else {
    // Plain undo restores real agent work only: the
    // journal's own `kubic-undo` records are bookkeeping, not work. Without
    // this filter, a second plain undo walks the first undo's records too,
    // restores every pre-undo state again and appends one new record per
    // step — the walk doubles on every run (an exponential append/fsync
    // amplifier bounded only by retention pruning). With it, the second
    // plain undo finds the disk sitting at a journaled before-state, reports
    // `already undone` and appends nothing — the pre idempotent
    // behavior. Mixed logs still unwind in reverse-chronological order:
    // bookkeeping records are skipped over, and an agent step an earlier
    // undo already unwound reads as already-undone.
    steps = steps.filter((e) => e.source !== 'undo');
  }
  let reversible = 0;
  const nonReversible: string[] = [];
  for (const step of steps) {
    if (canUndo(store, step)) {
      reversible++;
    } else if (!nonReversible.includes(step.path)) {
      nonReversible.push(step.path);
    }
  }
  const planBefore = collectPlanBefore(store, steps);
  // Staleness is a disk comparison, so it needs the workspace root; without
  // one (plan-only callers) the counts stay zero and the real/dry-run paths
  // compute their own verdicts. Pure read: planning never writes.
  const stalePaths: string[] = [];
  if (root !== undefined) {
    // Simulate the walk (a real run writes the same states in the same
    // order): a step is stale only relative to the state the walk reaches.
    const simulated = new Map<string, FileCurrentState>();
    for (const step of steps) {
      if (!canUndo(store, step)) continue; // never reversible
      const state = simulated.get(step.path) ?? probeFileState(root, step.path);
      const verdict = verdictFor(state, step, planBefore.get(step.path), false);
      if (verdict.kind === 'stale' && !stalePaths.includes(step.path)) {
        stalePaths.push(step.path);
      } else if (verdict.kind === 'restore') {
        // Restoring writes the step's before-content (its hash is the
        // recorded beforeHash by construction); undoing a create removes.
        simulated.set(step.path, stateAfterUndo(step));
      }
    }
  }
  // The markers blocking at least one step — oldest first,
  // deduplicated (one marker can block many steps).
  const headMoves: HeadMove[] = [];
  for (const step of steps) {
    const move = stepCrosses(barrier, step);
    if (
      move !== null &&
      !headMoves.some(
        (m) =>
          JSON.stringify(m.from) === JSON.stringify(move.from) &&
          JSON.stringify(m.to) === JSON.stringify(move.to),
      )
    ) {
      headMoves.push(move);
    }
  }
  return {
    steps,
    reversible,
    nonReversible,
    stale: stalePaths.length,
    stalePaths,
    headMoves,
  };
}
