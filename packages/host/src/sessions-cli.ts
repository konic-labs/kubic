// `kubic sessions` commands (issue #14, slice F): create, list, attach.
// Thin over the worker session store; presentation only (one line per
// fact). attach prints metadata plus the transcript tail so a user can
// confirm what they are resuming before driving it.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { answerHelp } from '../../core/src/cli-help.js';
import { type FlagSpec, parseFlagArgs } from '../../core/src/flags.js';
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
import { SESSION_ID_PATTERN } from './run-cli.js';
import {
  deleteSessionPruneCandidates,
  planSessionPrune,
  type SessionPrunePlan,
  SessionsRootError,
} from './sessions-prune.js';

export interface SessionsCommandDeps {
  sessionsRoot?: string;
  out: (line: string) => void;
  // `session.retentionDays` (issue #119): the default keep-window for
  // `prune`. Undefined means the config sets none — prune then demands an
  // explicit --keep-days rather than inventing a window.
  retentionDays?: number;
  // Clock seam for boundary-exact age tests; real runs use Date.now().
  now?: () => number;
}

export function defaultSessionsRoot(): string {
  return join(homedir(), '.kubic', 'sessions');
}

const SESSIONS_USAGE =
  'usage: kubic sessions <create [--cwd <path>] [--dangerously-skip-approvals] | list | attach [--] <id> [--tail <n>] | prune [--keep-days <n>] [--keep-session <id>]... [--yes] [--dry-run]>';

function usage(out: (line: string) => void): number {
  out(SESSIONS_USAGE);
  return 1;
}

// `prune` (issue #119): explicit, opt-in session-state retention. Dry-run
// is the DEFAULT — deletion needs --yes — and the keep window must come
// from --keep-days or config `session.retentionDays`: no window is ever
// invented. Live-locked sessions, --keep-session names, and non-session
// entries are never candidates, and the lock is re-checked immediately
// before each delete (sessions-prune.ts owns both rails; this is
// presentation: one line per fact, honest counts).
interface PruneOptions {
  keepDays?: number;
  keep: string[];
  yes: boolean;
  dryRun: boolean;
}

const PRUNE_WINDOW_ERROR =
  'error: sessions prune needs a keep window: pass --keep-days <n> or set [session] retentionDays in config (no default — deletion stays explicit)';

// Issue #127: shared parser specs. `create`/`attach` keep their historical
// leniency for unknown flags (only their own flags are read); `prune`
// keeps its fail-closed refusal of unknown flags and stray operands.
const PRUNE_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--keep-days', takes: 'value' },
  { name: '--keep-session', takes: 'value', repeat: true },
  { name: '--yes', takes: 'boolean' },
  { name: '--dry-run', takes: 'boolean' },
];

const CREATE_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--cwd', takes: 'value' },
  { name: '--dangerously-skip-approvals', takes: 'boolean' },
];

const ATTACH_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--tail', takes: 'value' },
];

function parsePruneArgs(
  rest: string[],
  out: (line: string) => void,
): PruneOptions | undefined {
  const parsed = parseFlagArgs(rest, PRUNE_FLAG_SPEC);
  for (const flag of parsed.missing) {
    out(`error: ${flag} needs a value`);
    return undefined;
  }
  if (parsed.unknown.length > 0) {
    out(`error: unknown flag ${parsed.unknown[0]}`);
    return undefined;
  }
  if (parsed.positional.length > 0) {
    out(`error: unexpected argument ${JSON.stringify(parsed.positional[0])}`);
    return undefined;
  }
  const parsedOptions: PruneOptions = {
    keep: [],
    yes: parsed.values['--yes'] === true,
    dryRun: parsed.values['--dry-run'] === true,
  };
  const keepDaysRaw = parsed.values['--keep-days'] as string | undefined;
  if (keepDaysRaw !== undefined) {
    if (!/^\d+$/.test(keepDaysRaw)) {
      out('error: --keep-days needs a non-negative integer of days');
      return undefined;
    }
    parsedOptions.keepDays = Number(keepDaysRaw);
  }
  const keepSessions =
    (parsed.values['--keep-session'] as string[] | undefined) ?? [];
  for (const value of keepSessions) {
    if (!SESSION_ID_PATTERN.test(value)) {
      out(`error: invalid --keep-session id ${JSON.stringify(value)}`);
      return undefined;
    }
  }
  parsedOptions.keep = [...keepSessions];
  return parsedOptions;
}

function lockSince(startedAt: number | undefined): string {
  return typeof startedAt === 'number' && Number.isFinite(startedAt)
    ? new Date(startedAt).toISOString()
    : 'unknown start time';
}

