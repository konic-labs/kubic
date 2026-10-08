// Run-scoped reconciliation lifecycle.
//
// The mechanism itself lives in `journal.ts` (`captureBaseline` /
// `saveBaseline` / `reconcile`) and `journal-git.ts` (`captureGitBaseline`).
// The TUI and headless composition roots run this lifecycle, so non-tool
// effects (`sed -i`, `npm install`, a formatter, a build) reach the journal as
// `unattributed: true` entries. The lifecycle is one object per run:
//
//   beginReconciliation(...)  → capture the boot baseline, persist
//                               it beside the session journal, hand back
//   run.sweep()               → one end-of-run tree comparison, appending
//                               an unattributed entry per moved path
//
// Before-content for reconciliation finds comes from the git object store when
// the path was clean against the index at boot (`captureGitBaseline` records
// its blob OID, the sweep reads it back through the existing before-blob
// mechanism) — otherwise the baseline holds hashes, not copies, so those
// entries carry `beforeHash` and no blob: `kubic undo` reports them
// non-reversible rather than guessing.
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
import {
  captureGitBaseline,
  captureHeadState,
  type GitBaseline,
  type HeadState,
  saveGitBaseline,
  saveHeadState,
} from './journal-git.js';

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
  /** Caller-declared out-of-scope paths, excluded from both walks. */
  outOfScope?: string[];
  /**
   * Walk notices the operator should see: a very large file being
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
  /**
   * Boot-time index blob OIDs for stat-clean tracked files
   * (null outside git repos — the sweep then records today's hash-only
   * shape). Re-captured with every rebaseline, so a new turn's pre-images
   * are the workspace as it is now, never a stale index.
   */
  readonly gitBaseline: GitBaseline | null;
  /**
   * HEAD state at boot (null outside git repos or when HEAD
   * does not resolve — the sweep then emits no marker). Re-captured with
   * every rebaseline, so a new turn absorbs an operator's checkout instead
   * of attributing it to the agent.
   */
  readonly headBaseline: HeadState | null;
  /** Absolute path of the persisted baseline (beside the journal index). */
  baselinePath: string;
  /** End-of-run sweep; returns the number of entries appended. */
  sweep(): number;
  /**
   * Start a new interactive turn. The workspace as it is
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
  // The journal position at boot scopes the sweep's expected
  // state to entries this run appended — a resumed session shares the
  // journal with every earlier run.
  let runStart = journalRunStart(options.store);
  let baseline = captureBaseline(options.root, baselineOptions);
  saveBaseline(dir, options.runId, baseline);
  // Index blob OIDs for the files clean at boot — the sweep's
  // pre-images for bash-made changes. Fail-open (null outside git repos),
  // and persisted beside the baseline so a later reader can see what the
  // sweep could restore.
  let gitBaseline = captureGitBaseline(options.root, baseline);
  if (gitBaseline !== null) saveGitBaseline(dir, options.runId, gitBaseline);
  // HEAD at boot — the sweep's comparison point for the
  // head-moved marker. Fail-open like the OID capture.
  let headBaseline = captureHeadState(options.root);
  if (headBaseline !== null) saveHeadState(dir, options.runId, headBaseline);
  let turn: number | undefined;
  const now = options.now ?? Date.now;
  const sweepOptions = (): BaselineOptions => ({
    ...baselineOptions,
    ...(gitBaseline === null ? {} : { gitBaseline }),
    ...(headBaseline === null ? {} : { headBaseline }),
  });
  return {
    get baseline() {
      return baseline;
    },
    get gitBaseline() {
      return gitBaseline;
    },
    get headBaseline() {
      return headBaseline;
    },
    baselinePath: join(dir, `baseline-${options.runId}.json`),
    sweep: () =>
      reconcile(
        options.store,
        baseline,
        options.root,
        {
          sessionId: options.sessionId,
          timestamp: now(),
          runStart,
          ...(turn === undefined ? {} : { turn }),
        },
        sweepOptions(),
      ),
    rebaseline: (next: number) => {
      runStart = journalRunStart(options.store);
      baseline = captureBaseline(options.root, {
        ...baselineOptions,
        previous: baseline,
      });
      saveBaseline(dir, options.runId, baseline);
      gitBaseline = captureGitBaseline(options.root, baseline);
      if (gitBaseline !== null)
        saveGitBaseline(dir, options.runId, gitBaseline);
      headBaseline = captureHeadState(options.root);
      if (headBaseline !== null)
        saveHeadState(dir, options.runId, headBaseline);
      turn = next;
    },
  };
}
