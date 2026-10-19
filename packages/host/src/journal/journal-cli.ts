// `kubic diff / undo / log / status` and `kubic journal prune` commands.
// Thin over the exec journal core; presentation only. commander (the
// composition root, apps/kubic/src/commands/journal.ts) owns argv, help and
// parse errors and hands a typed `JournalRequest` here.
//
// Channels: the report (diff, undo verdicts, log table, status lines, or
// the one `--json` document) goes to `out`; diagnostics (the fallback
// session note, the empty-journal hint, undo warnings) go through the
// logger to `err` — so a `--json` run's stdout is pure JSON.
//
// Exit codes (docs/cli/exit-codes.md): 0 success (including empty diff and
// clean dry-run), 2 a usage error (thrown as CliUsageError: bad --session
// id, conflicting store selectors, bad --max-content-bytes), 1 an unknown
// --session, an `undo` that completed with skipped steps (the partial
// outcome has its own code and never reuses the usage one) or any IO
// failure (propagated to the root catch-all).

import { join } from 'node:path';
import type { CommandResult, ExitCode } from '@kubic/core/cli/exit-codes';
import {
  CliUsageError,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '@kubic/core/cli/exit-codes';
import type { CliLogger } from '@kubic/core/cli/logger';
import { createLineLogger } from '@kubic/core/cli/logger';
import { formatJson } from '@kubic/core/cli/output';
import { renderTable } from '@kubic/core/cli/table';
import type { CliTheme } from '@kubic/core/cli/theme';
import { createCliTheme } from '@kubic/core/cli/theme';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import {
  clipChangeContent,
  DEFAULT_MAX_CONTENT_BYTES,
  diffEntries,
  FileJournalStore,
  formatHeadMove,
  journalStatus,
  reconciliationSummary,
  renderDiff,
  renderDiffStat,
} from '@kubic/exec/journal';
import { MS_PER_DAY } from '../config/index.js';
import { defaultSessionsRoot } from '../sessions/index.js';
import { isKeepDays, journalPrune } from './journal-prune.js';
import type {
  JournalCommandDeps,
  JournalDiffOptions,
  JournalRequest,
  JournalRun,
  JournalSelection,
} from './journal-run.js';
import {
  lockHolderOf,
  resolveJournalDir,
  workspaceRefusal,
} from './journal-run.js';
import { journalUndo } from './journal-undo.js';

const PLAIN = createCliTheme('none');

function loggerFor(deps: JournalCommandDeps): CliLogger {
  return createLineLogger(deps.err ?? deps.out, {
    theme: deps.errTheme ?? PLAIN,
  });
}

// Whether `<sessionsRoot>/<id>` holds what a journal command reads: the
// session's storage (the rule attaching a session uses) or its journal.
function isRecordedSession(deps: JournalCommandDeps, id: string): boolean {
  const bridge = createNodeFileBridge(
    deps.sessionsRoot ?? defaultSessionsRoot(),
  );
  return (
    bridge.exists(join(id, 'main.jsonl')) ||
    bridge.exists(join(id, 'journal', 'index.jsonl'))
  );
}

// Session ids for a note: the first three, then a count.
function listedIds(ids: readonly string[]): string {
  const shown = ids.slice(0, 3).join(', ');
  return ids.length > 3 ? `${shown} (+${ids.length - 3} more)` : shown;
}

export async function runJournalCommand(
  request: JournalRequest,
  deps: JournalCommandDeps,
): Promise<CommandResult> {
  const root = deps.root ?? process.cwd();
  if (
    request.command === 'diff' &&
    request.maxContentBytes !== undefined &&
    !(Number.isInteger(request.maxContentBytes) && request.maxContentBytes >= 0)
  ) {
    throw new CliUsageError(
      '--max-content-bytes needs a non-negative integer (0 = unlimited)',
    );
  }
  if (request.command === 'prune') {
    const window = request.keepDays ?? deps.journalRetentionDays;
    if (window !== undefined && !isKeepDays(window)) {
      throw new CliUsageError(
        'keep window needs a non-negative integer of days (--keep-days or [journal] retentionDays)',
      );
    }
  }
  const resolved = await resolveJournalDir(deps, root, request.session);
  const json = request.json === true;
  const log = loggerFor(deps);
  // An explicit --session must name a session or its journal, as `kubic cost
  // --session` requires a session: a misspelt id is a refusal for every
  // journal command, never an empty diff or log that reads as success.
  if (
    request.session !== undefined &&
    resolved.sessionId !== undefined &&
    !isRecordedSession(deps, resolved.sessionId)
  ) {
    const id = redactSecretShapes(resolved.sessionId);
    const message = `unknown session: ${id}`;
    log.error(message);
    if (json) {
      deps.out(
        formatJson({
          ok: false,
          exitCode: EXIT_FAILED,
          session: id,
          root: null,
          error: { code: 'unknown_session', message },
        }),
      );
    }
    return { exitCode: EXIT_FAILED };
  }
  // A session store is named — with the workspace its
  // paths resolve against — before any subcommand output, so the
  // resolution is never silent. It is a diagnostic (stderr), and `--json`
  // stays silent there too: the document carries `session` and `root`.
  if (resolved.sessionId !== undefined && !json) {
    const where =
      resolved.workspace === undefined
        ? 'no recorded workspace'
        : `workspace ${resolved.workspace}`;
    const others = resolved.otherSessionIds ?? [];
    const also =
      others.length === 0
        ? ''
        : `; also here: ${listedIds(others)} — pass --session <id> to pick another`;
    log.info(
      resolved.latestSessionId !== undefined
        ? `session: ${resolved.sessionId} (latest session journal for this workspace${also}) — ${where}`
        : `session: ${resolved.sessionId} — ${where}`,
    );
  }
  // Undo writes and status reads the workspace, so both refuse
  // (exit 2, named) when a session's workspace is unknown or gone — its
  // relative paths must never land in the invocation cwd instead.
  if (
    resolved.sessionId !== undefined &&
    (request.command === 'undo' || request.command === 'status')
  ) {
    const refusal = workspaceRefusal(resolved.sessionId, resolved.workspace);
    if (refusal !== undefined) {
      log.error(refusal);
      return { exitCode: EXIT_USAGE };
    }
  }
  const run: JournalRun = {
    deps,
    root: resolved.workspace ?? root,
    ref: {
      session: resolved.sessionId ?? null,
      root: resolved.workspace ?? null,
    },
    resolved,
    store: new FileJournalStore(resolved.dir),
    theme: json ? PLAIN : (deps.theme ?? PLAIN),
    log,
  };
  switch (request.command) {
    case 'diff':
      return { exitCode: journalDiff(run, request) };
    case 'undo':
      return { exitCode: journalUndo(run, request) };
    case 'log':
      return { exitCode: journalLog(run, request) };
    case 'status':
      return { exitCode: journalStatusCommand(run, request) };
    case 'prune':
      return { exitCode: journalPrune(run, request) };
  }
}

// One rendered diff line, coloured by its role: file headers bold, hunk
// headers amber, removals red, additions green, attribution/markers muted.
// Context lines stay plain. The identity under the plain theme.
export function colorizeDiffLine(line: string, theme: CliTheme): string {
  if (line.startsWith('--- ') || line.startsWith('+++ ')) {
    return theme.bold(line);
  }
  if (line.startsWith('@@')) return theme.warning(line);
  if (line.startsWith('# ')) return theme.muted(line);
  if (line.startsWith('+')) return theme.success(line);
  if (line.startsWith('-')) return theme.accent(line);
  return line;
}

function journalDiff(run: JournalRun, request: JournalDiffOptions): ExitCode {
  const { deps, store } = run;
  const filter = {
    ...(request.path === undefined ? {} : { path: request.path }),
  };
  const changes = diffEntries(store, filter);
  if (request.json === true) {
    // One change's before/after can be a whole file: the envelope clips
    // each side at 64 KiB by default (marker line + `contentTruncated`),
    // and `--max-content-bytes 0` restores the unbounded form for
    // scripting. The bound applies to `--json` only — the human path
    // renders hunks, not whole files.
    const maxBytes = request.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
    deps.out(
      formatJson({
        ...run.ref,
        changes: changes.map((c) => clipChangeContent(c, maxBytes)),
      }),
    );
    return EXIT_OK;
  }
  if (changes.length === 0) {
    deps.out('no changes');
    // With no journal anywhere, name both places that were
    // looked at — the empty result is otherwise indistinguishable from
    // "ran and nothing changed". Only the bare default path hints (a
    // configured store or --session is a deliberate choice). "Nothing
    // anywhere" means the resolved store has no entries AND no session
    // journal exists to fall back to.
    const sessionsRoot = deps.sessionsRoot ?? defaultSessionsRoot();
    if (
      request.session === undefined &&
      deps.journalDir === undefined &&
      run.resolved.sessionId === undefined &&
      store.entries().length === 0
    ) {
      run.log.info(
        `no journal under ${run.resolved.dir} and none under the sessions root (${sessionsRoot}) — start a run or pass --session`,
      );
    }
    return EXIT_OK;
  }
  // `--stat` swaps the hunks for the per-file summary. The
  // lines print plain (no hunk roles to colour) so scripts can split on
  // spaces.
  if (request.stat === true) {
    for (const line of renderDiffStat(changes)) deps.out(line);
    return EXIT_OK;
  }
  for (const line of renderDiff(changes).split('\n')) {
    deps.out(colorizeDiffLine(line, run.theme));
  }
  return EXIT_OK;
}

const LOG_COLUMNS = [
  { header: 'TIME' },
  { header: 'TOOL CALL' },
  { header: 'OP' },
  { header: 'PATH' },
  { header: 'BYTES', align: 'right' },
  { header: 'NOTE' },
] as const;

function journalLog(run: JournalRun, request: JournalSelection): ExitCode {
  const { deps, store, resolved } = run;
  // With `session.retentionDays` set, a
  // SESSION journal drops entries older than the window as it is read —
  // the same age bound `kubic sessions prune` applies to whole session
  // dirs, enforced entry-wise through the store's retention pass (which
  // `append` already runs; the read path triggers it explicitly here).
  // Session-scoped by construction (`sessionId` is set only for a session
  // journal): the workspace journal keeps its own `journal.retentionDays`
  // append-time bound, and prune remains the only deleter of session
  // dirs. With retention unset — or 0 — no pass runs: the read path
  // writes nothing.
  const retentionDays = deps.retentionDays ?? 0;
  if (resolved.sessionId !== undefined && retentionDays > 0) {
    // Pruning under a live run is a race the reader cannot win —
    // the run appends between this pass's read and its rename, and the
    // rewrite drops the line (and sweeps blobs the run just wrote). The
    // session lock is the shipped liveness view (`kubic sessions prune` uses
    // the same one); a live holder skips the self-heal and says so.
    const holder = lockHolderOf(deps, resolved);
    if (holder !== undefined) {
      run.log.warn(
        `journal retention skipped: session '${resolved.sessionId}' is attached by pid ${holder.pid} — pruning under a live run can drop entries it just appended`,
      );
    } else {
      store.enforceRetention({ maxAgeMs: retentionDays * MS_PER_DAY });
    }
  }
  // Ordered by timestamp (session id, then path, break ties
  // deterministically).
  const entries = [...store.entries()].sort((a, b) =>
    a.timestamp !== b.timestamp
      ? a.timestamp - b.timestamp
      : a.sessionId !== b.sessionId
        ? a.sessionId < b.sessionId
          ? -1
          : 1
        : a.path < b.path
          ? -1
          : 1,
  );
  // `--json` stays the raw entries array (the count is derivable from the
  // `unattributed` flags there); the human path gains the summary line.
  if (request.json === true) {
    deps.out(formatJson({ ...run.ref, entries }));
    return EXIT_OK;
  }
  if (entries.length === 0) {
    deps.out('journal is empty');
  } else {
    // Markers are not file rows — the PATH column names HEAD
    // and the NOTE column names the move.
    const rows = entries.map((e) => [
      new Date(e.timestamp).toISOString(),
      e.toolCallId ?? 'none',
      e.op,
      e.op === 'marker' ? '(HEAD)' : e.path,
      `${e.bytesDelta >= 0 ? '+' : ''}${e.bytesDelta}B`,
      e.op === 'marker' && e.headFrom !== undefined && e.headTo !== undefined
        ? `reconciled head-moved ${formatHeadMove(e.headFrom, e.headTo)}`
        : e.unattributed === true
          ? 'reconciled'
          : '',
    ]);
    const table = renderTable(rows, LOG_COLUMNS, {
      fancy: deps.fancy === true,
      theme: run.theme,
    });
    for (const line of table.split('\n')) deps.out(line);
  }
  // The reconciliation count is part of `log`'s contract — it
  // is the only surface that answers "did anything bypass the tools?"
  // without the operator grepping for the `reconciled` marker. Printed
  // for an empty journal too, so scripts see a stable shape.
  deps.out(reconciliationSummary(store));
  return EXIT_OK;
}

function journalStatusCommand(
  run: JournalRun,
  request: JournalSelection,
): ExitCode {
  const { deps, theme } = run;
  const status = journalStatus(run.store, run.root);
  if (request.json === true) {
    deps.out(formatJson({ ...run.ref, ...status }));
    return EXIT_OK;
  }
  deps.out(
    `entries: ${status.entries} (reversible: ${status.reversible}, non-reversible: ${status.nonReversible})`,
  );
  // Unattributed entries are a subset of non-reversible ones;
  // naming the count keeps reconciliation visible in the summary, not
  // only in the per-entry `reconciled` marker.
  deps.out(
    `unattributed: ${status.unattributed} of ${status.entries} (reconciled at run end)`,
  );
  // Lost journal content is named on its own line ("0 is the
  // honest answer") so a corrupt store is visible at a glance.
  const corrupt = `corrupt: ${status.corrupt}`;
  deps.out(status.corrupt > 0 ? theme.error(corrupt) : corrupt);
  // Index lines dropped because they do not parse — a torn tail
  // from a crash or a full disk. Named separately from `corrupt`: that
  // counts lost content, this counts unreadable lines, and an operator
  // cannot infer one from the other.
  const corruptLines = `corrupt index lines: ${status.corruptLines}`;
  deps.out(status.corruptLines > 0 ? theme.error(corruptLines) : corruptLines);
  // A HEAD move mid-run changes what every earlier entry
  // means — one warning line per move, never folded into the counts above.
  for (const move of status.headMoves) {
    deps.out(
      theme.warning(
        `head-moved: ${formatHeadMove(move.from, move.to)} — undo needs --force to restore entries from before the move`,
      ),
    );
  }
  if (status.repo === null) {
    deps.out('repo: non-repo directory (journal works without git)');
  } else {
    const dirty =
      status.repo.dirty === null ? 'unknown' : status.repo.dirty ? 'yes' : 'no';
    // The repo line carries the root, ahead/behind and
    // conflicts alongside branch and dirty — each part omitted when
    // unknown, so repos without an upstream read as before.
    const parts = [
      `branch ${status.repo.branch}`,
      `dirty: ${dirty === 'yes' ? theme.warning(dirty) : dirty}`,
    ];
    if (status.repo.repoRoot !== null) {
      parts.push(`root ${status.repo.repoRoot}`);
    }
    if (status.repo.ahead !== null && status.repo.behind !== null) {
      parts.push(`ahead ${status.repo.ahead}, behind ${status.repo.behind}`);
    }
    if (status.repo.conflicts.length > 0) {
      parts.push(`conflicts: ${status.repo.conflicts.join(', ')}`);
    }
    deps.out(`repo: ${parts.join(', ')}`);
  }
  return EXIT_OK;
}
