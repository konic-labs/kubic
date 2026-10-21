// The prod `kubic tui` boot: the shared session bootstrap (session, role,
// model, policy, journal baseline, skills, lane) plus what the interactive
// loop reads from it.
import { join } from 'node:path';
import { killLaneProcesses } from '@kubic/agent/lane/abort';
import type { Lane } from '@kubic/agent/lane/boot';
import {
  describePendingSettlement,
  inspectPending,
  pendingInputText,
  settlePending,
} from '@kubic/agent/lane/pending';
import {
  forkSession,
  listSessions,
  type SessionHandle,
  type SessionStore,
} from '@kubic/agent/lane/session-store';
import { ModelSelectError } from '@kubic/agent/model-select';
import { walkFiles } from '@kubic/agent/ops/walk';
import {
  BACKGROUND_CONTEXT,
  type Context,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { expandSkillInvocation } from '@kubic/agent/skills';
import type { ExecutionEnv, FileSystem } from '@kubic/exec/env';
import type { FileJournalStore } from '@kubic/exec/journal';
import {
  fullAccessInForceWarning,
  type InstalledPolicy,
  type SessionFullAccessGrant,
} from '@kubic/host/approvals';
import { TurnSpans } from '@kubic/host/run';
import {
  readSessionUsage,
  type SessionSummary,
  type SessionUsageRow,
  summarizeProjectSessions,
} from '@kubic/host/sessions';
import { describeSkillSkips, offeredSkillNames } from '@kubic/host/skills';
import type { StatusUsageRow } from '@kubic/tui/status-bar';
import { type BootRefusal, SessionBoot } from '../session/bootstrap.js';
import { bootedLoop, contextLimitsOf, liveModelOf } from './lane-loop.js';
import type { TuiRunOptions } from './options.js';
import type { TuiLaneBoot } from './types.js';

// A refused tool selection: a usage error (exit 2), not a generic lane boot
// failure.
export class ToolSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSelectionError';
  }
}

// The boot's notices, by where they show.
interface BootNotices {
  // Warnings for the transcript, never stderr: the screen owns the terminal.
  // The skill loader's unresolvable --skill and each settled turn's
  // trajectory write push here; the loop drains them.
  readonly transcript: string[];
  // Warnings that must show before the screen opens (a refused
  // models.json): they ride the boot notices, printed on stderr first.
  readonly warnings: string[];
  // The model and thinking notices of the boot: a model switched or kept,
  // a clamped level. The footer names them from the first render.
  readonly model: string[];
}

// The turn cell the loop's counter fills post-boot via
// setCurrentTurnSupplier. Unwired (undefined) reads turn-less, so a
// boot without a loop behaves like a headless run.
interface TurnCell {
  supplier?: () => number | undefined;
}

