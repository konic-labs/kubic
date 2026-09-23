// Journal undo core (issue #18, slice B; §42.2).
// Whole-run undo walks entries reverse-chronologically so layered edits
// unwind in order (v1→v2→v3 restores v2, then v1). Steps without
// before-content are skipped and reported — never guessed.

import {
  type FileJournalStore,
  type JournalEntry,
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
}

export function planUndo(store: FileJournalStore, scope: UndoScope): UndoPlan {
  let steps = [...store.entries()].reverse();
  if (scope.path !== undefined) {
    const path = scope.path;
    steps = steps.filter((e) => e.path === path);
  }
  if (scope.step === true) steps = steps.slice(0, 1);
  let reversible = 0;
  const nonReversible: string[] = [];
  for (const step of steps) {
    if (store.readBefore(step) !== null) {
      reversible++;
    } else if (!nonReversible.includes(step.path)) {
      nonReversible.push(step.path);
    }
  }
  return { steps, reversible, nonReversible };
}

export interface UndoResult {
  restored: string[];
  skipped: string[];
}

export function applyUndo(
  store: FileJournalStore,
  plan: UndoPlan,
  root: string,
  options: { dryRun?: boolean },
): UndoResult {
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const step of plan.steps) {
    if (options.dryRun === true) {
      if (store.readBefore(step) !== null) restored.push(step.path);
      else skipped.push(step.path);
      continue;
    }
    const result = restoreEntry(store, step, root);
    if (result.restored) restored.push(step.path);
    else skipped.push(step.path);
  }
  return { restored, skipped };
}
