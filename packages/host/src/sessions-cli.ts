// `kubic sessions` commands (issue #14, slice F): create, list, attach.
// Thin over the worker session store; presentation only (one line per
// fact). attach prints metadata plus the transcript tail so a user can
// confirm what they are resuming before driving it.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { stripUnsafeCharacters } from '../../exec/src/runtime-exclude.js';
import { inspectStoredWork } from '../../worker/src/lane/pending.js';
import {
  attachSession,
  createSession,
  forkSession,
  listSessions,
  openSessionStore,
  SessionAttachError,
  SessionForkError,
  SessionFormatError,
  SessionLockError,
} from '../../worker/src/lane/session-store.js';
import {
  entriesToTranscript,
  readSessionEntries,
  type TranscriptItem,
} from '../../worker/src/lane/transcript.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { enableSessionFullAccess, FileApprovalStore } from './approvals.js';
import { type CliIo, diagnosticsOf, themeOf } from './cli-io.js';
import { SESSION_ID_PATTERN } from './run-cli.js';
import {
  deleteSessionPruneCandidates,
  planSessionPrune,
  type SessionPrunePlan,
  SessionsRootError,
} from './sessions-prune.js';

export interface SessionsCommandDeps extends CliIo {
  sessionsRoot?: string;
  // `session.retentionDays` (issue #119): the default keep-window for
  // `prune`. Undefined means the config sets none — prune then demands an
  // explicit --keep-days rather than inventing a window.
  retentionDays?: number;
  // Clock seam for boundary-exact age tests; real runs use Date.now().
  now?: () => number;
  // Interactive confirmation for a `prune` that passed neither --yes nor
  // --dry-run (TTY only — the root wires @clack/prompts there, never under
  // a pipe). Absent means the documented default: a dry run. Resolves null
  // when the prompt was cancelled.
  confirm?: (message: string) => Promise<boolean | null>;
}

// The parsed `kubic sessions <sub>` invocation (commander owns the argv:
// apps/kubic/src/commands/solo.ts).
export type SessionsInvocation =
  | {
      readonly command: 'create';
      readonly cwd?: string;
      readonly dangerouslySkipApprovals?: boolean;
    }
  | {
      readonly command: 'list';
      readonly json?: boolean;
      // Issue #164 (§23): show only the children of one run.
      readonly parent?: string;
    }
  | {
      readonly command: 'attach';
      readonly id: string;
      readonly tail?: number;
      readonly ids?: boolean;
    }
  | {
      readonly command: 'fork';
      readonly id: string;
      readonly at?: number;
      readonly tree?: boolean;
      readonly json?: boolean;
    }
  | {
      readonly command: 'prune';
      readonly keepDays?: number;
      readonly keepSession?: readonly string[];
      readonly yes?: boolean;
      readonly dryRun?: boolean;
    };

export function defaultSessionsRoot(): string {
  return join(homedir(), '.kubic', 'sessions');
}

// `prune` (issue #119): explicit, opt-in session-state retention. Dry-run
// is the DEFAULT — deletion needs --yes — and the keep window must come
// from --keep-days or config `session.retentionDays`: no window is ever
// invented. Live-locked sessions, --keep-session names, and non-session
// entries are never candidates, and the lock is re-checked immediately
// before each delete (sessions-prune.ts owns both rails; this is
// presentation: one line per fact, honest counts).
const PRUNE_WINDOW_ERROR =
  'sessions prune needs a keep window: pass --keep-days <n> or set [session] retentionDays in config (no default — deletion stays explicit)';

function lockSince(startedAt: number | undefined): string {
  return typeof startedAt === 'number' && Number.isFinite(startedAt)
    ? new Date(startedAt).toISOString()
    : 'unknown start time';
}

