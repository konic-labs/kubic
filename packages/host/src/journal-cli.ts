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
import { gitHeadOf } from '../../exec/src/git-clean.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import {
  clipChangeContent,
  DEFAULT_MAX_CONTENT_BYTES,
  diffEntries,
  diffEntriesMany,
  renderDiff,
  renderDiffStat,
} from '../../exec/src/journal-diff.js';
import {
  formatHeadMove,
  journalStatus,
  reconciliationSummary,
  reconciliationSummaryFor,
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
  // Issue #337: the live holder of a session's lock, by session directory.
  // Default: the session store's own liveness probe (`sessionLockIsLive`,
  // pid-based). Injected by tests so a live holder is expressible without a
  // second process.
  sessionLockHolder?: (sessionDir: string) => { pid: number } | undefined;
  // Issue #364: the worker session ids linked to an orchestration, for
  // `diff`/`log --session <orch>` aggregation. Default: the deterministic
  // `<orch>-<agent>` naming discovered from the sessions root (only ids
  // whose session actually holds a journal aggregate). Tests inject the
  // list to stay hermetic (no walk of the real sessions root).
  linkedSessions?: (sessionsRoot: string, orchId: string) => string[];
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
  // Issue #335: `--stat` prints the per-file summary (path, added/removed
  // counts, tool, turn) instead of hunks. Human render only — `--json`
  // already carries the fields, so `--json` ignores it.
  stat?: boolean | undefined;
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
// Exported for `kubic clean --journal` (issue #367): the same workspace
// association decides which session journals a clean prunes.
export async function defaultSessionWorkspaces(
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
// Exported for `kubic clean --journal` (issue #367).
export function canonical(path: string): string {
  try {
    return createNodeFileBridge('/').realPath?.(path) ?? path;
  } catch {
    return path;
  }
}

// True when `root` is the recorded workspace or inside it: `kubic diff`
// from a project's subdirectory still belongs to that project.
// Exported for `kubic clean --journal` (issue #367): a session created in
// a subdirectory associates with its repo the same way.
export function workspaceContains(recorded: string, root: string): boolean {
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
  // Issue #364: the orchestration's linked worker journals (empty for
  // workspace stores and unlinked sessions). `diff`/`log` aggregate these;
  // `status`/`undo` keep the single-store contract.
  readonly linked: LinkedJournal[];
  readonly theme: CliTheme;
  readonly log: CliLogger;
}

const PLAIN = createCliTheme('none');

// One linked worker journal: its session id, its journal dir, and a store
// over it (issue #364). Read-only by contract — `diff`/`log` aggregate
// these, `undo` never touches them (undo across worktrees is out of scope).
interface LinkedJournal {
  sessionId: string;
  dir: string;
  store: FileJournalStore;
}

// Issue #364: the default linked-session discovery — the deterministic
// `<orch>-<agent>` naming applied as a prefix scan over the sessions root.
// Only session dirs that actually hold a journal index aggregate, so a
// planned-but-never-spawned worker contributes nothing, and names come
// from the directory listing (SESSION_ID_PATTERN-checked before any join
// — contained by construction, the same rule as --session). Sorted, so
// aggregation order is deterministic.
function defaultLinkedSessions(sessionsRoot: string, orchId: string): string[] {
  const bridge = createNodeFileBridge(sessionsRoot);
  const prefix = `${orchId}-`;
  const out: string[] = [];
  try {
    for (const info of bridge.listDir('.')) {
      if (!info.isDirectory || !info.name.startsWith(prefix)) continue;
      if (!SESSION_ID_PATTERN.test(info.name)) continue;
      const idx = join(info.name, 'journal', 'index.jsonl');
      try {
        bridge.fileInfo(idx);
      } catch {
        continue;
      }
      out.push(info.name);
    }
  } catch {
    // No sessions root yet — nothing linked.
  }
  out.sort();
  return out;
}

// Issue #364: resolve the linked worker journals for a session store.
// Empty for workspace stores (no orchestration id to key on) and when
// nothing linked holds a journal — both read exactly as before.
function linkedJournals(
  deps: JournalCommandDeps,
  sessionsRoot: string,
  orchId: string,
): LinkedJournal[] {
  const list = deps.linkedSessions ?? defaultLinkedSessions;
  const out: LinkedJournal[] = [];
  for (const id of list(sessionsRoot, orchId)) {
    if (id === orchId || !SESSION_ID_PATTERN.test(id)) continue;
    const dir = join(sessionsRoot, id, 'journal');
    if (!hasJournalIndex(dir)) continue;
    out.push({ sessionId: id, dir, store: new FileJournalStore(dir) });
  }
  return out;
}

// Issue #337: the live holder of the store's session lock, when the resolved
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
  // Issue #364: worker-journal aggregation is keyed on the resolved
  // session id (explicit --session or the latest-session fallback) — a
  // workspace store has no orchestration to aggregate. Review follow-up:
  // discovery runs for `diff`/`log` only — `status`/`undo` keep the
  // single-store contract, so even naming linked journals there would
  // imply worker coverage the restore does not do.
  const linked =
    resolved.sessionId === undefined ||
    (request.command !== 'diff' && request.command !== 'log')
      ? []
      : linkedJournals(
          deps,
          deps.sessionsRoot ?? defaultSessionsRoot(),
          resolved.sessionId,
        );
  if (linked.length > 0 && !json) {
    log.info(
      `linked worker journals: ${linked.map((l) => l.sessionId).join(', ')}`,
    );
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
    linked,
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
  const { deps, store, linked } = run;
  const filter = {
    ...(request.path === undefined ? {} : { path: request.path }),
    ...(request.agent === undefined ? {} : { agent: request.agent }),
  };
  // Issue #364: one store reads exactly as before (`diffEntries`); linked
  // worker journals merge per session+path with blobs from their home
  // store (`diffEntriesMany`), so `diff --session <orch>` covers the run
  // and `--agent` selects one worker's changes.
  const changes =
    linked.length === 0
      ? diffEntries(store, filter)
      : diffEntriesMany([store, ...linked.map((l) => l.store)], filter);
  // The aggregation names itself for scripts; absent when unlinked so the
  // single-store document shape is byte-identical.
  const linkedSessions =
    linked.length === 0
      ? {}
      : { linkedSessions: linked.map((l) => l.sessionId) };
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
        ...linkedSessions,
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
  // Issue #335: `--stat` swaps the hunks for the per-file summary. The
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

function journalUndo(run: JournalRun, request: JournalUndoOptions): number {
  const { deps, store, root, theme } = run;
  const dryRun = request.dryRun === true;
  // Issue #337: a live run on this session is writing the workspace this undo
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
  // Issue #108: --force overrides the staleness refusal per-invocation;
  // nothing persists it — the next undo re-checks by default.
  const result = applyUndo(store, plan, root, {
    dryRun,
    force: request.force === true,
  });
  // Every real restore lands one `undo-restore` row in the workspace's
  // own §60 ledger (issue #284): which session undid, what came back, what
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
  // Issue #378: HEAD-move refusals are their own class — neither
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
  const { deps, store, resolved, linked } = run;
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
    // Issue #337: pruning under a live run is a race the reader cannot win —
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
  // Issue #364: each linked worker journal gets the same read-time
  // self-heal under its own lock — a live worker's store is skipped and
  // named, exactly like the primary above.
  if (retentionDays > 0) {
    const probe = deps.sessionLockHolder ?? sessionLockIsLive;
    for (const l of linked) {
      const holder = probe(dirname(l.dir));
      if (holder !== undefined) {
        run.log.warn(
          `journal retention skipped: session '${l.sessionId}' is attached by pid ${holder.pid} — pruning under a live run can drop entries it just appended`,
        );
      } else {
        l.store.enforceRetention({ maxAgeMs: retentionDays * MS_PER_DAY });
      }
    }
  }
  // Issue #364: `log --session <orch>` interleaves the orchestration's
  // worker journals with its own by timestamp (session id, then path,
  // break ties deterministically). Unlinked reads exactly as before.
  const entries = [
    ...store.entries(),
    ...linked.flatMap((l) => l.store.entries()),
  ].sort((a, b) =>
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
  const linkedSessions =
    linked.length === 0
      ? {}
      : { linkedSessions: linked.map((l) => l.sessionId) };
  // `--json` stays the raw entries array (the count is derivable from the
  // `unattributed` flags there); the human path gains the summary line.
  if (request.json === true) {
    deps.out(formatJson({ ...run.ref, ...linkedSessions, entries }));
    return EXIT_OK;
  }
  if (entries.length === 0) {
    deps.out('journal is empty');
  } else {
    // Issue #378: markers are not file rows — the PATH column names HEAD
    // and the NOTE column names the move.
    const rows = entries.map((e) => [
      new Date(e.timestamp).toISOString(),
      e.agentId,
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
  // Issue #87: the reconciliation count is part of `log`'s contract — it
  // is the only surface that answers "did anything bypass the tools?"
  // without the operator grepping for the `reconciled` marker. Printed
  // for an empty journal too, so scripts see a stable shape. With linked
  // workers (issue #364) it counts the merged timeline, not the primary
  // store alone.
  deps.out(
    linked.length === 0
      ? reconciliationSummary(store)
      : reconciliationSummaryFor(entries),
  );
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
  // Issue #343: index lines dropped because they do not parse — a torn tail
  // from a crash or a full disk. Named separately from `corrupt`: that
  // counts lost content, this counts unreadable lines, and an operator
  // cannot infer one from the other.
  const corruptLines = `corrupt index lines: ${status.corruptLines}`;
  deps.out(status.corruptLines > 0 ? theme.error(corruptLines) : corruptLines);
  // Issue #378: a HEAD move mid-run changes what every earlier entry
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
    // Issue #380: the repo line carries the root, ahead/behind and
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
