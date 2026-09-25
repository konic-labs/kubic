// Run-scoped reconciliation lifecycle (issue #87; §42.1 mechanism 2, §42.5).
//
// The mechanism itself lives in `journal.ts` (`captureBaseline` /
// `saveBaseline` / `loadBaseline` / `reconcile`, issue #17). What was
// missing is the production caller: every one of those was reachable only
// from tests, so non-tool effects (`sed -i`, `npm install`, a formatter, a
// build) were never journaled and `unattributed: true` entries could not
// exist outside a fixture.
//
// This module is that caller's contract, one object per run:
//
//   beginReconciliation(...)  → capture the boot baseline (§42.5), persist
//                               it beside the session journal, hand back
//   run.sweep()               → one end-of-run tree comparison, appending
//                               an unattributed entry per moved path
//
// Before-content is unknowable for reconciliation finds (the baseline holds
// hashes, not copies), so entries carry `beforeHash` and no blob: `kubic
// undo` reports them non-reversible rather than guessing (§42.2/§42.3).
//
// Fail-open by design: a caller may not let a baseline or a sweep failure
// turn a finished run into a failed one. Both entry points throw their
// named error and the caller decides — the composition roots swallow them.

import { dirname, join } from 'node:path';
import {
  type Baseline,
  type BaselineOptions,
  captureBaseline,
  type FileJournalStore,
  reconcile,
  saveBaseline,
} from './journal.js';

export interface RunReconciliationOptions {
  /** The run's journal store; the baseline lands beside its index. */
  store: FileJournalStore;
  /** Workspace root the lane writes into (the lane env's own cwd). */
  root: string;
  /**
   * Path-safe run id naming the baseline file. Session ids already satisfy
   * `[A-Za-z0-9_-]`; the pattern is re-checked here because this id is
   * joined into a path (defense-in-depth, same rule as `--session`).
   */
  runId: string;
  sessionId: string;
  agentId: string;
  /** Caller-declared out-of-scope paths (§35), excluded from both walks. */
  outOfScope?: string[];
  /** Clock seam for deterministic entry timestamps. */
  now?: () => number;
}

export interface RunReconciliation {
  /** The boot baseline: relative path → sha256, no content. */
  baseline: Baseline;
  /** Absolute path of the persisted baseline (beside the journal index). */
  baselinePath: string;
  /** End-of-run sweep; returns the number of entries appended. */
  sweep(): number;
}

// Same rule as `--session`/`--run` ids (host `SESSION_ID_PATTERN`): `exec`
// sits below `host` and may not import it, so the literal is repeated here
// with the rule it enforces rather than drifting silently.
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function beginReconciliation(
  options: RunReconciliationOptions,
): RunReconciliation {
  if (!RUN_ID_PATTERN.test(options.runId)) {
    throw new Error(
      `invalid run id ${JSON.stringify(options.runId)} (use [A-Za-z0-9_-])`,
    );
  }
  const dir = dirname(options.store.indexPath);
  const baselineOptions: BaselineOptions =
    options.outOfScope === undefined ? {} : { outOfScope: options.outOfScope };
  const baseline = captureBaseline(options.root, baselineOptions);
  saveBaseline(dir, options.runId, baseline);
  const now = options.now ?? Date.now;
  return {
    baseline,
    baselinePath: join(dir, `baseline-${options.runId}.json`),
    sweep: () =>
      reconcile(
        options.store,
        baseline,
        options.root,
        {
          sessionId: options.sessionId,
          agentId: options.agentId,
          timestamp: now(),
        },
        baselineOptions,
      ),
  };
}
