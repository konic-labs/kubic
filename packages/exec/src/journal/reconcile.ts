// Run-scoped reconciliation lifecycle.
//
// The mechanism itself lives in `baseline.ts` (`captureBaseline`,
// `saveBaseline`), `sweep.ts` (`reconcile`) and `git.ts` (`captureGitBaseline`).
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
import type { Baseline, BaselineOptions } from './baseline.js';
import { captureBaseline, journalRunStart, saveBaseline } from './baseline.js';
import { createBaselineCache } from './baseline-cache.js';
import {
  captureGitBaseline,
  captureHeadState,
  type GitBaseline,
  type HeadState,
  saveGitBaseline,
  saveHeadState,
} from './git.js';
import { sha256Hex } from './hash.js';
import type { FileJournalStore } from './store.js';
import { reconcile } from './sweep.js';

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
  /**
   * The other sessions that share this workspace. Without it the sweep
   * attributes every change it finds to this run.
   */
  peers?: ReconciliationPeers;
  /**
   * Where the workspace's baseline digest cache lives (one file per
   * workspace in it): a later run reuses the digests of unchanged files
   * instead of reading the whole tree again. Absent: the cache lasts this run.
   */
  baselineCacheDir?: string;
}

// The other sessions in the workspace, as the sweep needs them: what they
// journaled since a moment, and which of them are live now.
export interface ReconciliationPeers {
  /** Absolute paths other sessions journaled at or after `since` (ms). */
  journaledSince(since: number): ReadonlySet<string>;
  /** Ids of the other sessions live in this workspace now. */
  live(): readonly string[];
}

export interface RunReconciliation {
  /** The boot baseline: relative path → sha256, no content. */
  readonly baseline: Baseline;
  /**
   * Boot-time index blob OIDs for stat-clean tracked files
   * (null outside git repos: the sweep then records hash-only entries).
   * Re-captured with every rebaseline, so a new turn's pre-images
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

// Same rule as `--session`/`--run` ids (`SESSION_ID_PATTERN` in the agent session store): `exec`
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
  // One cache for the run's walks (boot, each turn, the sweep), seeded from
  // the workspace's file. Its clock is always the wall clock: the racy rule
  // compares file times, which the entry clock seam cannot fake.
  const cache = createBaselineCache(
    options.root,
    options.baselineCacheDir === undefined
      ? undefined
      : join(
          options.baselineCacheDir,
          `${sha256Hex(options.root).slice(0, 32)}.json`,
        ),
  );
  const cached = <T>(walk: () => T): T => {
    cache.begin(Date.now());
    const result = walk();
    cache.commit();
    return result;
  };
  const baselineOptions: BaselineOptions = { cache };
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
  let baseline = cached(() => captureBaseline(options.root, baselineOptions));
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
  // When this run's part began: another session's entry from then on is
  // that session's change, not this run's.
  let startedAt = now();
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
    sweep: () => {
      const foreign = options.peers?.journaledSince(startedAt);
      const contestedBy = options.peers?.live() ?? [];
      return cached(() =>
        reconcile(
          options.store,
          baseline,
          options.root,
          {
            sessionId: options.sessionId,
            timestamp: now(),
            runStart,
            ...(foreign === undefined || foreign.size === 0 ? {} : { foreign }),
            ...(contestedBy.length === 0 ? {} : { contestedBy }),
            ...(turn === undefined ? {} : { turn }),
          },
          sweepOptions(),
        ),
      );
    },
    rebaseline: (next: number) => {
      runStart = journalRunStart(options.store);
      startedAt = now();
      baseline = cached(() =>
        captureBaseline(options.root, {
          ...baselineOptions,
          previous: baseline,
        }),
      );
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