async function runPruneCommand(
  parsed: Extract<SessionsInvocation, { command: 'prune' }>,
  deps: SessionsCommandDeps,
  root: string,
): Promise<number> {
  const log = diagnosticsOf(deps);
  // commander refuses the pair first (.conflicts); kept as the handler's
  // own guard so a direct call cannot delete under --dry-run.
  if (parsed.yes === true && parsed.dryRun === true) {
    log.error(
      '--yes and --dry-run contradict — deletion is explicit, pass one',
    );
    return 2;
  }
  const keepDays = parsed.keepDays ?? deps.retentionDays;
  if (keepDays === undefined) {
    log.error(PRUNE_WINDOW_ERROR);
    return 1;
  }
  if (keepDays === 0) {
    deps.out('session retention is off (keep-days 0) — nothing is pruned');
    return 0;
  }
  const bridge = createNodeFileBridge(root);
  let plan: SessionPrunePlan;
  try {
    // Issue #164 (§23): the run tree for the family rule — header reads
    // only, so a session a live run holds is never opened here.
    const store = openSessionStore(root, bridge);
    const parents = new Map<string, string>();
    for (const entry of await listSessions(store, BACKGROUND_CONTEXT)) {
      if (entry.meta?.parentSessionId !== undefined) {
        parents.set(entry.id, entry.meta.parentSessionId);
      }
    }
    plan = planSessionPrune({
      root,
      bridge,
      keepDays,
      keep: [...(parsed.keepSession ?? [])],
      ...(deps.now === undefined ? {} : { now: deps.now() }),
      parentOf: (id) => parents.get(id),
    });
  } catch (error) {
    if (error instanceof SessionsRootError) {
      log.error(error.message);
      return 1;
    }
    throw error;
  }
  for (const locked of plan.locked) {
    deps.out(
      `locked: ${locked.id} (held by pid ${locked.pid} since ${lockSince(locked.startedAt)}) — skipped`,
    );
  }
  for (const kept of plan.kept) deps.out(`kept: ${kept.id} (${kept.why})`);
  for (const id of plan.unreadable) deps.out(`unreadable: ${id} — skipped`);
  if (plan.candidates.length === 0) {
    deps.out('nothing to prune');
    return 0;
  }
  if (parsed.yes !== true) {
    for (const candidate of plan.candidates) {
      deps.out(`would prune ${candidate.id} (${candidate.bytes}B)`);
    }
    // Neither --yes nor --dry-run on an interactive terminal: ask once.
    // Anywhere else (and on a no/cancel) this stays the dry run.
    const answer =
      parsed.dryRun !== true && deps.confirm !== undefined
        ? await deps.confirm(
            `Delete ${plan.candidates.length} session(s) (${plan.totalBytes}B)?`,
          )
        : null;
    if (answer !== true) {
      deps.out(
        `dry run: ${plan.candidates.length} session(s) would be pruned (${plan.totalBytes}B) — pass --yes to delete`,
      );
      return 0;
    }
  }
  const outcomes = deleteSessionPruneCandidates({
    root,
    bridge,
    candidates: plan.candidates,
  });
  let failed = 0;
  let deleted = 0;
  let reclaimed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'locked') {
      // A lock went live between planning and this delete (issue #119):
      // reported exactly like a planning-time lock, and never counted as
      // deleted.
      deps.out(
        `locked: ${outcome.candidate.id} (held by pid ${outcome.pid} since ${lockSince(outcome.startedAt)}) — skipped`,
      );
      continue;
    }
    if (outcome.status === 'failed') {
      log.error(`could not prune ${outcome.candidate.id}: ${outcome.message}`);
      failed += 1;
      continue;
    }
    deleted += 1;
    reclaimed += outcome.candidate.bytes;
    deps.out(`pruned ${outcome.candidate.id} (${outcome.candidate.bytes}B)`);
  }
  deps.out(`pruned ${deleted} session(s), ${reclaimed}B reclaimed`);
  return failed === 0 ? 0 : 1;
}

