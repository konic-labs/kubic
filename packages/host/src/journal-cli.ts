// `kubic diff / undo / log / status` commands (issue #18; §42.2, §78).
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
// id, conflicting store selectors, bad --max-content-bytes), 1 an `undo`
// that completed with skipped steps (issue #372 — the partial outcome has
// its own code and never reuses the usage one) or any IO failure
// (propagated to the root catch-all).

import { basename, dirname, join, sep } from 'node:path';
import {
  CliUsageError,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
} from '../../core/src/cli/exit-codes.js';
import { type CliLogger, createLineLogger } from '../../core/src/cli/logger.js';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import {
  clipChangeContent,
  DEFAULT_MAX_CONTENT_BYTES,
  diffEntries,
  renderDiff,
} from '../../exec/src/journal-diff.js';
import {
  journalStatus,
  reconciliationSummary,
} from '../../exec/src/journal-status.js';
import { applyUndo, planUndo } from '../../exec/src/journal-undo.js';
import {
  listSessions,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { MS_PER_DAY } from './config/runtime.js';
import { SESSION_ID_PATTERN } from './run-cli.js';
import { defaultSessionsRoot } from './sessions-cli.js';

export interface JournalCommandDeps {
  journalDir?: string;
  sessionsRoot?: string;
  root?: string;
  // `session.retentionDays` (issue #119): the read-time self-heal window for
  // SESSION journals. Undefined — or 0 — means retention is off, and the
  // read path writes nothing. The workspace journal is never governed by
  // this key: `journal.retentionDays` bounds it on append.
  retentionDays?: number;
  // stdout: the report or the one `--json` document.
  out: (line: string) => void;
  // stderr: logger diagnostics. Absent means `out` (single-channel callers).
  err?: (line: string) => void;
  // Colours for the report (diff hunks, undo verdicts, status). Default:
  // none. Never applied to `--json`.
  theme?: CliTheme;
  // Colours for the logger's level prefixes. Default: none.
  errTheme?: CliTheme;
  // Box-drawn `log` table (an interactive, coloured terminal). Default:
  // plain aligned columns.
  fancy?: boolean;
  // Issue #362: session id → recorded workspace (the cwd the session was
  // created in). Default: the local session store's own listing.
  sessionWorkspaces?: (sessionsRoot: string) => Promise<Map<string, string>>;
}

// The store selector every journal command shares.
export interface JournalSelection {
  // `<id>` or the `journal:<id>` ref `kubic run` prints.
  session?: string | undefined;
  json?: boolean | undefined;
}

export interface JournalDiffOptions extends JournalSelection {
  path?: string | undefined;
  agent?: string | undefined;
  // The `--json` per-side content bound in bytes; 0 = unlimited.
  maxContentBytes?: number | undefined;
}

export interface JournalUndoOptions extends JournalSelection {
  // The undo scope (the positional operand), never the --session value.
  path?: string | undefined;
  step?: boolean | undefined;
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
}

export type JournalRequest =
  | ({ command: 'diff' } & JournalDiffOptions)
  | ({ command: 'undo' } & JournalUndoOptions)
  | ({ command: 'log' } & JournalSelection)
  | ({ command: 'status' } & JournalSelection);

export function defaultJournalDir(root: string): string {
  return join(root, '.kubic', 'journal');
}

// Session ids are path segments under the sessions root: the shared
// run-cli SESSION_ID_PATTERN ([A-Za-z0-9_-]) is checked before any path
// join, so the join below is contained by construction (#17
// resolve/relative guard). Imported (not copied) so the rule cannot drift.

// The `journal:<id>` ref `kubic run` prints; accepted verbatim as the
// --session value so the printed token needs no extra lookup.
const JOURNAL_REF_PREFIX = 'journal:';

// A store "has a journal" once its index exists — an absent index means
// nothing has ever been appended there (the dead default this fallback
// exists for).
function hasJournalIndex(dir: string): boolean {
  return createNodeFileBridge(dir).exists('index.jsonl');
}

// Issue #362: the session store's recorded cwd per session id. An
// unlistable store (no sessions root yet, a torn transcript) is "nothing
// recorded" — never a throw, never a guess.
async function defaultSessionWorkspaces(
  sessionsRoot: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const listed = await listSessions(
      openSessionStore(sessionsRoot, createNodeFileBridge(sessionsRoot)),
      BACKGROUND_CONTEXT,
    );
    for (const entry of listed) {
      // The session's workspace, as the durable model defines it (issue
      // #392): a declared `workspace`, else the recorded `cwd` — the same
      // rule `sessionsTouchingWorkspace` and doctor's overlap probe use, so
      // a session created in a subdirectory associates with its repo. A
      // session that recorded neither — a 0.87 transcript, a hand-made dir
      // — stays unassociated rather than guessing one.
      const workspace = entry.meta?.workspace ?? entry.meta?.cwd;
      if (workspace !== undefined && workspace !== '') {
        out.set(entry.id, workspace);
      }
    }
  } catch {
    // No readable sessions root — no recorded workspaces.
  }
  return out;
}

