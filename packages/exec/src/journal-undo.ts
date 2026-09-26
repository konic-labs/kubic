// Journal undo core (issue #18, slice B; §42.2).
// Whole-run undo walks entries reverse-chronologically so layered edits
// unwind in order (v1→v2→v3 restores v2, then v1). Steps without
// before-content are skipped and reported — never guessed.
//
// Issue #108: a step may only restore when the file's CURRENT state is one
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

import {
  type FileCurrentState,
  type FileJournalStore,
  type JournalEntry,
  probeFileState,
  restoreEntry,
} from './journal.js';

export interface UndoScope {
  path?: string;
  step?: boolean;
}

export interface UndoPlan {
  steps: JournalEntry[];
  reversible: number;
  nonReversible: string[];
  /** Paths whose current content is stale relative to their entry (read-only count). */
  stale: number;
  stalePaths: string[];
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
  planBeforeHashes: ReadonlySet<string> | undefined,
  force: boolean,
): Verdict {
  if (force) return { kind: 'restore' };
  if (state.missing) {
    // The recreate path of the #108 matrix: a missing file can always be
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
    planBeforeHashes?.has(state.hash) === true
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
  let steps = [...store.entries()].reverse();
  if (scope.path !== undefined) {
    const path = scope.path;
    steps = steps.filter((e) => e.path === path);
  }
  if (scope.step === true) steps = steps.slice(0, 1);
  let reversible = 0;
  const nonReversible: string[] = [];
  const planBeforeHashes = new Map<string, Set<string>>();
  for (const step of steps) {
    if (store.readBefore(step) !== null) {
      reversible++;
      if (step.beforeHash !== null) {
        const set = planBeforeHashes.get(step.path) ?? new Set<string>();
        set.add(step.beforeHash);
        planBeforeHashes.set(step.path, set);
      }
    } else if (!nonReversible.includes(step.path)) {
      nonReversible.push(step.path);
    }
  }
  // Staleness is a disk comparison, so it needs the workspace root; without
  // one (plan-only callers) the counts stay zero and the real/dry-run paths
  // compute their own verdicts. Pure read: planning never writes.
  const stalePaths: string[] = [];
  if (root !== undefined) {
    // Simulate the walk (a real run writes the same states in the same
    // order): a step is stale only relative to the state the walk reaches.
    const simulated = new Map<string, FileCurrentState>();
    for (const step of steps) {
      if (store.readBefore(step) === null) continue; // never reversible
      const state = simulated.get(step.path) ?? probeFileState(root, step.path);
      const verdict = verdictFor(
        state,
        step,
        planBeforeHashes.get(step.path),
        false,
      );
      if (verdict.kind === 'stale' && !stalePaths.includes(step.path)) {
        stalePaths.push(step.path);
      } else if (verdict.kind === 'restore') {
        // Restoring writes the step's before-content; its hash is the
        // recorded beforeHash by construction.
        simulated.set(step.path, {
          missing: false,
          hash: step.beforeHash,
        });
      }
    }
  }
  return {
    steps,
    reversible,
    nonReversible,
    stale: stalePaths.length,
    stalePaths,
  };
}

export interface SkipDetail {
  path: string;
  reason: string;
}

export interface UndoResult {
  restored: string[];
  skipped: string[];
  /** Why each step skipped — stale refusals and already-undone skips carry their reason. */
  skippedDetails: SkipDetail[];
}

export function applyUndo(
  store: FileJournalStore,
  plan: UndoPlan,
  root: string,
  options: { dryRun?: boolean; force?: boolean },
): UndoResult {
  const restored: string[] = [];
  const skipped: string[] = [];
  const skippedDetails: SkipDetail[] = [];
  const force = options.force === true;
  const planBeforeHashes = new Map<string, Set<string>>();
  for (const step of plan.steps) {
    if (store.readBefore(step) === null) continue;
    if (step.beforeHash !== null) {
      const set = planBeforeHashes.get(step.path) ?? new Set<string>();
      set.add(step.beforeHash);
      planBeforeHashes.set(step.path, set);
    }
  }
  // Dry-run simulates the walk's writes; a real run re-probes the actual
  // disk before each step (which the walk itself is mutating). Both follow
  // the same verdict rules, so --dry-run reports what the real run does.
  const simulated = new Map<string, FileCurrentState>();
  for (const step of plan.steps) {
    if (store.readBefore(step) === null) {
      skipped.push(step.path);
      skippedDetails.push({
        path: step.path,
        reason: 'no before-content: unattributed entry is not reversible',
      });
      continue;
    }
    const state =
      options.dryRun === true
        ? (simulated.get(step.path) ?? probeFileState(root, step.path))
        : probeFileState(root, step.path);
    const verdict = verdictFor(
      state,
      step,
      planBeforeHashes.get(step.path),
      force,
    );
    if (verdict.kind !== 'restore') {
      skipped.push(step.path);
      skippedDetails.push({ path: step.path, reason: verdict.reason });
      continue;
    }
    if (options.dryRun === true) {
      simulated.set(step.path, { missing: false, hash: step.beforeHash });
      restored.push(step.path);
      continue;
    }
    // The verdict already verified the walk-aware state; restoreEntry keeps
    // the containment/symlink guards and its own write-error reporting.
    const result = restoreEntry(store, step, root, { allowStale: true });
    if (result.restored) {
      restored.push(step.path);
    } else {
      skipped.push(step.path);
      skippedDetails.push({
        path: step.path,
        reason: result.reason ?? 'skipped',
      });
    }
  }
  return { restored, skipped, skippedDetails };
}
