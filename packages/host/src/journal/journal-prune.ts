// `kubic journal prune`: drops journal entries older than the keep window,
// a dry run unless confirmed.

import type { ExitCode } from '@kubic/core/cli/exit-codes';
import { EXIT_FAILED, EXIT_OK } from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type { JournalEntry } from '@kubic/exec/journal';
import { MS_PER_DAY } from '../config/index.js';
import { defaultSessionsRoot } from '../sessions/index.js';
import type { JournalPruneOptions, JournalRun } from './journal-run.js';
import { lockHolderOf } from './journal-run.js';

// `journal prune`: the explicit deleter of the store `log` reads. Entries
// older than the keep window go; a dry run lists them unless `yes`. The keep
// window comes from --keep-days or `journal.retentionDays` and is never
// invented. A session store under a live run is refused, as undo refuses it.
const PRUNE_WINDOW_ERROR =
  'journal prune needs a keep window: pass --keep-days <n> or set [journal] retentionDays in config (no default — deletion stays explicit)';

function pruneLine(entry: JournalEntry): string {
  const path = entry.op === 'marker' ? '(HEAD)' : entry.path;
  return `${new Date(entry.timestamp).toISOString()} ${entry.op} ${path}`;
}

// The keep window is whole, non-negative days. A flag is checked by commander's
// parser; a configured value is checked here, since the config parser does not
// refuse a fractional `retentionDays`.
export function isKeepDays(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// The refusal for a prune with no window. A config that did not load is named,
// so a broken `[journal]` key is not reported as a missing one.
function keepWindowRefusal(configError: string | undefined): string {
  if (configError === undefined) return PRUNE_WINDOW_ERROR;
  return `${PRUNE_WINDOW_ERROR}; the config did not load: ${redactSecretShapes(configError)}`;
}

export function journalPrune(
  run: JournalRun,
  request: JournalPruneOptions,
): ExitCode {
  const { deps, store, resolved } = run;
  const json = request.json === true;
  const yes = request.yes === true;
  // An explicit session must exist, as `kubic cost --session` requires: a
  // misspelt id is a refusal, never an empty prune that reads as success.
  if (
    request.session !== undefined &&
    resolved.sessionId !== undefined &&
    !createNodeFileBridge(deps.sessionsRoot ?? defaultSessionsRoot()).exists(
      resolved.sessionId,
    )
  ) {
    run.log.error(`unknown session: ${redactSecretShapes(resolved.sessionId)}`);
    return EXIT_FAILED;
  }
  // Then a live run: refused before the window is read, for every window and
  // on a dry run too.
  if (resolved.sessionId !== undefined) {
    const holder = lockHolderOf(deps, resolved);
    if (holder !== undefined) {
      run.log.error(
        `session '${resolved.sessionId}' is attached by pid ${holder.pid} — refusing to prune under a live run`,
      );
      return EXIT_FAILED;
    }
  }
  const keepDays = request.keepDays ?? deps.journalRetentionDays;
  if (keepDays === undefined) {
    run.log.error(keepWindowRefusal(deps.journalConfigError));
    return EXIT_FAILED;
  }
  if (keepDays === 0) {
    if (json) {
      deps.out(
        formatJson({
          ...run.ref,
          keepDays,
          dryRun: !yes,
          pruned: 0,
          candidates: [],
        }),
      );
    } else {
      deps.out('journal retention is off (keep-days 0) — nothing is pruned');
    }
    return EXIT_OK;
  }
  const now = deps.now?.() ?? Date.now();
  const maxAgeMs = keepDays * MS_PER_DAY;
  const candidates = [...store.entries()]
    .filter((entry) => now - entry.timestamp > maxAgeMs)
    .sort((a, b) => a.timestamp - b.timestamp);
  let pruned = 0;
  let reclaimed = 0;
  let exit: ExitCode = EXIT_OK;
  if (yes && candidates.length > 0) {
    // The store's own pass applies the same age bound, so it drops what the
    // dry run listed, unless the journal changed under it (a concurrent writer
    // or pruner). Its actual count is what gets reported. The pass also sweeps
    // the blob files no remaining entry references: those count in `reclaimed`
    // and the dry run does not list them. A pass that removed nothing is the
    // failure, because the request did not happen.
    const result = store.enforceRetention({ maxAgeMs, now });
    pruned = result.entries;
    reclaimed = result.bytes;
    if (pruned === 0) {
      run.log.error(
        'the journal changed while pruning and this run removed nothing — run it again to see what is left',
      );
      exit = EXIT_FAILED;
    }
  }
  if (json) {
    deps.out(
      formatJson({
        ...run.ref,
        keepDays,
        dryRun: !yes,
        pruned,
        candidates: candidates.map((entry) => ({
          timestamp: entry.timestamp,
          op: entry.op,
          path: entry.path,
        })),
      }),
    );
    return exit;
  }
  if (candidates.length === 0) {
    deps.out('nothing to prune');
    return exit;
  }
  const noun = candidates.length === 1 ? 'entry' : 'entries';
  if (!yes) {
    for (const entry of candidates) deps.out(`would prune ${pruneLine(entry)}`);
    deps.out(
      `dry run: ${candidates.length} ${noun} would be pruned (keep window ${keepDays} day(s)) — pass --yes to delete`,
    );
    return exit;
  }
  if (exit === EXIT_OK) {
    const prunedNoun = pruned === 1 ? 'entry' : 'entries';
    const listed =
      pruned === candidates.length
        ? ''
        : ` (${candidates.length} listed: the journal changed while pruning)`;
    deps.out(
      `pruned ${pruned} ${prunedNoun}, ${reclaimed}B reclaimed${listed}`,
    );
  }
  return exit;
}
