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
// id, conflicting store selectors, bad --max-content-bytes), 1 an `undo`
// that completed with skipped steps (the partial outcome has
// its own code and never reuses the usage one) or any IO failure
// (propagated to the root catch-all).

import { basename, dirname, join, sep } from 'node:path';
import {
  CliUsageError,
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type ExitCode,
} from '../../core/src/cli/exit-codes.js';
import { type CliLogger, createLineLogger } from '../../core/src/cli/logger.js';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';
import { redactSecretShapes } from '../../core/src/secret-shapes.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { gitHeadOf } from '../../exec/src/git-clean.js';
import { FileJournalStore, type JournalEntry } from '../../exec/src/journal.js';
import {
  clipChangeContent,
  DEFAULT_MAX_CONTENT_BYTES,
  diffEntries,
  renderDiff,
  renderDiffStat,
} from '../../exec/src/journal-diff.js';
import {
  formatHeadMove,
  journalStatus,
  reconciliationSummary,
} from '../../exec/src/journal-status.js';
import { applyUndo, planUndo } from '../../exec/src/journal-undo.js';
import {
  listSessions,
  openSessionStore,
  sessionLockIsLive,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { MS_PER_DAY } from './config/runtime.js';
import {
  appendToLedger,
  auditLedgerDirFor,
  undoRestoreAudit,
} from './policy/audit-ledger.js';
import { SESSION_ID_PATTERN } from './run-cli.js';
import { defaultSessionsRoot } from './sessions-cli.js';

export interface JournalCommandDeps {
  journalDir?: string;
  sessionsRoot?: string;
  root?: string;
  // `session.retentionDays`: the read-time self-heal window for
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
  // Kit `log` table (an interactive, coloured terminal). Default:
  // plain aligned columns.
  fancy?: boolean;
  // Session id → recorded workspace (the cwd the session was
  // created in). Default: the local session store's own listing.
  sessionWorkspaces?: (sessionsRoot: string) => Promise<Map<string, string>>;
  // The live holder of a session's lock, by session directory.
  // Default: the session store's own liveness probe (`sessionLockIsLive`,
  // pid-based). Injected by tests so a live holder is expressible without a
  // second process.
  sessionLockHolder?: (sessionDir: string) => { pid: number } | undefined;
  // `journal.retentionDays`, resolved by the runtime load (the env override
  // included): the default keep window for `journal prune`. Undefined means
  // nothing sets it, and prune then demands --keep-days.
  journalRetentionDays?: number;
  // The config load's refusal reason, when there is one. A prune that has no
  // window names it, so a broken `[journal]` key is not reported as missing.
  journalConfigError?: string;
  // Clock seam for boundary-exact age tests; real runs use Date.now().
  now?: () => number;
}

// The store selector every journal command shares.
interface JournalSelection {
  // `<id>` or the `journal:<id>` ref `kubic run` prints.
  session?: string | undefined;
  json?: boolean | undefined;
}

interface JournalDiffOptions extends JournalSelection {
  path?: string | undefined;
  // `--stat` prints the per-file summary (path, added/removed
  // counts, tool, turn) instead of hunks. Human render only — `--json`
  // already carries the fields, so `--json` ignores it.
  stat?: boolean | undefined;
  // The `--json` per-side content bound in bytes; 0 = unlimited.
  maxContentBytes?: number | undefined;
}

interface JournalUndoOptions extends JournalSelection {
  // The undo scope (the positional operand), never the --session value.
  path?: string | undefined;
  step?: boolean | undefined;
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
}

// `journal prune`: entries older than the keep window leave the store that
// `log` reads. A dry run unless `yes`.
interface JournalPruneOptions extends JournalSelection {
  // The keep window in days (`--keep-days`); undefined falls back to
  // `journal.retentionDays`. 0 means retention is off.
  keepDays?: number | undefined;
  // Delete the candidates (`--yes`); without it the command only lists them.
  yes?: boolean | undefined;
}

export type JournalRequest =
  | ({ command: 'diff' } & JournalDiffOptions)
  | ({ command: 'undo' } & JournalUndoOptions)
  | ({ command: 'log' } & JournalSelection)
  | ({ command: 'status' } & JournalSelection)
  | ({ command: 'prune' } & JournalPruneOptions);

function defaultJournalDir(root: string): string {
  return join(root, '.kubic', 'journal');
}

// Session ids are path segments under the sessions root: the shared run-cli
// SESSION_ID_PATTERN ([A-Za-z0-9_-]) is checked before any path join, so the
// join below is contained by construction. Imported (not copied) so the rule
// cannot drift.

// The `journal:<id>` ref `kubic run` prints; accepted verbatim as the
// --session value so the printed token needs no extra lookup.
const JOURNAL_REF_PREFIX = 'journal:';

// A store "has a journal" once its index exists — an absent index means
// nothing has ever been appended there (the dead default this fallback
// exists for).
function hasJournalIndex(dir: string): boolean {
  return createNodeFileBridge(dir).exists('index.jsonl');
}

// The session store's recorded cwd per session id. An
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
      // The session's workspace, as the durable model defines it: a declared
      // `workspace`, else the recorded `cwd` — the same rule
      // `sessionsTouchingWorkspace` and doctor's overlap probe use, so a
      // session created in a subdirectory associates with its repo. A session
      // that recorded neither — a legacy transcript, a hand-made dir — stays
      // unassociated rather than guessing one.
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

// The most recent run journal under the sessions root: one
// level of session ids (the shared SESSION_ID_PATTERN, checked before any
// path join — contained by construction, same rule as --session), newest
// `journal/index.jsonl` mtime wins among the sessions `accept` admits
// (only those recorded for the current workspace). A session
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
  // The workspace the store's relative paths resolve against.
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
    // The bare default is a store nothing writes (runs journal
    // under `<sessionsRoot>/<id>/journal`), so with no index here fall back
    // to the latest session journal. Only the CLI's bare default falls
    // back: a configured journal dir pins the store (one store per
    // invocation, fail-closed — the same rule as the --session conflict
    // below), and keeping the scan off that path keeps pinned-store tests
    // hermetic (no walk of the real sessions root).
    // Only sessions recorded for THIS workspace are
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
  // An explicit session operates on its OWN recorded
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
  // The workspace root the store's paths resolve against —
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

// The live holder of the store's session lock, when the resolved
// store is a session journal. `resolved.dir` is `<sessionsRoot>/<id>/journal`,
// so the session directory — and the `lock.json` the store's own runs hold —
// is one level up. The workspace journal has no session to check.
function lockHolderOf(
  deps: JournalCommandDeps,
  resolved: ResolvedStore,
): { pid: number } | undefined {
  if (resolved.sessionId === undefined) return undefined;
  const probe = deps.sessionLockHolder ?? sessionLockIsLive;
  return probe(dirname(resolved.dir));
}

function loggerFor(deps: JournalCommandDeps): CliLogger {
  return createLineLogger(deps.err ?? deps.out, {
    theme: deps.errTheme ?? PLAIN,
  });
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
  // A session store is named — with the workspace its
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

type SkipKind = 'stale' | 'already-undone' | 'non-reversible' | 'head-moved';

function skipKindOf(reason: string): SkipKind {
  if (reason.startsWith('stale:')) return 'stale';
  if (reason.startsWith('already undone:')) return 'already-undone';
  if (reason.startsWith('head-moved:')) return 'head-moved';
  return 'non-reversible';
}

function journalUndo(run: JournalRun, request: JournalUndoOptions): ExitCode {
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
function isKeepDays(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// The refusal for a prune with no window. A config that did not load is named,
// so a broken `[journal]` key is not reported as a missing one.
function keepWindowRefusal(configError: string | undefined): string {
  if (configError === undefined) return PRUNE_WINDOW_ERROR;
  return `${PRUNE_WINDOW_ERROR}; the config did not load: ${redactSecretShapes(configError)}`;
}

function journalPrune(run: JournalRun, request: JournalPruneOptions): ExitCode {
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
