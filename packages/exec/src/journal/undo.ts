// Journal undo core.
// Whole-run undo walks entries reverse-chronologically so layered edits
// unwind in order (v1→v2→v3 restores v2, then v1). Steps without
// before-content are skipped and reported — never guessed — except an
// agent-authored create, whose pre-state is exactly "absent": undoing it
// removes the file (journaled as a `kubic-undo` delete, so --step redoes).
//
// A successful restore appends its inverse entry under
// `source: undo`. Plain plans exclude those records — they are the
// walk's own bookkeeping, so repeated plain undo stays idempotent (the disk
// sits at a journaled before-state → already-undone, nothing appended).
// `--step` targets the newest entry including a bookkeeping record: that is
// the redo.
//
// A step may only restore when the file's CURRENT state is one
// the journal accounts for. Three verdicts, evaluated walk-aware (the walk
// itself changes the file, so each step is judged against the state the
// previous steps left — a dry-run simulates exactly what a real run writes):
//
//   restore         disk matches the step's recorded after-state (or the
//                   file is missing — recreating destroys nothing), so the
//                   restore is safe.
//   already-undone  disk matches a journaled BEFORE-state (this step, or a
//                   sibling step of the same path in the plan): a previous
//                   undo already unwound it — nothing to do, and re-writing
//                   would be a no-op mislabeled "restored".
//   stale           disk matches nothing the journal recorded — a change
//                   landed after this entry (manual edit, another run).
//                   Restoring would destroy it; refuse with a reason and
//                   let --force override.
//
// A fourth refusal sits before the file is touched — the
// inverse record the step would append is planned and measured
// against the store's bound first. A restore whose record cannot fit is
// skipped with a warning and a named reason, because recording it after the
// mutation would leave the workspace changed with no undo/redo entry.

import { resolve } from 'node:path';
import { createNodeFileBridge } from '../file-bridge.js';
import type { HeadState } from './git.js';
import { sha256HexOfBytes } from './hash.js';
import type { FileCurrentState } from './restore.js';
import {
  isUndoableCreate,
  probeFileState,
  removeCreatedEntry,
  restoreEntry,
} from './restore.js';
import { formatHeadMove } from './status.js';
import type { FileJournalStore } from './store.js';
import type { JournalEntry, JournalEntryInput } from './types.js';

export interface UndoScope {
  path?: string;
  step?: boolean;
}

// The session id the journal's own undo bookkeeping carries: every successful
// restore appends its inverse entry under it, with source `undo`. Plain undo
// plans exclude those entries — see planUndo.
const UNDO_SESSION_ID = 'kubic-undo';

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

// Chronological positions of in-scope markers in `all`, and
// whether `step` is older than any of them (restoring it crosses the move).
// Position-matched by value, not reference: applyUndo re-reads the index,
// so its entry objects differ from the plan's. Duplicate-shaped entries
// (identical JSON at two positions) resolve conservatively — crossing if
// ANY matching position is older than a marker — the safe direction, and
// `--force` is the override either way.
function markerPositions(all: JournalEntry[]): number[] {
  const out: number[] = [];
  all.forEach((e, i) => {
    if (
      e.op === 'marker' &&
      e.headFrom !== undefined &&
      e.headTo !== undefined
    ) {
      out.push(i);
    }
  });
  return out;
}

function stepCrosses(
  all: JournalEntry[],
  step: JournalEntry,
  markers: number[],
): HeadMove | null {
  if (markers.length === 0) return null;
  const key = JSON.stringify(step);
  for (let i = 0; i < all.length; i++) {
    if (JSON.stringify(all[i]) !== key) continue;
    const newer = markers.filter((m) => m > i);
    if (newer.length > 0) {
      const marker = all[newer[0] ?? -1];
      if (
        marker?.op === 'marker' &&
        marker.headFrom !== undefined &&
        marker.headTo !== undefined
      ) {
        return { from: marker.headFrom, to: marker.headTo };
      }
    }
  }
  return null;
}

