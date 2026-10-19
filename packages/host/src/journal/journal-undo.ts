// `kubic undo`: restores journaled changes, newest first, and reports each
// skipped step with its reason.

import type { ExitCode } from '@kubic/core/cli/exit-codes';
import { EXIT_FAILED, EXIT_OK } from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import { gitHeadOf } from '@kubic/exec/git-clean';
import { applyUndo, planUndo } from '@kubic/exec/journal';
import {
  appendToLedger,
  auditLedgerDirFor,
  undoRestoreAudit,
} from '../audit/index.js';
import type { JournalRun, JournalUndoOptions } from './journal-run.js';
import { lockHolderOf, sessionHolderOf } from './journal-run.js';

type SkipKind = 'stale' | 'already-undone' | 'non-reversible' | 'head-moved';

function skipKindOf(reason: string): SkipKind {
  if (reason.startsWith('stale:')) return 'stale';
  if (reason.startsWith('already undone:')) return 'already-undone';
  if (reason.startsWith('head-moved:')) return 'head-moved';
  return 'non-reversible';
}

function liveOtherSession(run: JournalRun): string | undefined {
  const { latestSessionId, otherSessionIds = [] } = run.resolved;
  if (latestSessionId === undefined) return undefined;
  for (const id of otherSessionIds) {
    const holder = sessionHolderOf(run.deps, id);
    if (holder !== undefined) {
      return `session ${id} for this workspace is attached by pid ${holder.pid} — the latest run is ambiguous while it writes; name the one to undo with --session <id>: ${[latestSessionId, ...otherSessionIds].join(', ')}`;
    }
  }
  return undefined;
}

export function journalUndo(
  run: JournalRun,
  request: JournalUndoOptions,
): ExitCode {
  const { deps, store, root, theme } = run;
  const dryRun = request.dryRun === true;
  // A live run on this session is writing the workspace this undo
  // would restore, and appending to the journal this undo reads — the two
  // interleave. Refused by name, before anything is planned or written;
  // `--force` is the documented override (the same knob the staleness refusal
  // uses), and a dead holder's residue never refuses.
  if (request.force !== true) {
    const holder = lockHolderOf(deps, run.resolved);
    if (holder !== undefined) {
      run.log.error(
        `session '${run.resolved.sessionId}' is attached by pid ${holder.pid} — refusing to undo under a live run (pass --force to override)`,
      );
      return EXIT_FAILED;
    }
  }
  // A bare undo undoes the latest run. While another session for this
  // workspace is live, "the latest run" is a moving target, so the user names
  // the one they mean.
  const ambiguity = liveOtherSession(run);
  if (ambiguity !== undefined) {
    run.log.error(ambiguity);
    return EXIT_FAILED;
  }
  const plan =
    store === undefined
      ? undefined
      : planUndo(
          store,
          {
            ...(request.path === undefined ? {} : { path: request.path }),
            ...(request.step === true ? { step: true } : {}),
          },
          root,
        );
  if (store === undefined || plan === undefined || plan.steps.length === 0) {
    deps.out(
      request.json === true
        ? formatJson({ ...run.ref, dryRun, restored: [], skipped: [] })
        : 'nothing to undo',
    );
    return EXIT_OK;
  }
  // --force overrides the staleness refusal per-invocation;
  // nothing persists it — the next undo re-checks by default.
  const result = applyUndo(store, plan, root, {
    dryRun,
    force: request.force === true,
  });
  // Every real restore lands one `undo-restore` row in the workspace's
  // own ledger: which session undid, what came back, what
  // stayed. A dry run restores nothing, so it records nothing. The base is
  // the restored workspace's own HEAD ('none' outside git); a failed
  // append surfaces on stderr and never fails the undo.
  if (!dryRun) {
    // The restored workspace's own HEAD (null outside git → 'none').
    // appendToLedger never throws (it reports through onError), so the
    // callback — not a try/catch — is what surfaces a failed append.
    const base = gitHeadOf(root)?.revision ?? 'none';
    appendToLedger(
      auditLedgerDirFor(root),
      undoRestoreAudit({
        sessionId: run.resolved.sessionId,
        workspace: root,
        base,
        restored: result.restored,
        skipped: result.skipped.length,
      }),
      (message) => {
        run.log.error(`audit: undo-restore not recorded: ${message}`);
      },
    );
  }
  // Stale refusals and already-undone skips get their own line shapes so
  // scripts (and humans) can tell "cannot reverse" from "refused because
  // the file changed since" from "a previous undo already unwound it".
  const kinds = result.skippedDetails.map((d) => skipKindOf(d.reason));
  // One JSON document (or the human report); the exit code is shared: 1
  // when a real run skipped anything (a partial undo is a
  // task outcome, so it keeps the generic failure code and never the
  // usage code; the structured `skipped` list is the machine-readable
  // half), a dry run always 0.
  const exit = !dryRun && result.skipped.length > 0 ? EXIT_FAILED : EXIT_OK;
  if (request.json === true) {
    deps.out(
      formatJson({
        ...run.ref,
        dryRun,
        restored: result.restored,
        warnings: result.warnings,
        skipped: result.skippedDetails.map((d, i) => ({
          path: d.path,
          kind: kinds[i],
          reason: d.reason,
        })),
      }),
    );
    return exit;
  }
  const staleCount = kinds.filter((k) => k === 'stale').length;
  const undoneCount = kinds.filter((k) => k === 'already-undone').length;
  // HEAD-move refusals are their own class — neither
  // unrecoverable (force proceeds) nor a content mismatch.
  const movedCount = kinds.filter((k) => k === 'head-moved').length;
  const classified = staleCount > 0 || undoneCount > 0 || movedCount > 0;
  const skipLabel = classified
    ? ` (${[staleCount > 0 ? `${staleCount} stale` : null, undoneCount > 0 ? `${undoneCount} already undone` : null, movedCount > 0 ? `${movedCount} head-moved` : null].filter((s) => s !== null).join(', ')})`
    : ' non-reversible';
  if (dryRun) {
    deps.out(
      `would restore ${result.restored.length} step(s)` +
        (result.skipped.length > 0
          ? `, skip ${result.skipped.length}${skipLabel}: ${result.skipped.join(', ')}`
          : ''),
    );
    return EXIT_OK;
  }
  for (const path of result.restored) {
    deps.out(`${theme.success('restored')} ${path}`);
  }
  for (const warning of result.warnings) run.log.warn(warning);
  result.skippedDetails.forEach((detail, i) => {
    const kind = kinds[i];
    deps.out(
      kind === 'stale'
        ? `${theme.warning('stale (skipped):')} ${detail.path} — ${detail.reason}`
        : kind === 'already-undone'
          ? `${theme.muted('already undone (skipped):')} ${detail.path}`
          : kind === 'head-moved'
            ? `${theme.warning('head-moved (skipped):')} ${detail.path} — ${detail.reason}`
            : `${theme.warning('non-reversible (skipped):')} ${detail.path}`,
    );
  });
  deps.out(
    classified
      ? `undo: ${result.restored.length} restored, ${result.skipped.length} skipped${skipLabel}`
      : `undo: ${result.restored.length} restored, ${result.skipped.length} non-reversible`,
  );
  return exit;
}