export async function runSessionsCommand(
  invocation: SessionsInvocation,
  deps: SessionsCommandDeps,
): Promise<number> {
  const log = diagnosticsOf(deps);
  const root = deps.sessionsRoot ?? defaultSessionsRoot();
  // prune never opens the session repo (it reads the root's dirs directly,
  // reading no transcript at all).
  if (invocation.command === 'prune') {
    return runPruneCommand(invocation, deps, root);
  }
  const store = openSessionStore(root, createNodeFileBridge(root));
  if (invocation.command === 'create') {
    // Issue #261: a relative --cwd resolves against the INVOKING
    // directory, never the sessions root the store's bridge is built on —
    // `--cwd .` must record the caller's directory. Resolve-only, no
    // realpath: the overlap probe (sessionsTouchingWorkspace) compares
    // strict === against the run side's unresolved process.cwd(), so
    // canonicalizing one side would introduce the mismatch realpath is
    // meant to prevent (journal-cli canonicalizes its own compare).
    // I/O confinement (§9): the check rides a root-anchored bridge, so an
    // absolute operand passes through unconfined.
    const cwd = resolve(process.cwd(), invocation.cwd ?? process.cwd());
    let isDirectory = false;
    try {
      isDirectory = createNodeFileBridge('/').fileInfo(cwd).isDirectory;
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      log.error(`kubic sessions create: --cwd ${cwd}: no such directory`);
      return 1;
    }
    const session = await createSession(store, { cwd }, BACKGROUND_CONTEXT);
    const id = session.id;
    await session.release(BACKGROUND_CONTEXT);
    deps.out(id);
    // Session-scoped full-access: recorded in the session dir (posture.json)
    // and announced on the diagnostics channel. Fresh sessions start safe —
    // the flag must be passed explicitly every time.
    if (invocation.dangerouslySkipApprovals === true) {
      // Issue #308: the shared enable path — posture.json, one §60 row
      // naming this session and command, and the common warning.
      const grant = enableSessionFullAccess({
        sessionDir: join(root, id),
        sessionId: id,
        command: 'sessions create',
        workspace: cwd,
        onAuditError: (message) =>
          log.warn(`audit: ledger append failed: ${message}`),
      });
      log.warn(grant.warning);
    }
    return 0;
  }
  if (invocation.command === 'list') {
    const listed = await listSessions(store, BACKGROUND_CONTEXT);
    // Review #164: a `--parent` naming no recorded session is a named
    // refusal (exit 1), not an empty listing — a run id with zero
    // children still lists (empty) when the run itself is recorded.
    if (
      invocation.parent !== undefined &&
      !listed.some((entry) => entry.id === invocation.parent)
    ) {
      log.error(`unknown parent session: ${invocation.parent}`);
      return 1;
    }
    // Issue #164 (§23): `--parent <id>` groups one run's children.
    const sessions =
      invocation.parent === undefined
        ? listed
        : listed.filter(
            (entry) => entry.meta?.parentSessionId === invocation.parent,
          );
    if (invocation.json === true) {
      // Always one JSON array — `[]` when there are no sessions, so a
      // `| jq` consumer never reads an empty stream (§78).
      deps.out(
        formatJson(
          sessions.map((entry) => ({
            id: entry.id,
            cwd: entry.meta?.cwd ?? null,
            // Ancestry keys appear only when the session has them: a root
            // carries no parent key at all (never null, never '').
            ...(entry.meta?.parentSessionId === undefined
              ? {}
              : { parentSessionId: entry.meta.parentSessionId }),
            ...(entry.meta?.role === undefined
              ? {}
              : { role: entry.meta.role }),
            ...(entry.meta?.agentId === undefined
              ? {}
              : { agentId: entry.meta.agentId }),
          })),
        ),
      );
      return 0;
    }
    if (sessions.length === 0) {
      log.info(`no sessions recorded under ${root}`);
      return 0;
    }
    const theme = themeOf(deps);
    deps.out(
      renderTable(
        sessions.map((entry) => {
          const cwd = entry.meta?.cwd ?? theme.muted('(no cwd)');
          return [
            theme.bold(entry.id),
            entry.format === 'legacy'
              ? `${cwd} ${theme.muted('(legacy pi 0.87 — cannot attach)')}`
              : cwd,
            entry.meta?.parentSessionId ?? theme.muted('—'),
          ];
        }),
        [{ header: 'SESSION' }, { header: 'CWD' }, { header: 'PARENT' }],
        { fancy: deps.fancy === true, theme },
      ),
    );
    return 0;
  }
  if (invocation.command === 'fork') {
    return runForkCommand(invocation, deps, store);
  }
  // attach
  const { id } = invocation;
  const tail = invocation.tail ?? 10;
  // commander validates the id first; re-checked here because the id
  // becomes a path segment under the sessions root.
  if (!SESSION_ID_PATTERN.test(id)) {
    log.error('invalid session id');
    return 2;
  }
  try {
    const session = await attachSession(store, id, BACKGROUND_CONTEXT);
    try {
      deps.out(`session ${session.id}  cwd=${session.meta.cwd ?? '(none)'}`);
      // Issue #164 (§23): the run this session belongs to, when it has one.
      if (session.meta.parentSessionId !== undefined) {
        // Review #164: role/agentId ride operator-typed binding values into
        // metadata, so they go through the same display strip as transcript
        // text before reaching the operator's terminal.
        const scoped = [
          `parent=${session.meta.parentSessionId}`,
          ...(session.meta.role === undefined
            ? []
            : [`role=${oneLine(session.meta.role)}`]),
          ...(session.meta.agentId === undefined
            ? []
            : [`agent=${oneLine(session.meta.agentId)}`]),
        ].join(' ');
        deps.out(scoped);
      }
      const posture = new FileApprovalStore(join(root, id)).loadPosture();
      deps.out(
        posture.fullAccess
          ? `posture: full-access (enabled ${posture.enabledAt ?? 'unknown'} by ${posture.enabledBy ?? 'unknown'})`
          : 'posture: approvals enforced',
      );
      // Issue #147 (§21): unfinished durable work a crashed process left
      // behind is named, so the operator knows the next `kubic run --session`
      // / `kubic tui --session` settles it before taking a new prompt. The
      // storage-level probe (#396 `inspectStoredWork`) owns the format, so
      // this line and the run path's settlement line are the same string;
      // attach must not boot a harness.
      const pending = await inspectStoredWork(
        session.storage,
        BACKGROUND_CONTEXT,
      );
      if (pending.pending && pending.summary !== undefined) {
        deps.out(pending.summary);
      }
      // The transcript through the shared adapter (#400): one readable line
      // per turn instead of a truncated JSON entry (#318). Issue #265:
      // `--ids` prefixes each line with its entry id — the `--at` that
      // `kubic sessions fork` takes.
      const entries = [
        ...(await readSessionEntries(session.storage, BACKGROUND_CONTEXT)),
      ].sort((left, right) => left.id - right.id);
      const lines: string[] = [];
      for (const entry of entries) {
        const item = entriesToTranscript([entry])[0];
        if (item === undefined) continue;
        const line = renderTranscriptItem(item);
        lines.push(invocation.ids === true ? `#${entry.id} ${line}` : line);
      }
      for (const line of lines.slice(Math.max(0, lines.length - tail))) {
        deps.out(line);
      }
    } finally {
      await session.release(BACKGROUND_CONTEXT);
    }
  } catch (error) {
    // A live second attachment (issue #118): the refusal is the answer —
    // printed as-is (it names the holder pid + start time), exit 1, and
    // no transcript was ever read (attach acquires before it opens).
    // A 0.87 session directory (#392) is refused by name the same way.
    if (
      error instanceof SessionLockError ||
      error instanceof SessionAttachError ||
      error instanceof SessionFormatError
    ) {
      log.error(error.message);
      return 1;
    }
    throw error;
  }
  return 0;
}

