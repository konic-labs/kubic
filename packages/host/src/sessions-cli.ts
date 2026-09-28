// `kubic sessions` commands (issue #14, slice F): create, list, attach.
// Thin over the worker session store; presentation only (one line per
// fact). attach prints metadata plus the transcript tail so a user can
// confirm what they are resuming before driving it.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  attachSession,
  createSession,
  listSessions,
  openSessionStore,
  SessionAttachError,
  SessionLockError,
} from '../../worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../worker/src/pi-boundary.js';
import { enableFullAccess, FileApprovalStore } from './approvals.js';
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
  | { readonly command: 'list'; readonly json?: boolean }
  | { readonly command: 'attach'; readonly id: string; readonly tail?: number }
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
      return 1;
    }
    throw error;
  }
  for (const locked of plan.locked) {
    deps.out(
      `locked: ${locked.id} (held by pid ${locked.pid} since ${lockSince(locked.startedAt)}) — skipped`,
    );
  }
  for (const id of plan.kept) deps.out(`kept: ${id} (--keep-session)`);
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
    const cwd = invocation.cwd ?? process.cwd();
    const session = await createSession(store, cwd, BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.close(BACKGROUND_CONTEXT);
    deps.out(id);
    // Session-scoped full-access: recorded in the session dir (posture.json)
    // and announced on the diagnostics channel. Fresh sessions start safe —
    // the flag must be passed explicitly every time.
    if (invocation.dangerouslySkipApprovals === true) {
      const approvalStore = new FileApprovalStore(join(root, id));
      const posture = enableFullAccess(
        approvalStore,
        'cli --dangerously-skip-approvals',
      );
      log.warn(`full-access approvals skipped (recorded ${posture.enabledAt})`);
    }
    return 0;
  }
  if (invocation.command === 'list') {
    const sessions = await listSessions(store, BACKGROUND_CONTEXT);
    if (invocation.json === true) {
      // Always one JSON array — `[]` when there are no sessions, so a
      // `| jq` consumer never reads an empty stream (§78).
      deps.out(
        formatJson(
          sessions.map((entry) => ({ id: entry.id, cwd: entry.cwd ?? null })),
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
        sessions.map((entry) => [
          theme.bold(entry.id),
          entry.cwd ?? theme.muted('(no cwd)'),
        ]),
        [{ header: 'SESSION' }, { header: 'CWD' }],
        { fancy: deps.fancy === true, theme },
      ),
    );
    return 0;
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
      deps.out(
        `session ${session.metadata.id}  cwd=${session.metadata.cwd ?? '(none)'}`,
      );
      const posture = new FileApprovalStore(join(root, id)).loadPosture();
      deps.out(
        posture.fullAccess
          ? `posture: full-access (enabled ${posture.enabledAt ?? 'unknown'} by ${posture.enabledBy ?? 'unknown'})`
          : 'posture: approvals enforced',
      );
      const entries = await session.findEntries(undefined, BACKGROUND_CONTEXT);
      const last = entries.slice(Math.max(0, entries.length - tail));
      for (const entry of last) {
        deps.out(JSON.stringify(entry).slice(0, 300));
      }
    } finally {
      await session.close(BACKGROUND_CONTEXT);
    }
  } catch (error) {
    // A live second attachment (issue #118): the refusal is the answer —
    // printed as-is (it names the holder pid + start time), exit 1, and
    // no transcript was ever read (attach acquires before it opens).
    if (
      error instanceof SessionLockError ||
      error instanceof SessionAttachError
    ) {
      log.error(error.message);
      return 1;
    }
    throw error;
  }
  return 0;
}
