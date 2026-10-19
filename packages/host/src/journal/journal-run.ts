// What every journal command shares: its requests and dependencies, and the
// store one invocation reads: a session's journal (named by `--session`, or
// the latest one recorded for this workspace), whose paths resolve against
// the workspace the session recorded.

import { dirname, join, sep } from 'node:path';
import {
  listSessions,
  openSessionStore,
  SESSION_ID_PATTERN,
  sessionLockIsLive,
} from '@kubic/agent/lane/session-store';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import { CliUsageError } from '@kubic/core/cli/exit-codes';
import type { CliLogger } from '@kubic/core/cli/logger';
import type { CliTheme } from '@kubic/core/cli/theme';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type { FileJournalStore } from '@kubic/exec/journal';
import { defaultSessionsRoot } from '../sessions/index.js';

export interface JournalCommandDeps {
  // A journal directory that pins the store, in place of the session lookup.
  journalDir?: string;
  sessionsRoot?: string;
  root?: string;
  // `session.retentionDays`: the read-time self-heal window for
  // SESSION journals. Undefined — or 0 — means retention is off, and the
  // read path writes nothing. A pinned journal directory is never governed
  // by this key: `journal.retentionDays` bounds it on append.
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
export interface JournalSelection {
  // `<id>` or the `journal:<id>` ref `kubic run` prints.
  session?: string | undefined;
  json?: boolean | undefined;
}

export interface JournalDiffOptions extends JournalSelection {
  path?: string | undefined;
  // `--stat` prints the per-file summary (path, added/removed
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

// `journal prune`: entries older than the keep window leave the store that
// `log` reads. A dry run unless `yes`.
export interface JournalPruneOptions extends JournalSelection {
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

// Session ids are path segments under the sessions root: the shared run-cli
// SESSION_ID_PATTERN ([A-Za-z0-9_-]) is checked before any path join, so the
// join below is contained by construction. Imported (not copied) so the rule
// cannot drift.

// The `journal:<id>` ref `kubic run` prints; accepted verbatim as the
// --session value so the printed token needs no extra lookup.
const JOURNAL_REF_PREFIX = 'journal:';

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
      // that recorded neither — a hand-made dir — stays unassociated rather
      // than guessing one.
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

// The run journals under the sessions root, newest first: one level of
// session ids (the shared SESSION_ID_PATTERN, checked before any path join —
// contained by construction, same rule as --session), ordered by
// `journal/index.jsonl` mtime among the sessions `accept` admits (only those
// recorded for the current workspace). A session whose journal index cannot
// be statted is skipped (no journal there); a missing sessions root is simply
// "nothing here" (fresh machine), never a throw.
function sessionJournals(
  sessionsRoot: string,
  accept: (id: string) => boolean,
): Array<{ id: string; dir: string; mtime: number }> {
  const bridge = createNodeFileBridge(sessionsRoot);
  const found: Array<{ id: string; dir: string; mtime: number }> = [];
  try {
    for (const info of bridge.listDir('.')) {
      if (!info.isDirectory || !SESSION_ID_PATTERN.test(info.name)) continue;
      if (!accept(info.name)) continue;
      const idx = join(info.name, 'journal', 'index.jsonl');
      try {
        const mtime = bridge.fileInfo(idx).mtimeMs;
        found.push({
          id: info.name,
          dir: join(sessionsRoot, info.name, 'journal'),
          mtime,
        });
      } catch {
        // Session without a journal — skip it.
      }
    }
  } catch {
    // No sessions root yet — nothing to fall back to.
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

interface ResolvedStore {
  // The journal directory. Undefined when no journal is recorded for this
  // workspace: the commands then read an empty journal and touch no store.
  dir?: string;
  // Set exactly when the resolved store is a session journal (explicit
  // --session or the latest-session fallback) — the read-time self-heal
  // keys off it, so a pinned store can never be pruned by
  // `session.retentionDays`.
  sessionId?: string;
  latestSessionId?: string;
  // The other session journals recorded for this workspace when the
  // latest-session fallback chose among several, newest first.
  otherSessionIds?: readonly string[];
  // The workspace the store's relative paths resolve against.
  // A session store takes the session's recorded cwd; undefined means the
  // session recorded none (undo/status then refuse by name).
  workspace?: string;
}

// Throws CliUsageError for a bad or conflicting --session (exit 2).
export async function resolveJournalDir(
  deps: JournalCommandDeps,
  root: string,
  session: string | undefined,
): Promise<ResolvedStore> {
  const workspacesOf = deps.sessionWorkspaces ?? defaultSessionWorkspaces;
  if (session === undefined) {
    // A pinned journal dir is the store (one store per invocation,
    // fail-closed — the same rule as the --session conflict below), and
    // keeps the lookup off the real sessions root.
    if (deps.journalDir !== undefined) {
      return { dir: deps.journalDir, workspace: root };
    }
    // Runs journal under `<sessionsRoot>/<id>/journal`, so the bare default
    // is the latest session journal. Only sessions recorded for THIS
    // workspace are candidates — another project's newer journal is never
    // picked, and its relative paths never resolve against this cwd.
    const sessionsRoot = deps.sessionsRoot ?? defaultSessionsRoot();
    const workspaces = await workspacesOf(sessionsRoot);
    const [latest, ...others] = sessionJournals(sessionsRoot, (id) => {
      const recorded = workspaces.get(id);
      return recorded !== undefined && workspaceContains(recorded, root);
    });
    if (latest === undefined) return { workspace: root };
    return {
      dir: latest.dir,
      sessionId: latest.id,
      latestSessionId: latest.id,
      workspace: workspaces.get(latest.id) as string,
      ...(others.length === 0
        ? {}
        : { otherSessionIds: others.map((other) => other.id) }),
    };
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
export interface JournalRun {
  readonly deps: JournalCommandDeps;
  // The workspace root the store's paths resolve against —
  // the invocation cwd only for a pinned store or no journal.
  readonly root: string;
  // The resolved session id and root, as `--json` reports them.
  readonly ref: { session: string | null; root: string | null };
  readonly resolved: ResolvedStore;
  // Undefined when no journal is recorded for this workspace.
  readonly store: FileJournalStore | undefined;
  readonly theme: CliTheme;
  readonly log: CliLogger;
}

// The live holder of the store's session lock, when the resolved
// store is a session journal. `resolved.dir` is `<sessionsRoot>/<id>/journal`,
// so the session directory — and the `lock.json` the store's own runs hold —
// is one level up. A pinned store has no session to check.
export function lockHolderOf(
  deps: JournalCommandDeps,
  resolved: ResolvedStore,
): { pid: number } | undefined {
  if (resolved.sessionId === undefined || resolved.dir === undefined) {
    return undefined;
  }
  const probe = deps.sessionLockHolder ?? sessionLockIsLive;
  return probe(dirname(resolved.dir));
}

// The live holder of another session's lock, by session id.
export function sessionHolderOf(
  deps: JournalCommandDeps,
  sessionId: string,
): { pid: number } | undefined {
  const probe = deps.sessionLockHolder ?? sessionLockIsLive;
  return probe(join(deps.sessionsRoot ?? defaultSessionsRoot(), sessionId));
}

export function workspaceRefusal(
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