// One attach line per transcript item (#318): role + text, one line each.
// Whitespace is collapsed so a multi-line message or tool output stays one
// readable row, and the line keeps the documented 300-character bound.
// Transcript text is untrusted (model- and tool-authored): control
// characters — ESC sequences above all — are stripped before it reaches the
// operator's terminal, exactly as the display-only strip does elsewhere.
const ATTACH_LINE_CHARS = 300;

function oneLine(text: string): string {
  const collapsed = stripUnsafeCharacters(text).replace(/\s+/g, ' ').trim();
  return collapsed.length <= ATTACH_LINE_CHARS
    ? collapsed
    : `${collapsed.slice(0, ATTACH_LINE_CHARS - 1)}…`;
}

function renderTranscriptItem(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return `user: ${oneLine(item.text)}`;
    case 'assistant': {
      const text = oneLine(item.text);
      // Tool names are model-authored (pi-durable persists a call the
      // registry never offered), so they are sanitized like the text.
      const calls = item.toolCalls.map((call) => oneLine(call.name)).join(', ');
      const tools = calls === '' ? '' : ` [tools: ${calls}]`;
      return `assistant: ${text === '' ? '(no text)' : text}${tools}`;
    }
    case 'tool-result':
      return `tool-result ${oneLine(item.name)}: ${oneLine(item.text)}${
        item.isError ? ' (error)' : ''
      }`;
    case 'system':
      return `system: ${oneLine(item.text ?? '')}`;
    case 'compaction':
      return `[compaction] ${oneLine(item.text ?? '')}`;
    case 'reset':
      return `[reset]${item.text === undefined ? '' : ` ${oneLine(item.text)}`}`;
  }
}

// `fork` (issue #265; §22.3): a new session from an existing one — a branch
// fork at an entry (default: the newest), or the whole tree with --tree. The
// new id is printed (or `{id, source, at}` with --json) and is usable at once
// with `kubic run --session` / `kubic tui --session`. The store refuses a
// live-locked source, a missing one and a 0.87 one; all exit 1, like attach.
async function runForkCommand(
  invocation: Extract<SessionsInvocation, { command: 'fork' }>,
  deps: SessionsCommandDeps,
  store: ReturnType<typeof openSessionStore>,
): Promise<number> {
  const log = diagnosticsOf(deps);
  if (!SESSION_ID_PATTERN.test(invocation.id)) {
    log.error('invalid session id');
    return 2;
  }
  if (invocation.tree === true && invocation.at !== undefined) {
    log.error('sessions fork: --at and --tree are mutually exclusive');
    return 2;
  }
  try {
    const fork = await forkSession(
      store,
      invocation.id,
      {
        ...(invocation.at === undefined ? {} : { at: invocation.at }),
        ...(invocation.tree === true ? { tree: true } : {}),
      },
      BACKGROUND_CONTEXT,
    );
    deps.out(
      invocation.json === true
        ? formatJson({ id: fork.id, source: fork.source, at: fork.at ?? null })
        : fork.id,
    );
    return 0;
  } catch (error) {
    if (
      error instanceof SessionLockError ||
      error instanceof SessionAttachError ||
      error instanceof SessionFormatError ||
      error instanceof SessionForkError
    ) {
      log.error(error.message);
      return 1;
    }
    throw error;
  }
}
