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
  journalRunStart,
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
  /**
   * Walk notices the operator should see (issue #107): a very large file being
   * hashed at boot, or a bridge that cannot read ranges so the bound is off.
   * The headless runner routes this to its debug channel.
   */
  onNotice?: (detail: string) => void;
  /** Clock seam for deterministic entry timestamps. */
  now?: () => number;
}

export interface RunReconciliation {
  /** The boot baseline: relative path → sha256, no content. */
  readonly baseline: Baseline;
  /** Absolute path of the persisted baseline (beside the journal index). */
  baselinePath: string;
  /** End-of-run sweep; returns the number of entries appended. */
  sweep(): number;
  /**
   * Issue #374 (§42.1): start a new interactive turn. The workspace as it is
   * NOW becomes the baseline and the journal position the run start, so the
   * next sweep journals only what changed during this turn — an edit the
   * operator made between prompts is absorbed here, never attributed to the
   * agent — and its entries carry `turn`. Re-persists the baseline file.
   */
  rebaseline(turn: number): void;
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
  const baselineOptions: BaselineOptions = {};
  if (options.outOfScope !== undefined) {
    baselineOptions.outOfScope = options.outOfScope;
  }
  if (options.onNotice !== undefined) {
    baselineOptions.onNotice = options.onNotice;
  }
  // Issue #341: the journal position at boot scopes the sweep's expected
  // state to entries this run appended — a resumed session shares the
  // journal with every earlier run.
  let runStart = journalRunStart(options.store);
  let baseline = captureBaseline(options.root, baselineOptions);
  saveBaseline(dir, options.runId, baseline);
  let turn: number | undefined;
  const now = options.now ?? Date.now;
  return {
    get baseline() {
      return baseline;
    },
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
          runStart,
          ...(turn === undefined ? {} : { turn }),
        },
        baselineOptions,
      ),
    rebaseline: (next: number) => {
      runStart = journalRunStart(options.store);
      baseline = captureBaseline(options.root, {
        ...baselineOptions,
        previous: baseline,
      });
      saveBaseline(dir, options.runId, baseline);
      turn = next;
    },
  };
}
