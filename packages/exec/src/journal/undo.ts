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
import type { UndoPlan } from './undo-plan.js';
import {
  canUndo,
  collectPlanBefore,
  markerPositions,
  stateAfterUndo,
  stepCrosses,
  verdictFor,
} from './undo-plan.js';

// The session id the journal's own undo bookkeeping carries: every successful
// restore appends its inverse entry under it, with source `undo`. Plain undo
// plans exclude those entries — see planUndo.
const UNDO_SESSION_ID = 'kubic-undo';

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
