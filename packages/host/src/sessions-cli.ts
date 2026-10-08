// `kubic sessions` commands: create, list, attach.
// Thin over the worker session store; presentation only (one line per
// fact). attach prints metadata plus the transcript tail so a user can
// confirm what they are resuming before driving it.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type ExitCode,
} from '../../core/src/cli/exit-codes.js';
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
  // `session.retentionDays`: the default keep-window for
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
    }
  | {
      readonly command: 'attach';
      readonly id: string;
      readonly tail?: number;
      readonly ids?: boolean;
      // The raw form the readable rendering replaces — one
      // full (untruncated) entry JSON per line, for scripting.
      readonly json?: boolean;
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

// `prune`: explicit, opt-in session-state retention. Dry-run
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
): Promise<ExitCode> {
  const log = diagnosticsOf(deps);
  // commander refuses the pair first (.conflicts); kept as the handler's
  // own guard so a direct call cannot delete under --dry-run.
  if (parsed.yes === true && parsed.dryRun === true) {
    log.error(
      '--yes and --dry-run contradict — deletion is explicit, pass one',
    );
    return EXIT_USAGE;
  }
  const keepDays = parsed.keepDays ?? deps.retentionDays;
  if (keepDays === undefined) {
    log.error(PRUNE_WINDOW_ERROR);
    return EXIT_FAILED;
  }
  if (keepDays === 0) {
    deps.out('session retention is off (keep-days 0) — nothing is pruned');
    return EXIT_OK;
  }
  const bridge = createNodeFileBridge(root);
  let plan: SessionPrunePlan;
  try {
    plan = planSessionPrune({
      root,
      bridge,
      keepDays,
      keep: [...(parsed.keepSession ?? [])],
      ...(deps.now === undefined ? {} : { now: deps.now() }),
    });
  } catch (error) {
    if (error instanceof SessionsRootError) {
      log.error(error.message);
      return EXIT_FAILED;
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
    return EXIT_OK;
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
      return EXIT_OK;
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
      // A lock went live between planning and this delete:
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
): Promise<CommandResult> {
  const log = diagnosticsOf(deps);
  const root = deps.sessionsRoot ?? defaultSessionsRoot();
  // prune never opens the session repo (it reads the root's dirs directly,
  // reading no transcript at all).
  if (invocation.command === 'prune') {
    return { exitCode: await runPruneCommand(invocation, deps, root) };
  }
  const store = openSessionStore(root, createNodeFileBridge(root));
  if (invocation.command === 'create') {
    // A relative --cwd resolves against the INVOKING
    // directory, never the sessions root the store's bridge is built on —
    // `--cwd .` must record the caller's directory. Resolve-only, no
    // realpath: the overlap probe (sessionsTouchingWorkspace) compares
    // strict === against the run side's unresolved process.cwd(), so
    // canonicalizing one side would introduce the mismatch realpath is
    // meant to prevent (journal-cli canonicalizes its own compare).
    // I/O confinement: the check rides a root-anchored bridge, so an
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
      return { exitCode: EXIT_FAILED };
    }
    const session = await createSession(store, { cwd }, BACKGROUND_CONTEXT);
    const id = session.id;
    await session.release(BACKGROUND_CONTEXT);
    deps.out(id);
    // Session-scoped full-access: recorded in the session dir (posture.json)
    // and announced on the diagnostics channel. Fresh sessions start safe —
    // the flag must be passed explicitly every time.
    if (invocation.dangerouslySkipApprovals === true) {
      // The shared enable path — posture.json, one audit row
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
    return { exitCode: EXIT_OK };
  }
  if (invocation.command === 'list') {
    const sessions = await listSessions(store, BACKGROUND_CONTEXT);
    if (invocation.json === true) {
      // Always one JSON array — `[]` when there are no sessions, so a
      // `| jq` consumer never reads an empty stream.
      deps.out(
        formatJson(
          sessions.map((entry) => ({
            id: entry.id,
            cwd: entry.meta?.cwd ?? null,
          })),
        ),
      );
      return { exitCode: EXIT_OK };
    }
    if (sessions.length === 0) {
      log.info(`no sessions recorded under ${root}`);
      return { exitCode: EXIT_OK };
    }
    const theme = themeOf(deps);
    deps.out(
      renderTable(
        sessions.map((entry) => {
          const cwd = entry.meta?.cwd ?? theme.muted('(no cwd)');
          return [theme.bold(entry.id), cwd];
        }),
        [{ header: 'SESSION' }, { header: 'CWD' }],
        { fancy: deps.fancy === true, theme },
      ),
    );
    return { exitCode: EXIT_OK };
  }
  if (invocation.command === 'fork') {
    return { exitCode: await runForkCommand(invocation, deps, store) };
  }
  // attach
  const { id } = invocation;
  const tail = invocation.tail ?? 10;
  // commander validates the id first; re-checked here because the id
  // becomes a path segment under the sessions root.
  if (!SESSION_ID_PATTERN.test(id)) {
    log.error('invalid session id');
    return { exitCode: EXIT_USAGE };
  }
  try {
    const session = await attachSession(store, id, BACKGROUND_CONTEXT);
    try {
      deps.out(`session ${session.id}  cwd=${session.meta.cwd ?? '(none)'}`);
      const posture = new FileApprovalStore(join(root, id)).loadPosture();
      deps.out(
        posture.fullAccess
          ? `posture: full-access (enabled ${posture.enabledAt ?? 'unknown'} by ${posture.enabledBy ?? 'unknown'})`
          : 'posture: approvals enforced',
      );
      // Unfinished durable work a crashed process left
      // behind is named, so the operator knows the next `kubic run --session`
      // / `kubic tui --session` settles it before taking a new prompt. The
      // storage-level probe owns the format, so
      // this line and the run path's settlement line are the same string;
      // attach must not boot a harness.
      const pending = await inspectStoredWork(
        session.storage,
        BACKGROUND_CONTEXT,
      );
      if (pending.pending && pending.summary !== undefined) {
        deps.out(pending.summary);
      }
      // The transcript through the shared adapter: one readable line
      // per turn instead of a truncated JSON entry. `--ids` prefixes each
      // line with its entry id — the `--at` that
      // `kubic sessions fork` takes.
      const entries = [
        ...(await readSessionEntries(session.storage, BACKGROUND_CONTEXT)),
      ].sort((left, right) => left.id - right.id);
      const lines: string[] = [];
      for (const entry of entries) {
        if (invocation.json === true) {
          lines.push(JSON.stringify(entry));
          continue;
        }
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
    // A live second attachment: the refusal is the answer —
    // printed as-is (it names the holder pid + start time), exit 1, and
    // no transcript was ever read (attach acquires before it opens).
    if (
      error instanceof SessionLockError ||
      error instanceof SessionAttachError
    ) {
      log.error(error.message);
      return { exitCode: EXIT_FAILED };
    }
    throw error;
  }
  return { exitCode: EXIT_OK };
}

// One attach line per transcript item: role + text, one line each.
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

// `fork`: a new session from an existing one — a branch
// fork at an entry (default: the newest), or the whole tree with --tree. The
// new id is printed (or `{id, source, at}` with --json) and is usable at once
// with `kubic run --session` / `kubic tui --session`. The store refuses a
// live-locked source and a missing one; both exit 1, like attach.
async function runForkCommand(
  invocation: Extract<SessionsInvocation, { command: 'fork' }>,
  deps: SessionsCommandDeps,
  store: ReturnType<typeof openSessionStore>,
): Promise<ExitCode> {
  const log = diagnosticsOf(deps);
  if (!SESSION_ID_PATTERN.test(invocation.id)) {
    log.error('invalid session id');
    return EXIT_USAGE;
  }
  if (invocation.tree === true && invocation.at !== undefined) {
    log.error('sessions fork: --at and --tree are mutually exclusive');
    return EXIT_USAGE;
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
    return EXIT_OK;
  } catch (error) {
    if (
      error instanceof SessionLockError ||
      error instanceof SessionAttachError ||
      error instanceof SessionForkError
    ) {
      log.error(error.message);
      return EXIT_FAILED;
    }
    throw error;
  }
}