function runPruneCommand(
  rest: string[],
  deps: SessionsCommandDeps,
  root: string,
): number {
  const parsed = parsePruneArgs(rest, deps.out);
  if (parsed === undefined) return 1;
  if (parsed.yes && parsed.dryRun) {
    deps.out(
      'error: --yes and --dry-run contradict — deletion is explicit, pass one',
    );
    return 1;
  }
  const keepDays = parsed.keepDays ?? deps.retentionDays;
  if (keepDays === undefined) {
    deps.out(PRUNE_WINDOW_ERROR);
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
      keep: parsed.keep,
      ...(deps.now === undefined ? {} : { now: deps.now() }),
    });
  } catch (error) {
    if (error instanceof SessionsRootError) {
      deps.out(`error: ${error.message}`);
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
  if (!parsed.yes) {
    for (const candidate of plan.candidates) {
      deps.out(`would prune ${candidate.id} (${candidate.bytes}B)`);
    }
    deps.out(
      `dry run: ${plan.candidates.length} session(s) would be pruned (${plan.totalBytes}B) — pass --yes to delete`,
    );
    return 0;
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
      deps.out(
        `error: could not prune ${outcome.candidate.id}: ${outcome.message}`,
      );
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
  args: string[],
  deps: SessionsCommandDeps,
): Promise<number> {
  // `--help`/`-h` is answered before any subcommand dispatch (issue #100).
  const help = answerHelp(args, deps.out, SESSIONS_USAGE);
  if (help !== null) return help;
  const [sub, ...rest] = args;
  if (sub === undefined) return usage(deps.out);
  const root = deps.sessionsRoot ?? defaultSessionsRoot();
  // prune never opens the session repo (it reads the root's dirs directly,
  // reading no transcript at all).
  if (sub === 'prune') return runPruneCommand(rest, deps, root);
  const store = openSessionStore(root, createNodeFileBridge(root));
  if (sub === 'create') {
    const parsed = parseFlagArgs(rest, CREATE_FLAG_SPEC);
    if (parsed.missing.includes('--cwd')) {
      deps.out('error: --cwd needs a value');
      return 1;
    }
    const cwd = (parsed.values['--cwd'] as string | undefined) ?? process.cwd();
    const session = await createSession(store, cwd, BACKGROUND_CONTEXT);
    const id = session.metadata.id;
    await session.close(BACKGROUND_CONTEXT);
    deps.out(id);
    // Session-scoped full-access: recorded in the session dir (posture.json)
    // and indicated on stdout. Fresh sessions start safe — the flag must be
    // passed explicitly every time.
    if (parsed.values['--dangerously-skip-approvals'] === true) {
      const approvalStore = new FileApprovalStore(join(root, id));
      const posture = enableFullAccess(
        approvalStore,
        'cli --dangerously-skip-approvals',
      );
      deps.out(
        `warning: full-access approvals skipped (recorded ${posture.enabledAt})`,
      );
    }
    return 0;
  }
  if (sub === 'list') {
    const sessions = await listSessions(store, BACKGROUND_CONTEXT);
    for (const entry of sessions) {
      deps.out(`${entry.id}  ${entry.cwd ?? '(no cwd)'}`);
    }
    return 0;
  }
  if (sub === 'attach') {
    const parsed = parseFlagArgs(rest, ATTACH_FLAG_SPEC);
    const id = parsed.positional[0];
    if (id === undefined) {
      deps.out('error: attach needs a session id');
      return 1;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      deps.out('error: invalid session id');
      return 1;
    }
    let tail = 10;
    const tailRaw = parsed.values['--tail'] as string | undefined;
    if (tailRaw !== undefined || parsed.missing.includes('--tail')) {
      // A starved --tail reports the same line as a malformed one (the
      // pre-migration Number(undefined) path printed exactly this).
      const parsedTail = Number(tailRaw);
      if (!Number.isInteger(parsedTail) || parsedTail < 0) {
        deps.out('error: --tail needs a non-negative integer');
        return 1;
      }
      tail = parsedTail;
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
        const entries = await session.findEntries(
          undefined,
          BACKGROUND_CONTEXT,
        );
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
      if (error instanceof SessionLockError) {
        deps.out(`error: ${error.message}`);
        return 1;
      }
      if (error instanceof SessionAttachError) {
        deps.out(`error: ${error.message}`);
        return 1;
      }
      throw error;
    }
    return 0;
  }
  return usage(deps.out);
}