// Canonical form for the workspace comparison (symlinks resolved, e.g.
// macOS /var → /private/var). A path that no longer exists keeps its
// lexical form — it can then only match itself.
function canonical(path: string): string {
  try {
    return createNodeFileBridge('/').realPath?.(path) ?? path;
  } catch {
    return path;
  }
}

// True when `root` is the recorded workspace or inside it: `kubic diff`
// from a project's subdirectory still belongs to that project.
function workspaceContains(recorded: string, root: string): boolean {
  const r = canonical(recorded);
  const c = canonical(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

// The most recent run journal under the sessions root (issue #125): one
// level of session ids (the shared SESSION_ID_PATTERN, checked before any
// path join — contained by construction, same rule as --session), newest
// `journal/index.jsonl` mtime wins among the sessions `accept` admits
// (issue #362: only those recorded for the current workspace). A session
// whose journal index cannot be statted is skipped (no journal there); a
// missing sessions root is simply "nothing here" (fresh machine), never a
// throw.
function latestSessionJournal(
  sessionsRoot: string,
  accept: (id: string) => boolean,
): string | undefined {
  const bridge = createNodeFileBridge(sessionsRoot);
  let best: { dir: string; mtime: number } | undefined;
  try {
    for (const info of bridge.listDir('.')) {
      if (!info.isDirectory || !SESSION_ID_PATTERN.test(info.name)) continue;
      if (!accept(info.name)) continue;
      const idx = join(info.name, 'journal', 'index.jsonl');
      try {
        const mtime = bridge.fileInfo(idx).mtimeMs;
        if (best === undefined || mtime > best.mtime) {
          best = { dir: join(sessionsRoot, info.name, 'journal'), mtime };
        }
      } catch {
        // Session without a journal — skip it.
      }
    }
  } catch {
    // No sessions root yet — nothing to fall back to.
  }
  return best?.dir;
}

interface ResolvedStore {
  dir: string;
  // Set exactly when the resolved store is a session journal (explicit
  // --session or the latest-session fallback) — the read-time self-heal
  // keys off it, so a pinned/workspace store can never be pruned by
  // `session.retentionDays`.
  sessionId?: string;
  latestSessionId?: string;
  // Issue #362: the workspace the store's relative paths resolve against.
  // A session store takes the session's recorded cwd; undefined means the
  // session recorded none (undo/status then refuse by name).
  workspace?: string;
}

// Throws CliUsageError for a bad or conflicting --session (exit 2).
async function resolveJournalDir(
  deps: JournalCommandDeps,
  root: string,
  session: string | undefined,
): Promise<ResolvedStore> {
  const workspacesOf = deps.sessionWorkspaces ?? defaultSessionWorkspaces;
  if (session === undefined) {
    const dir = deps.journalDir ?? defaultJournalDir(root);
    // Issue #125: the bare default is a store nothing writes (runs journal
    // under `<sessionsRoot>/<id>/journal`), so with no index here fall back
    // to the latest session journal. Only the CLI's bare default falls
    // back: a configured journal dir pins the store (one store per
    // invocation, fail-closed — the same rule as the --session conflict
    // below), and keeping the scan off that path keeps pinned-store tests
    // hermetic (no walk of the real sessions root).
    // Issue #362: only sessions recorded for THIS workspace are
    // candidates — another project's newer journal is never picked, and
    // its relative paths never resolve against this cwd.
    if (deps.journalDir === undefined && !hasJournalIndex(dir)) {
      const sessionsRoot = deps.sessionsRoot ?? defaultSessionsRoot();
      const workspaces = await workspacesOf(sessionsRoot);
      const fallback = latestSessionJournal(sessionsRoot, (id) => {
        const recorded = workspaces.get(id);
        return recorded !== undefined && workspaceContains(recorded, root);
      });
      if (fallback !== undefined) {
        const id = basename(dirname(fallback));
        return {
          dir: fallback,
          sessionId: id,
          latestSessionId: id,
          workspace: workspaces.get(id) as string,
        };
      }
    }
    return { dir, workspace: root };
  }
  const id = session.startsWith(JOURNAL_REF_PREFIX)
    ? session.slice(JOURNAL_REF_PREFIX.length)
    : session;
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new CliUsageError(
      `invalid --session id ${JSON.stringify(session)} (use [A-Za-z0-9_-] or journal:<id>)`,
    );
  }
  if (deps.journalDir !== undefined) {
    // Explicit precedence, fail-closed: a programmatic journalDir plus an
    // operator --session is ambiguous — refuse rather than silently
    // ignoring one side.
    throw new CliUsageError(
      `--session ${JSON.stringify(session)} conflicts with a configured journal dir (use one store per invocation)`,
    );
  }
  const sessionsRoot = deps.sessionsRoot ?? defaultSessionsRoot();
  // Issue #362: an explicit session operates on its OWN recorded
  // workspace, whatever the invocation cwd (`--session` works from any
  // cwd, and restores land where the session wrote).
  const workspace = (await workspacesOf(sessionsRoot)).get(id);
  return {
    dir: join(sessionsRoot, id, 'journal'),
    sessionId: id,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

// Everything one invocation shares after the store is resolved.
interface JournalRun {
  readonly deps: JournalCommandDeps;
  // The workspace root the store's paths resolve against (issue #362) —
  // the invocation cwd only for a workspace store.
  readonly root: string;
  // The resolved session id and root, as `--json` reports them.
  readonly ref: { session: string | null; root: string | null };
  readonly resolved: ResolvedStore;
  readonly store: FileJournalStore;
  readonly theme: CliTheme;
  readonly log: CliLogger;
}

const PLAIN = createCliTheme('none');

function loggerFor(deps: JournalCommandDeps): CliLogger {
  return createLineLogger(deps.err ?? deps.out, {
    theme: deps.errTheme ?? PLAIN,
  });
}

export async function runJournalCommand(
  request: JournalRequest,
  deps: JournalCommandDeps,
): Promise<number> {
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
  const resolved = await resolveJournalDir(deps, root, request.session);
  const json = request.json === true;
  const log = loggerFor(deps);
  // Issue #125/#362: a session store is named — with the workspace its
  // paths resolve against — before any subcommand output, so the
  // resolution is never silent. It is a diagnostic (stderr), and `--json`
  // stays silent there too: the document carries `session` and `root`.
  if (resolved.sessionId !== undefined && !json) {
    const where =
      resolved.workspace === undefined
        ? 'no recorded workspace'
        : `workspace ${resolved.workspace}`;
    log.info(
      resolved.latestSessionId !== undefined
        ? `session: ${resolved.sessionId} (latest session journal for this workspace) — ${where}`
        : `session: ${resolved.sessionId} — ${where}`,
    );
  }
  // Issue #362: undo writes and status reads the workspace, so both refuse
  // (exit 2, named) when a session's workspace is unknown or gone — its
  // relative paths must never land in the invocation cwd instead.
  if (
    resolved.sessionId !== undefined &&
    (request.command === 'undo' || request.command === 'status')
  ) {
    const refusal = workspaceRefusal(resolved.sessionId, resolved.workspace);
    if (refusal !== undefined) {
      log.error(refusal);
      return EXIT_USAGE;
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
      return journalDiff(run, request);
    case 'undo':
      return journalUndo(run, request);
    case 'log':
      return journalLog(run, request);
    case 'status':
      return journalStatusCommand(run, request);
  }
}

function workspaceRefusal(
  sessionId: string,
  workspace: string | undefined,
): string | undefined {
  if (workspace === undefined) {
    return `session ${sessionId}: no recorded workspace — refusing to resolve its paths against the current directory`;
  }
  if (!createNodeFileBridge('/').exists(workspace)) {
    return `session ${sessionId}: recorded workspace ${workspace} no longer exists — refusing to resolve its paths elsewhere`;
  }
  return undefined;
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

function journalDiff(run: JournalRun, request: JournalDiffOptions): number {
  const { deps, store } = run;
  const changes = diffEntries(store, {
    ...(request.path === undefined ? {} : { path: request.path }),
    ...(request.agent === undefined ? {} : { agent: request.agent }),
  });
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
    // Issue #125: with no journal anywhere, name both places that were
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
  for (const line of renderDiff(changes).split('\n')) {
    deps.out(colorizeDiffLine(line, run.theme));
  }
  return EXIT_OK;
}

type SkipKind = 'stale' | 'already-undone' | 'non-reversible';

function skipKindOf(reason: string): SkipKind {
  if (reason.startsWith('stale:')) return 'stale';
  if (reason.startsWith('already undone:')) return 'already-undone';
  return 'non-reversible';
}

function journalUndo(run: JournalRun, request: JournalUndoOptions): number {
  const { deps, store, root, theme } = run;
  const dryRun = request.dryRun === true;
  const plan = planUndo(
    store,
    {
      ...(request.path === undefined ? {} : { path: request.path }),
      ...(request.step === true ? { step: true } : {}),
    },
    root,
  );
  if (plan.steps.length === 0) {
    deps.out(
      request.json === true
        ? formatJson({ ...run.ref, dryRun, restored: [], skipped: [] })
        : 'nothing to undo',
    );
    return EXIT_OK;
  }
  // Issue #108: --force overrides the staleness refusal per-invocation;
  // nothing persists it — the next undo re-checks by default.
  const result = applyUndo(store, plan, root, {
    dryRun,
    force: request.force === true,
  });
  // Stale refusals and already-undone skips get their own line shapes so
  // scripts (and humans) can tell "cannot reverse" from "refused because
  // the file changed since" from "a previous undo already unwound it".
  const kinds = result.skippedDetails.map((d) => skipKindOf(d.reason));
  // One JSON document (or the human report); the exit code is shared: 1
  // when a real run skipped anything (issue #372 — a partial undo is a
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
  const classified = staleCount > 0 || undoneCount > 0;
  const skipLabel = classified
    ? ` (${[staleCount > 0 ? `${staleCount} stale` : null, undoneCount > 0 ? `${undoneCount} already undone` : null].filter((s) => s !== null).join(', ')})`
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

const LOG_COLUMNS = [
  { header: 'TIME' },
  { header: 'AGENT' },
  { header: 'TOOL CALL' },
  { header: 'OP' },
  { header: 'PATH' },
  { header: 'BYTES', align: 'right' },
  { header: 'NOTE' },
] as const;

function journalLog(run: JournalRun, request: JournalSelection): number {
  const { deps, store, resolved } = run;
  // Issue #119 (read-time self-heal): with `session.retentionDays` set, a
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
    store.enforceRetention({ maxAgeMs: retentionDays * MS_PER_DAY });
  }
  const entries = store.entries();
  // `--json` stays the raw entries array (the count is derivable from the
  // `unattributed` flags there); the human path gains the summary line.
  if (request.json === true) {
    deps.out(formatJson({ ...run.ref, entries }));
    return EXIT_OK;
  }
  if (entries.length === 0) {
    deps.out('journal is empty');
  } else {
    const rows = entries.map((e) => [
      new Date(e.timestamp).toISOString(),
      e.agentId,
      e.toolCallId ?? 'none',
      e.op,
      e.path,
      `${e.bytesDelta >= 0 ? '+' : ''}${e.bytesDelta}B`,
      e.unattributed === true ? 'reconciled' : '',
    ]);
    const table = renderTable(rows, LOG_COLUMNS, {
      fancy: deps.fancy === true,
      theme: run.theme,
    });
    for (const line of table.split('\n')) deps.out(line);
  }
  // Issue #87: the reconciliation count is part of `log`'s contract — it
  // is the only surface that answers "did anything bypass the tools?"
  // without the operator grepping for the `reconciled` marker. Printed
  // for an empty journal too, so scripts see a stable shape.
  deps.out(reconciliationSummary(store));
  return EXIT_OK;
}

function journalStatusCommand(
  run: JournalRun,
  request: JournalSelection,
): number {
  const { deps, theme } = run;
  const status = journalStatus(run.store, run.root);
  if (request.json === true) {
    deps.out(formatJson({ ...run.ref, ...status }));
    return EXIT_OK;
  }
  deps.out(
    `entries: ${status.entries} (reversible: ${status.reversible}, non-reversible: ${status.nonReversible})`,
  );
  // Issue #87: unattributed entries are a subset of non-reversible ones;
  // naming the count keeps reconciliation visible in the summary, not
  // only in the per-entry `reconciled` marker.
  deps.out(
    `unattributed: ${status.unattributed} of ${status.entries} (reconciled at run end)`,
  );
  // Issue #111: lost journal content is named on its own line ("0 is the
  // honest answer") so a corrupt store is visible at a glance.
  const corrupt = `corrupt: ${status.corrupt}`;
  deps.out(status.corrupt > 0 ? theme.error(corrupt) : corrupt);
  if (status.repo === null) {
    deps.out('repo: non-repo directory (journal works without git)');
  } else {
    const dirty =
      status.repo.dirty === null ? 'unknown' : status.repo.dirty ? 'yes' : 'no';
    deps.out(
      `repo: branch ${status.repo.branch}, dirty: ${
        dirty === 'yes' ? theme.warning(dirty) : dirty
      }`,
    );
  }
  return EXIT_OK;
}