export async function bootTuiLane(
  sessionId?: string,
  options: TuiRunOptions = {},
): Promise<TuiLaneBoot> {
  const context = BACKGROUND_CONTEXT;
  const notices: BootNotices = { transcript: [], warnings: [], model: [] };
  const turnCell: TurnCell = {};
  const boot = tuiSessionBoot(sessionId, options, context, notices, turnCell);
  const badSession = boot.validateSessionId();
  if (badSession?.kind === 'usage') throw new Error(badSession.message);
  const badTools = boot.validateTools();
  if (badTools?.kind === 'usage')
    throw new ToolSelectionError(badTools.message);
  const opened = await boot.open();
  if (opened?.kind === 'store') throw opened.error;
  const session = boot.session as SessionHandle;
  // The session's committed spend, read from its own `pi.usage`
  // ledger (the reader — the same numbers `kubic cost` prints) BEFORE the
  // lane adopts the storage. Best-effort: a torn or foreign usage document
  // must never block a boot; the bar then starts from zero.
  let usageRows: StatusUsageRow[] = [];
  try {
    usageRows = statusRowsFromSessionUsage(
      await readSessionUsage(session.storage, context),
    );
  } catch {
    usageRows = [];
  }
  // The quit's last-resort kill drain: every bash group is keyed by the
  // conversation id, so whatever is still registered when the quit runs is
  // killed here — before the sweep and the close — because a tool may
  // register its kill after the abort bound gave up on it. A settled turn's
  // handles are forgotten (forgetKills), so a kept background job is not
  // this quit's to kill.
  let lane: Lane | undefined;
  // The TUI's run end is its close — quit, SIGINT, EOF — so the end-of-run
  // sweep rides it. There is no closed-latch: idempotence comes from
  // `reconcile`'s per-path after-hash comparison, so a second close on an
  // unchanged tree appends nothing.
  const close = async (): Promise<void> => {
    try {
      killLaneProcesses(lane);
    } catch {
      // A kill that already exited is not a reason to skip the sweep.
    }
    await boot.teardown();
  };
  try {
    const refused = await boot.boot();
    if (refused !== undefined) throw bootRefusalError(refused);
    lane = boot.lane as Lane;
    return {
      ...(await describeBoot(boot, lane, options, context, notices, turnCell)),
      usageRows,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function tuiSessionBoot(
  sessionId: string | undefined,
  options: TuiRunOptions,
  context: Context,
  notices: BootNotices,
  turnCell: TurnCell,
): SessionBoot {
  return new SessionBoot(
    {
      command: 'tui',
      context,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.toolSelection === undefined
        ? {}
        : { tools: options.toolSelection }),
      ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
      ...(options.noSkills === undefined ? {} : { noSkills: options.noSkills }),
      ...(options.skillsList === undefined
        ? {}
        : { cliSkills: options.skillsList }),
      ...(options.dangerouslySkipApprovals === undefined
        ? {}
        : { dangerouslySkipApprovals: options.dangerouslySkipApprovals }),
      // The answer seat: with the overlay's surface attached, `kubic tui`
      // is the command that can actually collect a verdict on a challenged
      // call instead of refusing it unseen.
      ...(options.answer === undefined ? {} : { answer: options.answer }),
      currentTurn: () => turnCell.supplier?.(),
    },
    {
      sessionsRoot: options.sessionsRoot,
      env: options.env,
      classes: options.classes,
      policySource: options.policySource,
      approvals: options.approvals,
      policy: options.policy,
      models: options.models,
      model: options.model,
      streamTuning: options.streamTuning,
      thinking: options.thinking,
      compaction: options.compaction,
      agentId: options.agentId,
      journalRetention: options.journalRetention,
      reconcileOutOfScope: options.reconcileOutOfScope,
      systemPromptSection: options.systemPromptSection,
      projectInstructions: options.projectInstructions,
      projectProvidersRefusal: options.projectProvidersRefusal,
      sessionTeam: options.sessionTeam,
      modelPolicy: options.modelPolicy,
      trustProject: options.trustProject,
      skills: options.skills,
      roles: options.roles,
    },
    {
      ...(options.debug === undefined ? {} : { debug: options.debug }),
      warn: (line) => notices.warnings.push(line),
      modelNotice: (line) => notices.model.push(line),
      thinkingNotice: (line) => notices.model.push(line),
      // An unresolvable explicit --skill is a transcript notice, never only
      // a line on the debug sink the TUI drops — so a typo cannot read as a
      // loaded skill.
      skillsWarn: (line) => {
        notices.transcript.push(`warning: ${line}`);
      },
      // No debug footer on the alt-screen: loader lines are dropped (the
      // block itself is observable).
      skillsLog: () => undefined,
      instructionsNotice: (line) =>
        notices.warnings.push(`project instructions: ${line}`),
      // A redaction mid-session lands in the transcript the loop drains.
      dlpNotice: (line) => notices.transcript.push(line),
    },
  );
}

// What the loop reads from a booted lane: its identity and running model,
// the session readers, the posture and the reconciliation hooks, and the
// loop surface itself.
async function describeBoot(
  boot: SessionBoot,
  lane: Lane,
  options: TuiRunOptions,
  context: Context,
  notices: BootNotices,
  turnCell: TurnCell,
): Promise<Omit<TuiLaneBoot, 'usageRows' | 'close'>> {
  const id = boot.id;
  const models = boot.models as MutableModels;
  const installed = boot.installed as InstalledPolicy;
  const store = boot.store as SessionStore;
  const env = boot.env as ExecutionEnv;
  const role = boot.role;
  const pendingNotice = await abortPendingTurn(lane, context);
  // The model the lane actually runs: the status bar, the
  // usage rows the turn runner records and the context gauge all
  // read this.
  const running = await liveModelOf(lane, context);
  // The thinking level the lane actually
  // runs — read back from the committed agent document, exactly the
  // value whose clamp (or keep) the boot notices already reported. The
  // seed shows this from the first frame; a stale seed would
  // disagree with the lane until the first turn's refresh.
  const thinking = (await lane.conversation.agent(context)).thinkingLevel;
  // The invocable skills (admitted + gate-passed, hidden included,
  // withheld excluded), so `/skill:` expands and completes against the
  // boot's gated set.
  const invocable = boot.skills?.invocable ?? [];
  const fullAccess = installed.posture.fullAccess;
  const bootWarnings = [
    ...notices.warnings,
    ...(fullAccess
      ? [boot.fullAccessWarning ?? fullAccessInForceWarning(id)]
      : []),
    // The loader lines for skipped skills ride the boot notices once; a
    // clean boot stays silent.
    ...optional(describeSkillSkips(boot.skills?.skipped ?? [])),
  ];
  return {
    sessionId: id,
    model: `${running.provider}/${running.id}`,
    // The injected sink, threaded to the turn runner
    // for its fault and token lines (absent in prod — no --debug flag).
    debug: options.debug,
    turnSpans: turnSpans(boot, id),
    thinking: thinking ?? 'off',
    // The resolved set travels on the boot so `/scoped-models` can report
    // it.
    scopedModels:
      role === undefined
        ? undefined
        : {
            role: role.resolved.name,
            models:
              role.resolved.models === undefined
                ? undefined
                : [...role.resolved.models],
          },
    // The gauge needs the running model's window; a catalog
    // that does not know it yields none and the gauge stays off.
    contextLimits: contextLimitsOf(models, running.provider, running.id),
    journal: boot.journal as FileJournalStore,
    keySourceOf: (provider: string) =>
      boot.assembled?.providers.get(provider)?.authSource,
    ...sessionReaders(store, boot.root, env.cwd, id, context),
    // `/undo` resolves journal paths against the workspace root.
    cwd: env.cwd,
    // The turn boundary of `allow all edits this turn`.
    endApprovalTurn: () => installed.endTurn?.(),
    editsApprovedThisTurn: () => installed.editsApprovedThisTurn?.() === true,
    setFullAccess: (enabled) => toggleFullAccess(installed, id, enabled),
    reconcile: () => {
      boot.reconciliation?.sweep();
    },
    rebaseline: (turn: number) => {
      boot.reconciliation?.rebaseline(turn);
    },
    // The lane samples this cell per tool call (through
    // LaneBootOptions.currentTurn) — installing the loop's counter here
    // keeps tool entries on the sweep numbering without touching boot.
    setCurrentTurnSupplier: (supplier: () => number | undefined) => {
      turnCell.supplier = supplier;
    },
    listFiles: workspaceFileLister(env),
    // Explicit skill invocation over the invocable
    // set — hidden skills included, withheld skills excluded (their
    // names resolve unknown, and completion never lists them).
    skillInvocation: {
      names: invocable.map((skill) => skill.name),
      invoke: (name: string, instructions?: string) =>
        expandSkillInvocation(invocable, name, instructions),
    },
    ...(notices.model.length === 0
      ? {}
      : { modelNotice: notices.model.join('; ') }),
    ...(pendingNotice === undefined ? {} : { pendingNotice }),
    fullAccess,
    ...(bootWarnings.length === 0 ? {} : { notices: bootWarnings }),
    approvalsSkipped: installed.approvalsSkipped,
    loop: bootedLoop({
      boot,
      lane,
      models,
      options,
      context,
      root: boot.root,
      id,
      cwd: env.cwd,
      // The offered skill names, for the trajectory's resources.
      skillNames:
        boot.skills === undefined ? [] : offeredSkillNames(boot.skills),
      transcriptNotices: notices.transcript,
    }),
  };
}

// A turn a dead process left open would sit until its guarded resume timed
// out; the interactive policy is the durable abort — its approvals would
// need the overlay, which is not on screen yet, and the operator is present
// to re-send. The interrupted prompt's own text is named too when the dead
// process had already placed it (the "resume this very prompt" rule): the
// operator sees WHAT was interrupted. The outcome is named in the footer
// from the first render.
async function abortPendingTurn(
  lane: Lane,
  context: Context,
): Promise<string | undefined> {
  const pending = await inspectPending(lane, context);
  if (!pending.pending) return undefined;
  const interrupted = await pendingInputText(lane, context);
  const settlement = await settlePending(lane, 'abort', {
    context,
    kills: lane.kills,
  });
  const notice = describePendingSettlement(pending.summary, settlement);
  return interrupted === undefined
    ? notice
    : `${notice} — interrupted prompt: ${interrupted}`;
}

// Per-turn spans next to the headless artifact — the
// session's spans.jsonl carries one run span per TUI turn plus its
// tool spans. Best-effort: telemetry never fails a turn or a boot.
function turnSpans(boot: SessionBoot, id: string): TuiLaneBoot['turnSpans'] {
  return {
    turns: new TurnSpans(id),
    write: (artifact: string): void => {
      try {
        boot.bridge.appendFile(join(id, 'spans.jsonl'), artifact, {
          mode: 0o600,
        });
      } catch {
        // A failed artifact write is not a turn failure.
      }
    },
  };
}

// `/resume` and the palette list THIS boot's sessions store, and `/fork`
// forks it.
function sessionReaders(
  store: SessionStore,
  root: string,
  workspace: string,
  id: string,
  context: Context,
): Pick<TuiLaneBoot, 'summarizeSessions' | 'listSessions' | 'forkAt'> {
  return {
    // A session records the workspace it booted in (the boot env's cwd),
    // so "this project" is matched against the same directory. Each
    // summary parses a session file, so one read serves the palette and
    // `/resume` for SESSION_SUMMARY_TTL_MS.
    summarizeSessions: cachedSummaries((exclude) =>
      summarizeProjectSessions({
        sessionsRoot: root,
        workspace,
        ...(exclude === undefined ? {} : { exclude }),
        context,
      }),
    ),
    listSessions: async () => {
      const rows = await listSessions(store, context);
      return rows.map((row) => ({
        id: row.id,
        ...(row.meta?.cwd === undefined ? {} : { cwd: row.meta.cwd }),
        ...(row.meta?.createdAt === undefined
          ? {}
          : { createdAt: row.meta.createdAt }),
      }));
    },
    forkAt: async (at: number) =>
      (await forkSession(store, id, { at }, context)).id,
  };
}

// The toggle's host path. `installed.setFullAccess` flips
// the live posture the ask reads and writes posture.json + the
// row; the returned grant carries the warning the caller reports.
function toggleFullAccess(
  installed: InstalledPolicy,
  id: string,
  enabled: boolean,
): SessionFullAccessGrant {
  const command = `tui /approvals ${enabled ? 'on' : 'off'}`;
  installed.setFullAccess?.(enabled, `kubic ${command}`);
  return enabled
    ? {
        posture: installed.posture,
        warning: `full access enabled for session ${id} — every challenged call runs without asking`,
      }
    : {
        posture: installed.posture,
        warning: `full-access revoked for session ${id} — every challenged call asks again`,
      };
}

function optional(line: string | undefined): string[] {
  return line === undefined ? [] : [line];
}

// A boot refusal as the error the TUI command maps to its exit code: a bad
// tool selection is a usage error (exit 2), no usable model a provider
// error (exit 6), everything else its own error.
function bootRefusalError(refusal: BootRefusal): unknown {
  switch (refusal.kind) {
    case 'usage':
      return new ToolSelectionError(refusal.message);
    case 'provider':
      return new ModelSelectError(refusal.message);
    case 'store':
      return refusal.error;
    case 'failed':
      return refusal.cause ?? new Error(refusal.message);
    case 'cancelled':
      return new Error('the boot was cancelled');
  }
}

// A session's `pi.usage` buckets as status-bar rows. A model
// bucket is keyed `provider/modelId` — split at the FIRST slash, because a
// model id may itself contain slashes (openrouter/anthropic/…) — and a tool
// bucket has no provider/model identity, so it is labelled `tool:<name>`
// exactly as `kubic cost` labels it. The bar reads only the counters; the
// names keep the row shape honest.
/** @internal */
export function statusRowsFromSessionUsage(
  rows: readonly SessionUsageRow[],
): StatusUsageRow[] {
  return rows.map((row) => {
    if (row.kind === 'tool') {
      return { provider: 'tool', model: row.key, usage: row.usage };
    }
    const at = row.key.indexOf('/');
    return {
      provider: at === -1 ? '' : row.key.slice(0, at),
      model: at === -1 ? row.key : row.key.slice(at + 1),
      usage: row.usage,
    };
  });
}

// How long one read of the session summaries serves the palette
// and `/resume` (a summary parses a whole session file).
/** @internal */
export const SESSION_SUMMARY_TTL_MS = 30_000;

/** @internal */
export function cachedSummaries(
  read: (exclude?: string) => Promise<readonly SessionSummary[]>,
  now: () => number = Date.now,
): (exclude?: string) => Promise<readonly SessionSummary[]> {
  let cached:
    | {
        readonly exclude: string | undefined;
        readonly at: number;
        readonly rows: Promise<readonly SessionSummary[]>;
      }
    | undefined;
  return (exclude) => {
    if (
      cached !== undefined &&
      cached.exclude === exclude &&
      now() - cached.at < SESSION_SUMMARY_TTL_MS
    ) {
      return cached.rows;
    }
    const rows = read(exclude);
    cached = { exclude, at: now(), rows };
    // A failed read is not kept: the next ask tries again.
    rows.catch(() => {
      if (cached?.rows === rows) cached = undefined;
    });
    return rows;
  };
}

// The `@` mention source — every file the find/grep walk would
// visit (gitignore rules honoured, node_modules/.git skipped, bounded),
// workspace-relative. Cached for a short window so a burst of keystrokes
// walks once; a failed walk lists nothing.
/** @internal */
export const FILE_LIST_TTL_MS = 2000;

/** @internal */
export function workspaceFileLister(
  env: { readonly fs: FileSystem },
  now: () => number = Date.now,
): () => readonly string[] {
  let cached: readonly string[] = [];
  let at = Number.NEGATIVE_INFINITY;
  return () => {
    if (now() - at < FILE_LIST_TTL_MS) return cached;
    try {
      cached = walkFiles(env.fs, '.')
        .entries.filter((entry) => !entry.isDirectory)
        .map((entry) => entry.path)
        .sort();
    } catch {
      cached = [];
    }
    at = now();
    return cached;
  };
}