// A step is reversible when its pre-state is recoverable: a before-blob,
// or — for an agent-authored create — the known pre-state "absent".
function canUndo(store: FileJournalStore, entry: JournalEntry): boolean {
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

function collectPlanBefore(
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
function stateAfterUndo(step: JournalEntry): FileCurrentState {
  return isUndoableCreate(step)
    ? { missing: true, hash: null }
    : { missing: false, hash: step.beforeHash };
}

type Verdict =
  | { kind: 'restore' }
  | { kind: 'already-undone'; reason: string }
  | { kind: 'stale'; reason: string };

// The already-undone rule needs the plan's journaled before-states per
// path: a disk state matching ANY of them means the file sits at a state
// the journal itself recorded — no unjournaled data is at risk.
function verdictFor(
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
  const markers = markerPositions(all);
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
    const move = stepCrosses(all, step, markers);
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

interface SkipDetail {
  path: string;
  reason: string;
}

export interface UndoResult {
  restored: string[];
  skipped: string[];
  /** Why each step skipped — stale refusals and already-undone skips carry their reason. */
  skippedDetails: SkipDetail[];
  /** Completed steps with a caveat (e.g. a removal that cannot be redone). */
  warnings: string[];
}

export interface UndoOptions {
  dryRun?: boolean;
  force?: boolean;
  /**
   * Clock for the undo record's timestamp. Production passes
   * nothing (`Date.now()`); tests pin it. Only the appended record reads it —
   * the restore itself is unaffected.
   */
  now?: () => number;
}

// The inverse record a step will append, planned before the mutation so its
// size can be checked against the store's bound first. `entry` is null when the
// step records nothing: a restore with no retrievable pre-image, or a create
// whose removal did not happen. The pre-state reads live here so the branches
// below act on the same bytes the record was measured from.
interface InversePlan {
  entry: JournalEntryInput | null;
  /** Create-shaped steps: the removed content (null when it was not
   *  lossless utf-8 text — the removal then cannot be redone). */
  removedContent: string | null;
  /** Write-shaped steps: the pre-undo content could not be
   *  recorded as text (binary/invalid utf-8), so the record carries its raw
   *  hash only and the undo cannot be redone. */
  lossyBefore: boolean;
}

function planInverse(
  step: JournalEntry,
  store: FileJournalStore,
  root: string,
  timestamp: number,
): InversePlan {
  if (isUndoableCreate(step)) {
    // Undo of a create removes the file. The removed content becomes the
    // undo record's before, so `--step` right after is the redo. Lossless
    // check on the real bytes (the walk hash is a hash of the utf-8 decode,
    // so it cannot detect a lossy decode): binary content is never recorded
    // as a mangled pre-image for the redo.
    let removedContent: string | null = null;
    try {
      const bytes = Buffer.from(
        createNodeFileBridge(root).readBinaryFile(resolve(root, step.path)),
      );
      const decoded = bytes.toString('utf8');
      removedContent = Buffer.from(decoded, 'utf8').equals(bytes)
        ? decoded
        : null;
    } catch {
      removedContent = null;
    }
    return {
      removedContent,
      lossyBefore: false,
      entry: {
        path: step.path,
        op: 'delete',
        before: removedContent,
        after: null,
        bytesDelta:
          removedContent === null
            ? 0
            : -Buffer.byteLength(removedContent, 'utf8'),
        sessionId: UNDO_SESSION_ID,
        source: 'undo',
        toolCallId: null,
        timestamp,
      },
    };
  }
  // Pre-undo state for the record: read before the restore overwrites it — as
  // BYTES, with the same lossless rule the create-removal path applies. A utf-8
  // decode that cannot round-trip (binary content) must not become the record's
  // before-side: a following `undo --step` would write the mangled text back
  // over the user's bytes. The raw hash is recorded instead, marked as a
  // designed omission — never U+FFFD text. A missing file (null) is recorded as
  // such — no content is invented.
  let preUndo: string | null = null;
  let preUndoHash: string | null = null;
  // The pre-image's byte length, whether or not it survived the utf-8 round
  // trip: `bytesDelta` is the change this record describes, and an omitted
  // (lossy) pre-image is still bytes that were there (review of — the
  // same accounting `write` uses for a hash-only pre-image).
  let preUndoBytes = 0;
  let lossyBefore = false;
  try {
    const bytes = Buffer.from(
      createNodeFileBridge(root).readBinaryFile(resolve(root, step.path)),
    );
    preUndoBytes = bytes.length;
    const decoded = bytes.toString('utf8');
    if (Buffer.from(decoded, 'utf8').equals(bytes)) {
      preUndo = decoded;
    } else {
      preUndoHash = sha256HexOfBytes(bytes);
      lossyBefore = true;
    }
  } catch {
    preUndo = null;
  }
  const restoredContent = store.readBefore(step);
  return {
    removedContent: null,
    lossyBefore,
    entry:
      restoredContent === null
        ? null
        : {
            path: step.path,
            // Restores write content — delete entries restore as writes too.
            op: 'write',
            before: preUndo,
            ...(preUndoHash === null
              ? {}
              : { beforeHash: preUndoHash, beforeOmitted: true }),
            after: restoredContent,
            bytesDelta:
              Buffer.byteLength(restoredContent, 'utf8') - preUndoBytes,
            sessionId: UNDO_SESSION_ID,
            source: 'undo',
            toolCallId: null,
            timestamp,
          },
  };
}

export function applyUndo(
  store: FileJournalStore,
  plan: UndoPlan,
  root: string,
  options: UndoOptions,
): UndoResult {
  const restored: string[] = [];
  const skipped: string[] = [];
  const skippedDetails: SkipDetail[] = [];
  const warnings: string[] = [];
  const force = options.force === true;
  const now = options.now ?? ((): number => Date.now());
  const planBefore = collectPlanBefore(store, plan.steps);
  // The barrier, evaluated against the live index (which may
  // have grown since planning — a concurrent append cannot smuggle a step
  // past a marker).
  const undoAll = store.entries();
  const undoMarkers = markerPositions(undoAll);
  // Dry-run simulates the walk's writes; a real run re-probes the actual
  // disk before each step (which the walk itself is mutating). Both follow
  // the same verdict rules, so --dry-run reports what the real run does.
  const simulated = new Map<string, FileCurrentState>();
  for (const step of plan.steps) {
    if (!canUndo(store, step)) {
      skipped.push(step.path);
      skippedDetails.push({
        path: step.path,
        reason:
          'no before-content: no retrievable pre-image for this entry — nothing to restore',
      });
      continue;
    }
    // A step older than a newer in-scope marker restores only
    // with `--force` — its pre-move content does not belong on the moved
    // HEAD. The dry run reports the same skip, so it never promises a
    // restore the real run refuses.
    const crossing = stepCrosses(undoAll, step, undoMarkers);
    if (crossing !== null && !force) {
      const reason =
        `head-moved: '${step.path}' was journaled before HEAD moved ` +
        `(${formatHeadMove(crossing.from, crossing.to)}) — restoring would ` +
        'write pre-move content onto the moved HEAD; use --force';
      skipped.push(step.path);
      skippedDetails.push({ path: step.path, reason });
      continue;
    }
    const state =
      options.dryRun === true
        ? (simulated.get(step.path) ?? probeFileState(root, step.path))
        : probeFileState(root, step.path);
    const verdict = verdictFor(state, step, planBefore.get(step.path), force);
    if (verdict.kind !== 'restore') {
      skipped.push(step.path);
      skippedDetails.push({ path: step.path, reason: verdict.reason });
      continue;
    }
    // The inverse record is appended AFTER the mutation,
    // so whether it can be recorded is decided BEFORE the file is touched.
    // A restore the store would refuse (its own bound is the whole journal:
    // index + blobs) would otherwise leave the workspace changed with no
    // undo/redo entry and no report of what happened. The dry run reports
    // the same skip, so it never promises a restore the real run refuses.
    const inverse = planInverse(step, store, root, now());
    if (inverse.entry !== null) {
      const { entryBytes, maxBytes } = store.entryBound(inverse.entry);
      if (entryBytes > maxBytes) {
        skipped.push(step.path);
        skippedDetails.push({
          path: step.path,
          reason: `too large to record: the inverse entry needs ${entryBytes} bytes, over the journal's ${maxBytes}-byte bound`,
        });
        warnings.push(
          `skipped '${step.path}': recording the undo needs ${entryBytes} bytes, over the journal's ${maxBytes}-byte bound — the file was left as it is`,
        );
        continue;
      }
    }
    if (options.dryRun === true) {
      simulated.set(step.path, stateAfterUndo(step));
      restored.push(step.path);
      continue;
    }
    if (isUndoableCreate(step)) {
      const removal = removeCreatedEntry(step, root);
      if (!removal.restored) {
        skipped.push(step.path);
        skippedDetails.push({ path: step.path, reason: removal.reason });
        continue;
      }
      restored.push(step.path);
      if (inverse.removedContent === null) {
        warnings.push(
          `removed '${step.path}' without a recoverable copy (content was not lossless utf-8 text) — this removal cannot be redone`,
        );
      }
      if (inverse.entry !== null) store.append(inverse.entry);
      continue;
    }
    // The verdict already verified the walk-aware state; restoreEntry keeps
    // the containment/symlink guards and its own write-error reporting.
    const result = restoreEntry(store, step, root, { allowStale: true });
    if (result.restored) {
      restored.push(step.path);
      if (inverse.lossyBefore) {
        warnings.push(
          `restored '${step.path}' without a recoverable copy of its pre-undo content (it was not lossless utf-8 text) — this undo cannot be redone`,
        );
      }
      // The undo is itself a change: journal the inverse so
      // `kubic diff`/`log` describe the world after the undo — and so a
      // second `undo --step` re-applies the pre-undo content (the redo).
      // The record was planned (and measured against the store's bound)
      // before the restore; it is null only when the step has no retrievable
      // pre-image, in which case nothing is recorded — never a guessed one.
      if (inverse.entry !== null) store.append(inverse.entry);
    } else {
      skipped.push(step.path);
      skippedDetails.push({
        path: step.path,
        reason: result.reason ?? 'skipped',
      });
    }
  }
  return { restored, skipped, skippedDetails, warnings };
}
