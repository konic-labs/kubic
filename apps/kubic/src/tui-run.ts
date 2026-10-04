// `kubic tui` (issue #75, prompt loop #88): interactive alt-screen over the
// solo lane. The composition root owns every side effect: it boots the real
// solo lane (same session/model setup as the headless runner), opens the
// alt-screen on the replicated presentation, routes keyboard input through
// the tui controller, drives the lane for whatever the user submits, feeds
// lane events into the tree and usage rows into the status bar, and restores
// the main screen with the final document printed — on quit, on a signal,
// and exactly once. `kubic run` is untouched (headless regression:
// tui-command.test.ts + binary exit codes).
//
// Cancellation (§18, issue #88; durable in #395): Ctrl-C during a turn aborts
// the in-flight conversation through the lane's own durable abort
// (conversation.abort + the conversation's kill drain, D6.2) and keeps the
// session alive; a second Ctrl-C quits. While idle the first Ctrl-C quits.
// Esc and Ctrl-D-on-an-empty-draft quit too, so no honoured key is a silent
// no-op.

import { randomUUID } from 'node:crypto';
import { homedir, constants as osConstants } from 'node:os';
import { join } from 'node:path';
import type { PermissionClasses } from '../../../packages/agents/src/policy.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import {
  FileJournalStore,
  type JournalRetention,
} from '../../../packages/exec/src/journal.js';
import { diffEntries } from '../../../packages/exec/src/journal-diff.js';
import {
  beginReconciliation,
  type RunReconciliation,
} from '../../../packages/exec/src/journal-reconcile.js';
import {
  type ApprovalRequest,
  type ApprovalVerdict,
  enableSessionFullAccess,
  fullAccessInForceWarning,
  type InstalledSoloPolicy,
  installSoloPolicy,
  type SoloApprovalConfig,
} from '../../../packages/host/src/approvals.js';
import { createLedgerModelKeyResolver } from '../../../packages/host/src/config/model-key-audit.js';
import type { RuntimeOrchestrator } from '../../../packages/host/src/config/runtime.js';
import {
  FAUX_FOOTER,
  FAUX_MODEL_ID,
  FAUX_PROVIDER_ID,
  fauxProviderActive,
} from '../../../packages/host/src/faux-provider.js';
import { buildOrchestratorWorktreeNotice } from '../../../packages/host/src/limits/orchestrator-notice.js';
import {
  shouldEmitSoloNotice,
  soloTuiLine,
} from '../../../packages/host/src/limits/solo-warning.js';
import {
  type AssembledModels,
  assembleModels,
} from '../../../packages/host/src/models-cli.js';
import {
  readSessionUsage,
  type SessionUsageRow,
} from '../../../packages/host/src/ops/cost/cost-cli.js';
import {
  buildOrchestratorRefusal,
  resolveOrchestratorMode,
} from '../../../packages/host/src/orchestrator/manager.js';
import type { ApprovalSnapshot } from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import {
  type EffectivePolicy,
  hasModelPolicy,
  hasToolPolicy,
  isModelAllowed,
  isToolAllowedByEnterprise,
} from '../../../packages/host/src/policy/enterprise.js';
import type { RoleLayerInput } from '../../../packages/host/src/roles/resolver.js';
import {
  roleDocPath,
  rolePromptFor,
  selectRole,
} from '../../../packages/host/src/roles/roles-boot.js';
import {
  mapCaughtErrorToTerminus,
  RUN_EXIT_FAILED,
  RUN_EXIT_OK,
  RUN_EXIT_PROVIDER_PROBE_FAILED,
  RUN_EXIT_USAGE,
  RUN_EXIT_WORKSPACE_UNAVAILABLE,
  type RunTerminusKind,
  SESSION_ID_PATTERN,
} from '../../../packages/host/src/run-cli.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import { bootSkills } from '../../../packages/host/src/skills-boot.js';
import type { RunOutcome } from '../../../packages/host/src/trajectory/run-trajectory.js';
import { createApprovalSurface } from '../../../packages/tui/src/approval-surface.js';
import type { LaneEntryLike } from '../../../packages/tui/src/lane-cells.js';
import type { Screen } from '../../../packages/tui/src/screen.js';
import { bootScreen } from '../../../packages/tui/src/screen.js';
import type {
  StatusMode,
  StatusUsageRow,
} from '../../../packages/tui/src/status-bar.js';
import {
  type ColorLevel,
  createTuiTheme,
  detectColorLevel,
  setTuiTheme,
  tuiTheme,
} from '../../../packages/tui/src/theme.js';
import {
  createTuiApp,
  type JournalChangeLike,
  type TuiApp,
  type TuiSubmitOutcome,
} from '../../../packages/tui/src/tui-app.js';
import type { Terminal } from '../../../packages/tui/src/tui-boundary.js';
import {
  isKeyRelease,
  isKeyRepeat,
  ProcessTerminal,
  parseKey,
} from '../../../packages/tui/src/tui-boundary.js';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
  type ManualCompactionOptions,
  type ManualCompactionOutcome,
  parseCompactCommand,
  runManualCompaction,
} from '../../../packages/worker/src/compaction.js';
import {
  abortLane,
  forgetLaneKills,
  type OperationKillRegistry,
} from '../../../packages/worker/src/lane/abort.js';
import type {
  KubicInboxItem,
  KubicLaneEvent,
  LaneEventSink,
} from '../../../packages/worker/src/lane/events.js';
import { subscribeLaneEvents } from '../../../packages/worker/src/lane/events.js';
import {
  describePendingSettlement,
  inspectPending,
  pendingInputText,
  settlePending,
} from '../../../packages/worker/src/lane/pending.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import {
  bootSoloLane,
  type SoloLane,
} from '../../../packages/worker/src/lane/solo.js';
import {
  entriesToTranscript,
  readConversationEntries,
  type TranscriptItem,
} from '../../../packages/worker/src/lane/transcript.js';
import {
  runTurn,
  TURN_BUSY_REASON,
  type TurnOutcome,
  turnLaneRecord,
} from '../../../packages/worker/src/lane/turn.js';
import {
  ModelSelectError,
  type ModelSelection,
  parseModelFlag,
} from '../../../packages/worker/src/model-select.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  ConversationBusy,
  type EntryRecord,
  type MutableModels,
  type SubmissionId,
} from '../../../packages/worker/src/pi-boundary.js';
import {
  type runtimeLaneDeps,
  selectModelUnderPolicy,
} from './config-runtime.js';
import { assistantSummary, NO_ASSISTANT_TEXT_SUMMARY } from './headless-run.js';
import {
  hasExplicitModelSelection,
  roleModelSelection,
} from './model-projection.js';
import { persistRunTrajectory } from './run-trajectory.js';
import {
  createProdTuiOrchestrator,
  mergeSeatFromAnswer,
  workerAskSeatFromAnswer,
} from './tui-orchestrator.js';

// The interaction surface the root shares with the app (issue #96): the seat
// the installed policy consults and the surface the loop renders are the SAME
// object, so a verdict collected on screen is the verdict the lane receives.
export type TuiApprovalSeat = (
  request: ApprovalRequest,
  // Issue #232: the installed service's own bound. The surface withdraws the
  // ask it is showing when it aborts, so a timed-out question never blocks the
  // next one.
  signal?: AbortSignal,
) => Promise<ApprovalVerdict | undefined>;
// The lane surface the loop drives (pi-durable, #395). Narrow on purpose:
// one turn (submit + wait), the conversation's committed event stream, the
// transcript read, and the abort/drain pair — nothing else. Every member is
// a real lane call, so the prod wiring is a straight passthrough.
export interface TuiLaneLoop {
  /**
   * #395: one turn on the durable lane (lane/turn.ts). The busy policy is
   * the caller's: the loop's own submits use `reject` (a race with a
   * settling turn fails loudly), while a busy Enter passes `followUp` and
   * the steer key `steer`, so pi-durable queues them in the conversation's
   * inbox (#334).
   */
  runTurn(
    prompt: string,
    opts: {
      requestId: string;
      context: Context;
      whenBusy?: 'reject' | 'followUp' | 'steer';
      // #334: the admitted submission's id and whether it was placed at
      // once or queued in the inbox — the busy latch follows placed work.
      onSubmitted?: (submissionId: string, state: 'placed' | 'queued') => void;
    },
  ): Promise<TurnOutcome>;
  /**
   * #330: one manual compaction (`/compact [focus]`), admitted and awaited
   * to terminal — the pre-cut context estimate, or the harness' own failure.
   * Absent means this boot has no live lane to compact (the orchestrator
   * viewer shell).
   */
  compact?(
    focus: string | undefined,
    context: Context,
    options?: ManualCompactionOptions,
  ): Promise<ManualCompactionOutcome>;
  /**
   * #398/D2: the conversation's committed lane events. The attach snapshot
   * REPLACES the feed's committed entries; every later event is appended.
   */
  subscribe(
    sink: LaneEventSink,
    context: Context,
  ): Promise<() => Promise<void>>;
  /**
   * #400/D6.5: the live conversation's transcript entries, transcript order
   * (the one entry read path; never a per-event re-read).
   */
  entries(context: Context): Promise<ReadonlyArray<EntryRecord>>;
  /**
   * #395/D6.2: abort the conversation and drain its kills — every kill
   * attempted, failures aggregated into one throw. A refused abort is not
   * silent: the cancel path reports it on the footer.
   */
  abort(context: Context): Promise<void>;
  /**
   * #395/D6.2: a settled turn's kills are FORGOTTEN, not run — a kept
   * background job outlives Kubic, and a recycled pid must not receive a
   * stale group SIGTERM. The quit drain still has the registry backstop.
   */
  forgetKills(): void;
  /** D1: the kill registry key — String(conversation.id). */
  killsKey: string;
  kills: OperationKillRegistry;
  context: Context;
  /**
   * Issue #227: the live model switch (`/model`). The prod boot resolves
   * the id against the live catalog (an unknown provider or model fails by
   * name), commits the change through conversation.configure, and returns
   * the live read-back. A viewer-shell stub may omit it; `/model` then says
   * so instead of pretending to switch.
   */
  switchModel?: (
    model: { provider: string; modelId: string },
    context: Context,
  ) => Promise<string>;
  /** The live model label (provider/id) — the status bar and usage rows. */
  model?: (context: Context) => Promise<string>;
  // Issue #347: the resolved model's context window and compaction
  // threshold, so the gauge follows a `/model` switch. Absent (injected
  // viewer loops) leaves the seeded limits in place — the gauge never keeps
  // a window that belongs to a model the session no longer runs.
  contextLimits?: (provider: string, id: string) => ContextLimits;
  // §46 trajectory per settled turn (issue #383): the prod boot persists
  // <sessions-root>/<id>/trajectory.json here. Absent (injected test loops)
  // means no trajectory; a failure never changes the turn's outcome.
  recordTurn?: (turn: TuiTurnRecord) => Promise<void> | void;
}

// One settled turn as the runner saw it: the prompt, when it started, the
// footer outcome, and — when the lane settled it — the durable TurnOutcome
// that is the §46 lane record's source (completed/failed/aborted, the §52
// reason and the human message; D6.1).
export interface TuiTurnRecord {
  prompt: string;
  startedAt: number;
  outcome: TuiTurnOutcome;
  turn?: TurnOutcome;
}

// The §46 lane record of one settled turn: the durable outcome kind and, for
// a failure, the classified error (#395/D6.1, `turnLaneRecord`).
export type TuiTurnLaneRecord = ReturnType<typeof turnLaneRecord>;

// The §78 terminus of a durable failure (#395): the §52 reason code carries
// the classification the old terminal-status mapping used to derive, so the
// TUI trajectory keeps the same envelope vocabulary as `kubic run`. A code
// this map does not know stays a plain failure — never an invented terminus.
function terminusOfFailure(reason: string): RunTerminusKind {
  switch (reason) {
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'approval_denied':
      return 'approval_denied';
    case 'approval_timed_out':
      return 'approval_timed_out';
    case 'workspace_failed':
      return 'workspace_unavailable';
    // Issue #155: a mid-run provider error is a task failure with its own
    // terminus, never the pre-run probe (`provider_probe_failed`, exit 6).
    case 'provider_transient':
      return 'provider_transient';
    case 'provider_auth':
      return 'provider_auth';
    default:
      return 'failed';
  }
}

// Issue #334: a turn's own options. The solo lane queues a busy follow-up
// in the conversation's inbox (`followUp`) or joins the running work with a
// steer (`steer`); `onSubmitted` reports the admitted submission's id the
// moment the harness takes it, so the loop can key its `queued: …` rows.
export interface TuiTurnOptions {
  whenBusy?: 'followUp' | 'steer';
  onSubmitted?: (submissionId: string, state: 'placed' | 'queued') => void;
}

// One turn's driver, whichever lane owns it (issue #327): the solo
// TuiTurnRunner already has this shape, and TuiOrchestratorTurn mirrors it,
// so the input loop's busy latch, Ctrl-C handling and quit drain stay one
// contract instead of two dispatch paths.
export interface TuiTurnDriver {
  isRunning(): boolean;
  isCancelling(): boolean;
  // False means Ctrl-C cannot cancel this turn: the runner quits instead of
  // showing a "cancelling…" that the lane cannot honour. The solo lane
  // always can; an orchestrator run only when its drive exposes `abort`.
  canCancel(): boolean;
  run(prompt: string, options?: TuiTurnOptions): Promise<TuiTurnOutcome>;
  cancel(): Promise<boolean>;
  drainForQuit(bound: Promise<void>): Promise<void>;
  /**
   * #330: the settlement line this driver reports INSTEAD of the generic turn
   * outcome — a compaction is not a turn (`compacted: …`), and its failure
   * text is the harness' own. Absent means the loop's `footerForOutcome`.
   */
  settlementFooter?(): string | undefined;
}

// Issue #327: the orchestrator lane a session can switch to with Ctrl-G.
// `run` IS the manager-lane path `kubic orchestrate` drives (one objective
// in, one settle out); `report` receives the run's own output lines for the
// transcript. Absent `abort` means cancellation can only stop waiting, not
// the run — the prod drive always provides it.
export interface TuiOrchestratorRun {
  run(
    objective: string,
    report?: (line: string) => void,
  ): Promise<TuiTurnOutcome>;
  // Issue #327: best-effort cancellation. The prod drive has none — an
  // orchestration is stopped by the manager's own signal guard (live
  // workers are reaped on process exit); a drive that can abort stops the
  // run itself.
  abort?: () => Promise<void> | void;
}

// One orchestrator turn: drives the manager-lane run for an objective.
// Cancellation asks the drive to abort when it can; the orchestrate path's
// own signal guard reaps live workers on process exit otherwise. The drain
// waits for the run to settle, bounded.
export class TuiOrchestratorTurn implements TuiTurnDriver {
  private readonly drive: TuiOrchestratorRun;
  private readonly onReport: (line: string) => void;
  private running: Promise<TuiTurnOutcome> | undefined;
  private aborted = false;

  constructor(drive: TuiOrchestratorRun, onReport: (line: string) => void) {
    this.drive = drive;
    this.onReport = onReport;
  }

  isRunning(): boolean {
    return this.running !== undefined;
  }

  isCancelling(): boolean {
    return this.aborted && this.isRunning();
  }

  canCancel(): boolean {
    return this.drive.abort !== undefined;
  }

  // Issue #334: the orchestrator lane has one objective and no inbox, so a
  // passed option (only busy submits carry one, and those are refused for
  // this driver) never applies; the signature is the shared driver's.
  run(prompt: string, _options?: TuiTurnOptions): Promise<TuiTurnOutcome> {
    this.aborted = false;
    const running = this.drive.run(prompt, this.onReport).finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  async cancel(): Promise<boolean> {
    if (!this.isRunning()) return false;
    // No abort seam means the manager run cannot be stopped from here; say
    // so (false) instead of latching a "cancelling…" that never resolves.
    if (this.drive.abort === undefined) return false;
    this.aborted = true;
    await this.drive.abort();
    return true;
  }

  async drainForQuit(bound: Promise<void>): Promise<void> {
    if (!this.isRunning()) return;
    this.aborted = true;
    // The abort is a call into the drive and can hang: the bound covers it,
    // not only the wait for the run to settle (issue #312).
    await Promise.race([Promise.resolve(this.drive.abort?.()), bound]);
    const settled = (this.running ?? Promise.resolve()).then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([settled, bound]);
  }
}

// Issue #330: `/compact [focus]` is a lane operation, not a prompt — Pi's
// manual compaction task (lane/compaction.ts). It is driven through the same
// busy/cancel wrapper as a turn, so the spinner shows, Ctrl-C aborts the
// conversation (Pi settles the task aborted/orphaned) and the quit drain
// waits on it; its settlement line is the compaction's own, never a turn
// outcome.
export class TuiCompactionTurn implements TuiTurnDriver {
  private readonly loop: TuiLaneLoop;
  private readonly focus: string | undefined;
  private running: Promise<TuiTurnOutcome> | undefined;
  private outcome: ManualCompactionOutcome | undefined;
  private aborted = false;

  constructor(loop: TuiLaneLoop, focus: string | undefined) {
    this.loop = loop;
    this.focus = focus;
  }

  isRunning(): boolean {
    return this.running !== undefined;
  }

  isCancelling(): boolean {
    return this.aborted && this.isRunning();
  }

  canCancel(): boolean {
    return true;
  }

  // The prompt argument is the submitted draft; the focus it carries was
  // parsed before construction, so the command text never reaches the model.
  run(_prompt: string): Promise<TuiTurnOutcome> {
    this.aborted = false;
    const compact = this.loop.compact;
    if (compact === undefined) {
      return Promise.resolve({
        status: 'failed',
        detail: 'compaction needs the solo lane',
      });
    }
    const running = (async (): Promise<TuiTurnOutcome> => {
      const outcome = await compact(this.focus, this.loop.context, {
        // A Ctrl-C that landed while the task was still being admitted hit
        // an idle conversation: replay it now that the task exists, so the
        // cancel is never lost (#330 review).
        onAdmitted: async () => {
          if (this.aborted) await this.loop.abort(this.loop.context);
        },
      });
      this.outcome = outcome;
      if (outcome.status === 'completed') return { status: 'completed' };
      // Pi's own "nothing to compact" completion: the turn succeeded, the
      // footer says what really happened (no entry was placed).
      if (outcome.status === 'nothing') return { status: 'completed' };
      if (outcome.status === 'aborted' || outcome.status === 'orphaned') {
        return { status: 'cancelled' };
      }
      return {
        status: 'failed',
        detail: outcome.error ?? `compaction ${outcome.status}`,
      };
    })().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  settlementFooter(): string | undefined {
    const outcome = this.outcome;
    if (outcome === undefined) return undefined;
    if (outcome.status === 'completed') {
      return `compacted: ${outcome.tokensBefore} tokens → summary`;
    }
    if (outcome.status === 'nothing') {
      // Pi found no older history to cut: no summary entry was placed, and
      // saying `compacted` would claim work that never happened.
      return `nothing to compact: ${outcome.tokensBefore} tokens`;
    }
    if (outcome.status === 'aborted' || outcome.status === 'orphaned') {
      return 'compaction cancelled';
    }
    return `compaction failed: ${outcome.error ?? outcome.status}`;
  }

  async cancel(): Promise<boolean> {
    if (!this.isRunning()) return false;
    this.aborted = true;
    // The durable stop: Pi marks the compaction task and settles it aborted.
    await this.loop.abort(this.loop.context);
    return true;
  }

  async drainForQuit(bound: Promise<void>): Promise<void> {
    if (!this.isRunning()) return;
    this.aborted = true;
    await Promise.race([
      this.loop.abort(this.loop.context).catch(() => undefined),
      bound,
    ]);
    const settled = (this.running ?? Promise.resolve()).then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([settled, bound]);
  }
}

export interface TuiLaneBoot {
  sessionId: string;
  model: string;
  close?: () => Promise<void> | void;
  // Issue #113: the session's journal store, exposed so callers (and
  // tests) can observe the retention policy the boot installed. The loop
  // itself uses the lane's own recording; this is the same store.
  journal?: FileJournalStore;
  // Issue #311 (§42.5): the mid-session reconcile sweep. A `bash` write is not
  // intercepted by the file tools, so it reaches the journal only through the
  // sweep; the root runs it when a turn that used the shell settles, so the
  // Ctrl-O / Ctrl-R panels show that change now instead of at quit. Safe to
  // repeat (a path's expected state is its last journaled entry, so an
  // unchanged tree appends nothing); a failure never reaches the loop.
  reconcile?: () => void;
  // Issue #307: the installed policy's own full-access predicate (the SAME
  // one its ask auto-approves on), read for the mode indicator at boot and
  // after every turn. Absent (a viewer boot with no policy) means approvals
  // are in force — there is no policy that could skip them.
  approvalsSkipped?: () => boolean;
  // Issue #88: the boot hands the loop its drive surface. Injected boots in
  // the existing #75 tests omit it — the loop then runs as the viewer shell,
  // which keeps the screen/restore contract testable on its own.
  loop?: TuiLaneLoop;
  // Issue #147: the outcome line for a turn a crashed process left open on
  // this session (durably aborted at boot). Shown in the editor footer from
  // the first render; absent when nothing was pending.
  pendingNotice?: string;
  // Issue #148: the model reconciliation line for a resumed session whose
  // stored model differs from the selection (kept or switched). Shown in
  // the footer from the first render alongside any pending-op notice.
  modelNotice?: string;
  // Issue #308 (§41.4): the approval posture the lane was installed with —
  // true seeds the status bar's OFF indicator from the first frame.
  fullAccess?: boolean;
  // Issue #308: warnings to print on stderr before the alt-screen opens
  // (the full-access grant/in-force warning).
  notices?: string[];
  // Issue #327: the orchestrator lane this session can switch to with
  // Ctrl-G. The drive is the manager-lane path `kubic orchestrate` runs;
  // worker approval asks reach the TUI overlay through the seat the
  // composition root wires into the orchestrate deps. Absent (viewer boots,
  // injected fake lanes) means the session is solo-only: toggling to
  // orchestrator then refuses by name at submit time, never a silent
  // fallback into solo.
  orchestrator?: TuiOrchestratorRun;
  // Issue #346: the session's committed spend, read from its `pi.usage`
  // ledger before the first frame, so a resumed session never renders
  // $0.00. Absent for a fresh session and for injected viewer boots.
  usageRows?: StatusUsageRow[];
  // Issue #347: the running model's context window and compaction threshold,
  // so the status bar's gauge can render from the first committed request.
  // Absent when the catalog does not know the window.
  contextLimits?: ContextLimits;
}

// Issue #347: a model's context window and the token level at which the solo
// lane compacts (window − reserve, the same policy the harness reads, #399).
// `undefined` means the catalog does not know the window: the gauge then
// stays off rather than showing a made-up percentage. #239 will make the
// reserve configurable; until then this is Kubic's default.
export interface ContextLimits {
  contextWindow?: number;
  compactionThreshold?: number;
}

export function contextLimitsOf(
  models: MutableModels,
  provider: string,
  id: string,
): ContextLimits {
  const definition = models
    .getModels(provider)
    .find((model) => model.id === id);
  const contextWindow = definition?.contextWindow;
  if (contextWindow === undefined || !(contextWindow > 0)) return {};
  return {
    contextWindow,
    compactionThreshold:
      contextWindow -
      effectiveReserveTokens(contextWindow, DEFAULT_RESERVE_TOKENS),
  };
}

// Issue #346: a session's `pi.usage` buckets as status-bar rows. A model
// bucket is keyed `provider/modelId` — split at the FIRST slash, because a
// model id may itself contain slashes (openrouter/anthropic/…) — and a tool
// bucket has no provider/model identity, so it is labelled `tool:<name>`
// exactly as `kubic cost` labels it. The bar reads only the counters; the
// names keep the row shape honest.
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

export interface TuiRunDeps {
  out: (line: string) => void;
  // stderr: the `error: …` lines of a refused id or a failed lane boot.
  // Absent means stdout (library callers with one channel).
  err?: (line: string) => void;
  createTerminal: () => Terminal;
  // `answer` is the seat the boot's installed policy must consult (issue
  // #96). It is an ARGUMENT rather than a deps field because the seat and the
  // rendered surface are one object created by runTuiCommand: a boot that
  // closed over the deps would never see it, which is exactly the bug the
  // end-to-end test caught (the overlay never appeared, the call was refused
  // with NO_ANSWER_SURFACE_REASON). The prod boot forwards it to
  // installSoloPolicy; a boot may ignore it (the viewer shell does).
  bootLane: (
    sessionId?: string,
    answer?: (
      request: ApprovalRequest,
      // Issue #232: the installed service's bound reaches the seat as an
      // AbortSignal, so the seat can withdraw the ask it is showing.
      signal?: AbortSignal,
    ) => Promise<ApprovalVerdict | undefined>,
    // Issue #113: the parsed parity flags travel with the boot call —
    // the command shell owns parsing, the boot owner owns the defaults.
    options?: TuiBootFlags,
  ) => Promise<TuiLaneBoot>;
  // Issue #311: observes a failed journal-panel read or apply (tests; the
  // loop itself swallows it — the journal is observed, never a gate).
  journalFeedError?: (error: unknown) => void;
  // Issue #312: the bound on the quit-time drain (a turn still running when
  // the operator quits is aborted, its kills run, and the loop waits at most
  // this long for it to settle before the sweep and session close). Absent
  // means TUI_DRAIN_TIMEOUT_MS; the timer is injectable so tests are
  // deterministic. It returns a canceller.
  drainTimeoutMs?: number;
  setDrainTimer?: (ms: number, fire: () => void) => () => void;
  // Issue #313: the process-level event source — SIGINT/SIGTERM/SIGHUP and
  // uncaughtException/unhandledRejection. Absent means the real process;
  // tests inject an emitter so the runner itself is never signalled.
  signals?: TuiProcessEvents;
  // Issue #313: how a fatal error (an exception in input or render, an
  // unhandled rejection) ends the process once the terminal is restored.
  // Absent means process.exit; tests inject a recorder.
  exit?: (code: number) => void;
  // Issue #315: the approval overlay's arming delay and the clock it runs
  // on. Absent means APPROVAL_ARMING_MS on the real clock; tests inject 0
  // (or a manual clock) instead of sleeping.
  approvalArmingMs?: number;
  approvalClock?: () => number;
  // Issue #319: the colour depth. Absent means detectColorLevel over
  // process.env and stdout's TTY flag (the shipped behaviour); tests pass
  // 'none' so the shell's NO_COLOR / FORCE_COLOR never reach them.
  colorLevel?: ColorLevel;
  // Issue #327: the config `[modes]` default — `orchestrator = true` starts
  // the session in orchestrator mode (the --orchestrator flag still wins).
  // This is what makes the documented key do something instead of being
  // parsed and ignored.
  modes?: { readonly orchestrator: boolean };
  // Issue #327: the git probe behind the non-git orchestrator refusal
  // (exit 5). Consulted only when the resolved mode IS orchestrator; absent
  // means the caller owns the check (viewer boots and injected fakes).
  isGitRepo?: () => boolean | Promise<boolean>;
}

export type TuiSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
export type TuiProcessEvent =
  | TuiSignal
  | 'uncaughtException'
  | 'unhandledRejection';

export interface TuiProcessEvents {
  on(event: TuiProcessEvent, listener: (value: unknown) => void): unknown;
  off(event: TuiProcessEvent, listener: (value: unknown) => void): unknown;
}

const TUI_SIGNALS: readonly TuiSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const TUI_FATAL_EVENTS = ['uncaughtException', 'unhandledRejection'] as const;

// Issue #313: a signalled quit exits 128+signo (SIGHUP 129, SIGINT 130,
// SIGTERM 143) — the shell convention, so a supervisor can tell a signalled
// TUI from a clean quit.
export function signalExitCode(signal: TuiSignal): number {
  return 128 + osConstants.signals[signal];
}

// Issue #312: how long a quit waits for an aborted turn to settle. The kills
// have already run by then; the wait only lets the lane record its terminal
// status and the killed tool finish its last write before the §42.5 sweep.
export const TUI_DRAIN_TIMEOUT_MS = 3000;

function defaultDrainTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}

// Issue #327: the non-git orchestrator refusal needs a real probe before the
// alt-screen opens — `git rev-parse --show-toplevel` through the exec seam,
// the same question orchestrate's own deps answer. Never called for a solo
// resolution.
async function defaultIsGitRepo(): Promise<boolean> {
  try {
    const shell = new NodeExecutionEnv(process.cwd()).shell;
    const result = await shell
      .spawn('git', ['rev-parse', '--show-toplevel'], {
        provenance: {
          sessionId: '',
          agentId: 'root',
          toolCallId: 'tui:is-git-repo',
          turnId: 0,
          operation: 'tui',
        },
      })
      .wait();
    return result.exitCode === 0;
  } catch {
    // A probe that cannot even run (no git binary, a spawn failure) is not
    // a repository as far as the orchestrator entry is concerned: refuse
    // with the named message rather than throwing past it.
    return false;
  }
}

// The `kubic tui` parity flags (issue #113): same names and semantics as
// the `kubic run` counterparts.
export interface TuiBootFlags {
  role?: string;
  noSkills?: boolean;
  skillsList?: string[];
  // Issue #308: `--dangerously-skip-approvals` for the booted session.
  dangerouslySkipApprovals?: boolean;
  // `--model` is deliberately NOT a boot flag (issues #227, #295): dispatch
  // pre-scans it from the raw argv into the ONE config load as the `cli`
  // layer, so `TuiConfigProjection.model` already carries cli > env > file
  // precedence and the enterprise freeze. A flag patched over that
  // projection afterwards would bypass the freeze `kubic run` honours.
}

export interface TuiRunOptions {
  sessionsRoot?: string;
  env?: NodeExecutionEnv;
  // Config-sourced permission classes (issue #90): the TUI is a
  // config-consuming command, so it takes the same projection `kubic run`
  // does. Absent means the documented SOLO_DEFAULTS.
  classes?: PermissionClasses;
  // Issue #86: the config layer's own record of where the classes came from
  // ('default' when nothing configured them). Absent means 'default'.
  policySource?: 'config' | 'default';
  // Issue #230: the config `[approvals]` policy — the same projection
  // `kubic run` installs. Absent means the documented defaults.
  approvals?: SoloApprovalConfig;
  // The installed-policy seat (issue #86): the same derivation the headless
  // runner installs. Absent means the shipped default (classes above +
  // destructive/network/confine guards + the approval ask); tests inject a
  // variant. `kubic tui` drives the same lane, so it takes the same policy.
  policy?: InstalledSoloPolicy;
  // Model registry injection (issue #87): the same seam `runHeadlessPrompt`
  // takes as `models`, so the reconciliation tests can boot the REAL path
  // hermetically with faux models. Absent means the assembled prod catalog.
  models?: MutableModels;
  // The answer seat (issue #96): the interactive path's approval surface.
  // Attached by runTuiCommand; absent means the no-surface refusal, which is
  // what `kubic tui` had before the overlay landed.
  answer?: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalVerdict | undefined>;
  // Issue #113 (TUI parity with `kubic run`): skills discovery, `--role`
  // documents, and journal retention reach the interactive lane exactly
  // as they reach the headless one — same options, same semantics.
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
  };
  noSkills?: boolean;
  skillsList?: string[];
  role?: string;
  roles?: { cwd?: string; layers?: RoleLayerInput[] };
  journalRetention?: JournalRetention;
  // §35 out-of-scope paths (issue #115): the same projection `kubic run`
  // threads, so a declared directory is excluded from this lane's §42.5
  // baseline and sweep too. Absent means the mechanism's own skips only.
  reconcileOutOfScope?: string[];
  // Issue #228 (§35.1): the per-path trust check (the store's
  // resolved-root decision plus the env opt-in), from the composition
  // root's config load — gates the project models.json and the ancestor
  // project skills on the interactive lane exactly as `kubic run` gates
  // them. Absent falls back to the env.
  trustProject?: (path: string) => boolean;
  // The lane's agent id (issue #133): the configured `[agent].name`, from
  // the SAME runtimeLaneDeps projection `kubic run` consumes. Absent means
  // 'root' — the shipped attribution, unchanged.
  agentId?: string;
  // §41.4 (issue #308): enable full access for the booted session through
  // the one host enable path before the policy is installed.
  dangerouslySkipApprovals?: boolean;
  // Issue #295 with #227 (§38.1): the runtime pin the config load projected
  // (cli `--model` > `KUBIC_MODEL` > `[model]`), from the SAME runtimeModelPin
  // seam `kubic run` consumes. It beats the role layer's model, which beats
  // first-available; an explicit pin selects the model and makes a resumed
  // session switch (the #148 rule), absent means the default pick.
  model?: ModelSelection;
  // §58 enterprise policy (issue #288): the same EffectivePolicy the
  // headless runner gates with — the interactive lane is not the
  // unprotected one.
  modelPolicy?: EffectivePolicy;
  // §35.1 (issue #295): the runtime pin above is a frozen enterprise `[model]`
  // — the session override (`/model`, the same level as `--model`, §38.1)
  // cannot leave it, exactly as the flag cannot.
  modelPinFrozen?: boolean;
  // Issue #327: the config `[orchestrator]` projection (worktree parent and
  // worker cap) the interactive drive hands the manager lane, and the
  // approval snapshot a delegated conflict resolver runs under.
  orchestratorRuntime?: RuntimeOrchestrator;
  approvalPolicy?: ApprovalSnapshot;
}

// The durable loop surface over one booted solo lane — exactly what
// bootTuiLane installs. Exported so the prod boot, embedders and the tests
// share ONE wiring: a lane member the loop needs cannot be forgotten in a
// hand-spread fake (the failure mode that hides a dropped dep).
export function soloTuiLoop(
  solo: SoloLane,
  context: Context = BACKGROUND_CONTEXT,
): TuiLaneLoop {
  return {
    runTurn: (prompt, opts) => runTurn(solo, prompt, opts),
    subscribe: (sink, loopContext) =>
      subscribeLaneEvents(
        solo.harness,
        solo.conversation.id,
        sink,
        loopContext,
      ),
    entries: (loopContext) =>
      readConversationEntries(solo.conversation, loopContext),
    // Issue #330: `/compact [focus]` — Pi's manual compaction task with
    // Kubic's compact prompt as the summarizer instructions.
    compact: (focus, loopContext, options) =>
      runManualCompaction(solo, focus, loopContext, options),
    // D6.2: the shared abort+drain (conversation.abort, every kill
    // attempted, failures aggregated) and the settled-turn forget.
    abort: async (loopContext) => {
      await abortLane(solo, loopContext);
    },
    forgetKills: () => forgetLaneKills(solo),
    killsKey: String(solo.conversation.id),
    kills: solo.kills,
    // The lane's own context: every member is called with it, so an embedder
    // that booted the lane on a bounded context is never silently
    // un-cancellable.
    context,
  };
}

// Prod solo boot: same session/model setup as the headless runner
// (create-or-attach, journal dir, assembled models, default select, lane
// boot) plus the loop surface the interactive path drives.
export async function bootTuiLane(
  sessionId?: string,
  options: TuiRunOptions = {},
): Promise<TuiLaneBoot> {
  // Defense-in-depth with runTuiCommand's --session check: direct
  // callers bypass the CLI, so reject path-unsafe ids here before any
  // store attach or path join can see them (mirrors headless-run.ts).
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
  }
  const root = options.sessionsRoot ?? defaultSessionsRoot();
  const context = BACKGROUND_CONTEXT;
  const bridge = createNodeFileBridge(root);
  const store = openSessionStore(root, bridge);
  const session =
    sessionId === undefined
      ? await createSession(store, { cwd: process.cwd() }, context)
      : await attachSession(store, sessionId, context);
  const id = session.id;
  // Issue #346: the session's committed spend, read from its own `pi.usage`
  // ledger (#400's reader — the same numbers `kubic cost` prints) BEFORE the
  // lane adopts the storage. Best-effort: a torn or foreign usage document
  // must never block a boot; the bar then starts from zero as it used to.
  let usageRows: StatusUsageRow[] = [];
  try {
    usageRows = statusRowsFromSessionUsage(
      await readSessionUsage(session.storage, context),
    );
  } catch {
    usageRows = [];
  }
  // §42.5 baseline + end-of-run sweep (issue #87): the TUI's run end is its
  // close — quit, SIGINT, EOF — so the sweep rides that `close`. There is no
  // closed-latch: idempotence comes from `reconcile`'s per-path after-hash
  // comparison, so a second close on an unchanged tree appends nothing, while
  // a mutation landing between two closes IS appended (pinned by the exec
  // suite). Assigned inside the try below.
  let reconciliation: RunReconciliation | undefined;
  // Issue #325: the installed policy's end-of-session posture check.
  let settlePolicy: (() => void) | undefined;
  // The booted lane, once it exists. The session release is the caller's job
  // (#392): the harness closes first, then the handle gives the lock back.
  let solo: SoloLane | undefined;
  // Issue #312: the quit's last-resort kill drain. D1 keys every bash group
  // by String(conversation.id): whatever is still registered when the quit
  // runs is killed here — before the sweep and the close — because a tool
  // may register its kill after the abort bound gave up on it. A settled
  // turn's handles are forgotten (forgetKills), so a kept background job is
  // not this quit's to kill.
  let killRemaining: (() => void) | undefined;
  const close = async (): Promise<void> => {
    try {
      killRemaining?.();
    } catch {
      // A kill that already exited is not a reason to skip the sweep.
    }
    try {
      reconciliation?.sweep();
    } catch {
      // A sweep failure never masks the clean quit (same posture as the
      // headless runner: reconciliation observes, it does not gate).
    }
    try {
      settlePolicy?.();
    } catch {
      // Best-effort, like the sweep: the clean quit stands.
    }
    try {
      await solo?.close(context);
    } catch {
      // A harness that was never booted, or one already closed, still
      // releases the session handle below.
    }
    try {
      await session.release(context);
    } catch {
      // The mapped result stands — close failures never escape.
    }
  };
  try {
    bridge.createDir(join(id, 'journal'));
    // Issue #113 (§42.4): the store takes the same retention policy the
    // headless runner threads from config — a TUI session's journal age-
    // prunes when the operator configured it, like any run.
    const journal = new FileJournalStore(
      join(root, id, 'journal'),
      options.journalRetention ?? {},
    );
    // A capture failure is not a boot failure (same posture as the headless
    // runner): the sweep then simply has no baseline to compare against.
    try {
      reconciliation = beginReconciliation({
        store: journal,
        root: options.env?.cwd ?? process.cwd(),
        runId: id,
        sessionId: id,
        agentId: options.agentId ?? 'root',
        ...(options.reconcileOutOfScope === undefined
          ? {}
          : { outOfScope: options.reconcileOutOfScope }),
      });
    } catch {
      // Reported below by the loop's own surfaces; the boot stands.
    }
    // Request-time provider keys, audited per use (issue #359, §36.1).
    const keyResolver = createLedgerModelKeyResolver({
      workspace: options.env?.cwd ?? process.cwd(),
      role: 'root',
      sessionId: () => id,
    });
    const assembled =
      options.models === undefined
        ? await assembleModels(process.cwd(), process.env, {
            resolveApiKey: keyResolver.resolve,
            ...(options.trustProject === undefined
              ? {}
              : { projectTrust: options.trustProject }),
          })
        : undefined;
    const models = options.models ?? (assembled as AssembledModels).models;
    // The faux testing provider (`KUBIC_PROVIDER=faux`) is pinned, never
    // picked implicitly; the footer names it (runTuiCommand). The implicit
    // pick never takes a keyless built-in (issue #221).
    const fauxPinned =
      options.models === undefined && fauxProviderActive(process.env);
    // Issue #113 (§12.1): `--role` derives both halves of the boot from
    // the role document — prompt text and tool allowlist — with the same
    // fail-closed refusals as `kubic run`. An unknown role refuses the
    // boot (the catch below closes the session and rethrows for the
    // command shell to print) rather than silently booting a roleless
    // lane. Resolved BEFORE model selection: the role layer's model pin is
    // a selection input (issue #295).
    // §58 enterprise policy (issue #288): the same gates the headless runner
    // applies — role grants are checked and the model selection is gated.
    const enterprisePolicy = options.modelPolicy;
    const toolGate =
      enterprisePolicy !== undefined && hasToolPolicy(enterprisePolicy)
        ? (tool: string): boolean =>
            isToolAllowedByEnterprise(enterprisePolicy, tool)
        : undefined;
    // The stored model of a resumed session is gated too (issue #288): the
    // selection is checked at boot, the stored one only by this closure.
    const modelGate =
      enterprisePolicy !== undefined && hasModelPolicy(enterprisePolicy)
        ? (provider: string, modelId: string): boolean =>
            isModelAllowed(enterprisePolicy, provider, modelId)
        : undefined;
    const selectedRole = (() => {
      if (options.role === undefined) return undefined;
      const rolesCwd = options.roles?.cwd ?? process.cwd();
      const rolesBridge = createNodeFileBridge(rolesCwd);
      const selected = selectRole({
        bridge: rolesBridge,
        cwd: rolesCwd,
        role: options.role,
        ...(options.roles?.layers === undefined
          ? {}
          : { layers: options.roles.layers }),
        ...(enterprisePolicy === undefined
          ? {}
          : { toolPolicy: enterprisePolicy }),
      });
      const promptText = rolePromptFor(
        selected.doc,
        rolesBridge.readTextFile(roleDocPath(rolesCwd, selected.doc.name)),
      );
      return { resolved: selected.resolved, prompt: promptText };
    })();
    const roleBoot: { rolePrompt?: string; toolAllowlist?: string[] } =
      selectedRole === undefined
        ? {}
        : {
            rolePrompt: selectedRole.prompt,
            ...(selectedRole.resolved.tools.length === 0
              ? {}
              : { toolAllowlist: selectedRole.resolved.tools }),
          };
    // §38.1 (issues #227, #295): the ONE projection `kubic run` and
    // `kubic tui` share — the runtime pin (cli `--model` > env > `[model]`)
    // beats the role layer's model, which beats the first usable provider;
    // the implicit pick never takes a keyless built-in (issue #221). The
    // §58 enterprise policy (issue #288) gates the explicit/role selection
    // and the provider pool. The explicit-selection predicate is the #148
    // rule: any pin (faux, runtime or role) switches a resumed session
    // whose stored model differs, the default pick never does.
    const model = (() => {
      const explicitSelection = fauxPinned
        ? { provider: FAUX_PROVIDER_ID, id: FAUX_MODEL_ID }
        : options.model;
      const roleSelection = roleModelSelection(selectedRole?.resolved.model);
      return selectModelUnderPolicy(
        models,
        explicitSelection,
        roleSelection,
        assembled?.fallbackProviders,
        enterprisePolicy,
      );
    })();
    const explicitModel = hasExplicitModelSelection({
      fauxPinned,
      pin: options.model,
      roleModel: selectedRole?.resolved.model,
    });
    // The `provider/id` the §60 rows name (issues #148, #227): seeded with
    // the selection, re-pointed at the model the lane reports once the boot
    // has applied the stored-model rule and again on every `/model` switch —
    // the policy is installed before the lane exists, so it reads this at
    // record time instead of freezing the pre-boot pick.
    let liveModelRef = `${model.provider}/${model.id}`;
    const env = options.env ?? new NodeExecutionEnv(process.cwd());
    // The loaded skill names, for the §46 trajectory's resources (#383).
    let skillNames: string[] = [];
    // Installed policy (issue #86): `kubic tui` drives the same solo lane as
    // `kubic run`, so it installs the same policy — one derivation
    // (host/approvals.installSoloPolicy), which is also what `doctor`
    // reports. Without this the interactive path would be the unprotected
    // one, which is the defect this issue exists to close.
    // §41.4 (issue #308): the explicit flag records full access for THIS
    // session (posture.json + one §60 row) before the policy is installed.
    const fullAccessGrant =
      options.dangerouslySkipApprovals === true
        ? enableSessionFullAccess({
            sessionDir: join(root, id),
            sessionId: id,
            command: 'tui',
            workspace: env.cwd,
          })
        : undefined;
    const installed =
      options.policy ??
      installSoloPolicy({
        workspace: env.cwd,
        ...(options.classes === undefined ? {} : { classes: options.classes }),
        source: options.policySource ?? 'default',
        ...(options.approvals ?? {}),
        sessionDir: join(root, id),
        // The session root in use is refused control-plane state (#324).
        sessionsRoot: root,
        // §60 audit identity (issue #295): every resolved ask names the
        // session and the model the lane runs on, like `kubic run`'s.
        sessionId: id,
        model: () => liveModelRef,
        // The answer seat (issue #96): with the overlay's surface attached,
        // `kubic tui` is the command that can actually collect a verdict on a
        // challenged call instead of refusing it unseen. Injected policies
        // (tests, and any caller that supplies its own) keep their own seat.
        ...(options.answer === undefined ? {} : { answer: options.answer }),
      });
    // Issue #148 (§26.1): the same rule as `kubic run` — a pin (faux,
    // runtime, or the role's default) switches a resumed session whose
    // stored model differs; the default pick keeps the session's own model.
    const modelNotices: string[] = [];
    const booted = await bootSoloLane({
      session,
      models,
      model,
      modelPolicy: explicitModel ? 'selected' : 'stored',
      onModelNotice: (line) => modelNotices.push(line),
      env,
      sessionId: id,
      agentId: options.agentId ?? 'root',
      journal,
      // Issue #113 (§29.3): skills discovery at boot, same as the headless
      // runner — the <skills> block lands on the interactive lane too. A
      // loader refusal is never fatal (skills are context, never a gate);
      // it is logged to the boot's debug channel.
      ...((): {
        promptSections?: string[];
        skillReadRoots?: readonly string[];
      } => {
        const trustProject =
          options.trustProject ?? options.skills?.trustProject;
        const skills = bootSkills({
          bridge: createNodeFileBridge(options.skills?.cwd ?? process.cwd()),
          cwd: options.skills?.cwd ?? process.cwd(),
          homeDir: options.skills?.homeDir ?? homedir(),
          trusted:
            options.skills?.trusted ??
            (process.env.KUBIC_TRUST_PROJECT === '1' ||
              process.env.KUBIC_TRUST_PROJECT === 'true'),
          ...(trustProject === undefined ? {} : { trustProject }),
          ...(options.noSkills === undefined
            ? {}
            : { noSkills: options.noSkills }),
          ...(options.skillsList === undefined
            ? {}
            : { cliSkills: options.skillsList }),
          log: () => {
            // TUI: no debug footer on the alt-screen; loader lines are
            // intentionally dropped (the block itself is observable).
          },
        });
        skillNames = skills.skills.map((skill) => skill.name);

        return {
          ...(skills.block === undefined
            ? {}
            : { promptSections: [skills.block] }),
          // Issue #173: the advertised skills outside the cwd stay readable.
          ...(skills.readRoots.length === 0
            ? {}
            : { skillReadRoots: skills.readRoots }),
        };
      })(),
      // Issue #113 (§12.1): `--role` derives both halves of the boot from
      // the role document — prompt text and tool allowlist — resolved above,
      // before model selection, with the same fail-closed refusals as
      // `kubic run`.
      ...roleBoot,
      // The same installed policy `kubic run` boots with (issue #86): one
      // derivation, so the interactive path is not the unprotected one.
      policy: {
        classes: installed.classes,
        interceptors: installed.interceptors,
        ...(installed.contributions.length === 0
          ? {}
          : { contributions: installed.contributions }),
        // §58 enterprise tool gate (issue #288): the same active-tools /
        // prompt-tools intersection the headless lane installs.
        ...(toolGate === undefined ? {} : { toolAllowed: toolGate }),
        ...(modelGate === undefined ? {} : { modelAllowed: modelGate }),
      },
    });
    // The booted lane: `solo` stays optional for the close closure (a boot
    // that failed before the assignment must still release the session).
    solo = booted;
    {
      const running = await liveModelOf(booted, context);
      liveModelRef = `${running.provider}/${running.id}`;
    }
    killRemaining = (): void => {
      // D1: every bash group is keyed by the conversation id, so the quit's
      // backstop drains exactly that key (forgetKills may already have
      // dropped a settled turn's handles — that is the point).
      for (const kill of booted.kills.drain(String(booted.conversation.id))) {
        try {
          kill();
        } catch {
          // Already exited — the registry drains every entry regardless.
        }
      }
    };
    // Issue #147 (§21): a turn a dead process left open would sit until its
    // guarded resume timed out; the interactive policy is the durable abort —
    // its approvals would need the overlay, which is not on screen yet, and
    // the operator is present to re-send. The interrupted prompt's own text
    // is named too when the dead process had already placed it (#147's
    // "resume this very prompt" rule): the operator sees WHAT was interrupted.
    // The outcome is named in the footer from the first render (#396).
    const pendingNotices: string[] = [];
    const pending = await inspectPending(solo, context);
    if (pending.pending) {
      const interrupted = await pendingInputText(solo, context);
      const settlement = await settlePending(solo, 'abort', {
        context,
        kills: booted.kills,
      });
      const notice = describePendingSettlement(pending.summary, settlement);
      pendingNotices.push(
        interrupted === undefined
          ? notice
          : `${notice} — interrupted prompt: ${interrupted}`,
      );
    }
    const fullAccess = installed.posture.fullAccess;
    settlePolicy = installed.settle;
    // The model the lane actually runs (issue #148): the status bar, the
    // usage rows the turn runner records and the #347 context gauge all
    // read this.
    const runningModel = await liveModelOf(solo, context);
    return {
      sessionId: id,
      model: `${runningModel.provider}/${runningModel.id}`,
      // Issue #347: the gauge needs the running model's window; a catalog
      // that does not know it yields none and the gauge stays off.
      contextLimits: contextLimitsOf(
        models,
        runningModel.provider,
        runningModel.id,
      ),
      journal,
      reconcile: () => {
        reconciliation?.sweep();
      },
      ...(modelNotices.length === 0
        ? {}
        : { modelNotice: modelNotices.join('; ') }),
      ...(pendingNotices.length === 0
        ? {}
        : { pendingNotice: pendingNotices.join('; ') }),
      fullAccess,
      usageRows,
      ...(fullAccess
        ? {
            notices: [fullAccessGrant?.warning ?? fullAccessInForceWarning(id)],
          }
        : {}),
      approvalsSkipped: installed.approvalsSkipped,
      // Issue #327: the orchestrator lane a Ctrl-G switch submits to — the
      // same manager-lane path `kubic orchestrate` runs, with the TUI's
      // approval seat attached so a worker's ask reaches the overlay and
      // its verdict travels back through the mailbox. Lazy deps: a session
      // that never toggles pays nothing.
      orchestrator: createProdTuiOrchestrator({
        sessionId: id,
        cwd: env.cwd,
        sessionsRoot: root,
        out: () => {
          // The runner replaces the sink per turn (transcript lines); before
          // the first run there is nowhere to paint.
        },
        ...(options.answer === undefined
          ? {}
          : {
              seat: workerAskSeatFromAnswer(options.answer),
              // The merge gate's ask goes through the same surface, never a
              // readline over the stdin the TUI owns (issue #327).
              mergeSeat: mergeSeatFromAnswer(options.answer),
            }),
        ...(options.orchestratorRuntime === undefined
          ? {}
          : { orchestrator: options.orchestratorRuntime }),
        ...(options.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: options.approvalPolicy }),
        // §58 enterprise policy (issue #288): the manager lane refuses an
        // assignment whose role declares a denied tool, as `kubic
        // orchestrate` does.
        ...(enterprisePolicy === undefined
          ? {}
          : { toolPolicy: enterprisePolicy }),
        ...(options.roles?.layers === undefined
          ? {}
          : { roleLayers: options.roles.layers }),
        // The lane's current model (issue #202): read at each delegation, so
        // a `/model` switch is the model the workers inherit — the same
        // §38.1 `parentModel` `kubic orchestrate` passes from its resolved
        // pin. The boot's live model is the first value; `liveModelOf`
        // re-reads the attached agent each turn.
        currentModel: () => liveModelOf(booted, context),
        // A frozen enterprise `[model]` binds the workers too (issue #295).
        ...(options.modelPinFrozen === true && options.model !== undefined
          ? { frozenModel: options.model }
          : {}),
        // The per-root trust check (issue #228), as `kubic orchestrate` gets
        // it: the run evaluates it for the models root it loads, so a `kubic
        // trust` grant reaches the manager and the workers from the TUI too —
        // and a grant for a subdirectory never stands in for the repo root.
        ...(options.trustProject === undefined
          ? {}
          : { projectTrust: options.trustProject }),
      }),

      loop: {
        ...soloTuiLoop(booted, context),
        // Issue #347: a `/model` switch moves the context window with it, so
        // the gauge never keeps the old model's percentage.
        contextLimits: (provider, id) => contextLimitsOf(models, provider, id),
        // Issue #227: resolve against the live catalog before touching the
        // conversation, so `/model typo/nope` fails by name and the lane
        // keeps the model it had; configure then commits the change to the
        // session's agent document (#394), and the read-back is the label
        // every surface shows. The §58 enterprise gate (issue #288) is the
        // boot's own: a switch outside `allowed_models`/`allowed_providers`
        // is refused with the same named error before the lane is touched,
        // so the live model stays put.
        switchModel: async (selection, loopContext) => {
          // §35.1/§38.1 (issue #295): `/model` is the session override, and a
          // frozen enterprise `[model]` cannot be overridden by it — refused
          // by name before the catalog or the conversation is touched. Naming
          // the pin itself changes nothing and passes.
          if (options.modelPinFrozen === true && options.model !== undefined) {
            const pinned = `${options.model.provider}/${options.model.id}`;
            const requested = `${selection.provider}/${selection.modelId}`;
            if (requested !== pinned) {
              throw new ModelSelectError(
                `model '${requested}' refused: the model is pinned by enterprise policy (${pinned}); /model cannot change it`,
              );
            }
          }
          const resolved = selectModelUnderPolicy(
            models,
            { provider: selection.provider, id: selection.modelId },
            undefined,
            undefined,
            enterprisePolicy,
          );
          await booted.conversation.configure(
            { model: { provider: resolved.provider, modelId: resolved.id } },
            loopContext,
          );
          // The agent document is the truth: read the live model back
          // instead of echoing the request (it also re-clamps the #399
          // compaction reserve, which follows the current model live).
          const live = await liveModelOf(booted, loopContext);
          liveModelRef = `${live.provider}/${live.id}`;
          return liveModelRef;
        },
        model: async (loopContext) => {
          const running = await liveModelOf(booted, loopContext);
          return `${running.provider}/${running.id}`;
        },
        // §46 trajectory per settled turn (issue #383): the same record
        // `kubic run` writes, holding the session's latest settled turn.
        // D6.5: the entries and the transcript come from #400's adapter —
        // never a second entry reader.
        recordTurn: async (turn) => {
          const entries = await readConversationEntries(
            booted.conversation,
            context,
          );
          // The live model can have moved since boot (`/model`), so the
          // trajectory records what the lane actually runs — the same read
          // the returned `model` and the status bar use.
          const live = await liveModelOf(booted, context);
          persistRunTrajectory({
            sessionsRoot: root,
            sessionId: id,
            agentId: options.agentId ?? 'root',
            role: options.role ?? 'solo',
            prompt: turn.prompt,
            entries,
            model: { provider: live.provider, id: live.id },
            cwd: env.cwd,
            skills: skillNames,
            startedAt: turn.startedAt,
            endedAt: Date.now(),
            outcome: tuiTurnOutcome(turn, entriesToTranscript(entries)),
          });
        },
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// A settled TUI turn → the §78 outcome its trajectory records (#383): the
// durable turn record decides (D6.1), exactly as it does for `kubic run`; a
// turn the lane never settled is a plain failure, never an invented terminus.
export function tuiTurnOutcome(
  turn: TuiTurnRecord,
  items: readonly TranscriptItem[],
): RunOutcome {
  const lane = turn.turn === undefined ? undefined : turnLaneRecord(turn.turn);
  // The lane's own record is authoritative: an abort that raced a completing
  // turn is a completed run, not a cancellation (the work really did land).
  const completed =
    lane === undefined
      ? turn.outcome.status === 'completed'
      : lane.status === 'completed';
  if (completed) {
    return {
      terminus: 'completed',
      summary: assistantSummary(items) ?? NO_ASSISTANT_TEXT_SUMMARY,
      ...(lane === undefined ? {} : { lane }),
    };
  }
  const summary = turn.outcome.detail ?? footerForOutcome(turn.outcome);
  const terminus =
    lane?.status === 'failed'
      ? terminusOfFailure(lane.error?.code ?? '')
      : 'failed';
  return { terminus, summary, ...(lane === undefined ? {} : { lane }) };
}

// The model the conversation actually runs (issue #148): the committed
// `pi.agent` document first, the boot model as the fallback for the window
// before the first configure.
async function liveModelOf(
  solo: SoloLane,
  context: Context,
): Promise<{ provider: string; id: string }> {
  const agent = await solo.conversation.agent(context);
  const live = agent.model;
  if (live !== undefined) {
    return { provider: live.provider, id: live.modelId };
  }
  return { provider: solo.model.provider, id: solo.model.id };
}

// One durable entry → the coarse transcript cell the TUI app renders. The
// tui package may not import worker types (dep-lint), so the entry is
// projected into the structural `LaneEntryLike` by hand. The renderable
// kinds are the message-bearing ones; the positional prompt/system,
// compaction and reset entries have no transcript cell of their own, exactly
// as 0.87's non-message entries had none.
export function laneEntryFor(entry: EntryRecord): LaneEntryLike | undefined {
  const role =
    entry.kind === 'pi.user'
      ? 'user'
      : entry.kind === 'pi.assistant'
        ? 'assistant'
        : entry.kind === 'pi.tool-result'
          ? 'toolResult'
          : undefined;
  if (role === undefined) return undefined;
  const message = entry.model?.[0] as
    | {
        content?: unknown;
        isError?: unknown;
        toolCallId?: unknown;
      }
    | undefined;
  if (message === undefined) return undefined;
  const content = normalizeMessageContent(message.content);
  if (content === undefined) return undefined;
  return {
    id: String(entry.id),
    // The entry id is pi-durable's monotonic NUMERIC EntryId, which is the
    // transcript order the app sorts by; `seq` stays the numeric field it
    // expects (`String(entry.id)` here would degrade the sort to insertion
    // order).
    seq: entry.id,
    type: 'message',
    message: {
      role,
      content,
      ...(message.isError === true ? { isError: true } : {}),
      ...(typeof message.toolCallId === 'string' && message.toolCallId !== ''
        ? { toolCallId: message.toolCallId }
        : {}),
    },
  };
}

// A user message's content may be a bare string; the app renders content
// arrays only, so a string becomes its one text part.
function normalizeMessageContent(content: unknown): unknown[] | undefined {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return undefined;
}

// The channels `tuiDepsWithDefaults` adds to, plus every config projection;
// `tuiBootOptions` projects the pair into the boot options.
export type TuiDepsInput = {
  out: (line: string) => void;
  err?: (line: string) => void;
} & TuiConfigProjection;

// The config projections `kubic tui` consumes (issues #86, #90, #113, #115,
// #133). The lane half is `runtimeLaneDeps`' own return type BY NAME
// (issue #294): a key that projection gains can never be silently dropped
// here, because the forwarding table in tuiBootOptions must name every key
// of this type.
export type TuiConfigProjection = {
  // Config projections (issues #86, #90): the TUI installs the same policy
  // the headless runner does. Absent means the documented safe default.
  classes?: PermissionClasses;
  policySource?: 'config' | 'default';
  approvals?: SoloApprovalConfig;
  policy?: InstalledSoloPolicy;
  // Issue #113 (§42.4): config journal retention, threaded from the same
  // runtimeRunDeps projection `kubic run` uses.
  journalRetention?: JournalRetention;
  // Issue #115 (§35/§42.5): config out-of-scope paths, from that same
  // projection — the interactive lane's baseline and sweep honour them too.
  reconcileOutOfScope?: string[];
  // Issue #295 with #227: the runtime model pin the config load projected
  // (cli `--model` > `KUBIC_MODEL` > `[model]`), from the SAME runtimeModelPin
  // projection `kubic run` consumes, so the interactive boot selects what the
  // headless one selects.
  model?: ModelSelection;
  // §58 enterprise policy (issue #288): the SAME resolved EffectivePolicy
  // `kubic run` gates with (`HeadlessRunDeps.modelPolicy`). It is the only
  // §58 dep the run path threads — the role-grant check, the model gate and
  // the lane tool intersection all derive from it — so a projection that
  // drops it (the audit's finding) leaves every enterprise gate inert on the
  // interactive lane.
  modelPolicy?: EffectivePolicy;
  // §35.1 (issue #295): the pin above is a frozen enterprise `[model]`, so the
  // live `/model` switch is bound by it too (see TuiRunOptions.modelPinFrozen).
  modelPinFrozen?: boolean;
  // Issue #327: the manager lane's projections for the interactive
  // orchestrator drive — the `[orchestrator]` worktree/cap values and the
  // approval snapshot the resolver path carries. Absent means the shipped
  // defaults (and, for the snapshot, no delegation of conflicts).
  orchestratorRuntime?: RuntimeOrchestrator;
  approvalPolicy?: ApprovalSnapshot;
  // Issue #327: the config `[modes]` projection (issue #90's runtime load).
  // Consumed by runTuiCommand: `orchestrator = true` starts the session in
  // orchestrator mode; the flag still beats it.
  modes?: { readonly orchestrator: boolean };
  // Issue #228 (§29.3): the project-trust check for skills discovery,
  // threaded from the same config report `kubic run` consumes — a store
  // grant checked per ancestor on the interactive lane.
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
  };
  // Issue #228 (§35.1): the same check gates the project models.json on
  // this lane's assembled catalog.
  trustProject?: (path: string) => boolean;
} & ReturnType<typeof runtimeLaneDeps>;

function definedOnly<T extends object>(
  table: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
  for (const key of Object.keys(table) as Array<keyof T>) {
    const value = table[key];
    if (value !== undefined) out[key] = value as Exclude<T[keyof T], undefined>;
  }
  return out;
}

// The boot options `tuiDepsWithDefaults` hands `bootTuiLane`, projected from
// the config deps plus the parsed parity flags. Pure and exported (issue
// #227) so the prod wiring — including the model pin — is testable without
// opening a terminal. The #294 forwarding table lives here: every
// TuiConfigProjection key must appear (possibly undefined), so omitting one
// is a compile error.
export function tuiBootOptions(
  provided: TuiDepsInput,
  flags: TuiBootFlags | undefined,
  answer: TuiApprovalSeat | undefined,
): TuiRunOptions {
  const forwarded = {
    classes: provided.classes,
    approvals: provided.approvals,
    policySource: provided.policySource,
    policy: provided.policy,
    journalRetention: provided.journalRetention,
    reconcileOutOfScope: provided.reconcileOutOfScope,
    // Issue #294: `[agent].name` (journal and reconciliation attribution)
    // and the `[roles.<name>]` layers `--role` merges under the document.
    agentId: provided.agentId,
    roles: provided.roles,
    model: provided.model,
    // §58 enterprise policy (issue #288): the role-grant, model and tool
    // gates of the interactive boot all read this one object.
    modelPolicy: provided.modelPolicy,
    modelPinFrozen: provided.modelPinFrozen,
    // Issue #327: the `[modes]` session default and the manager-lane
    // projections the interactive orchestrator drive consumes.
    modes: provided.modes,
    orchestratorRuntime: provided.orchestratorRuntime,
    approvalPolicy: provided.approvalPolicy,
    // Issue #228: the per-path trust check and the skills roots it gates.
    skills: provided.skills,
    trustProject: provided.trustProject,
  } satisfies Record<keyof TuiConfigProjection, unknown>;
  const projection = definedOnly(forwarded);
  return {
    ...projection,
    ...(answer === undefined ? {} : { answer }),
    ...(flags?.role === undefined ? {} : { role: flags.role }),
    ...(flags?.noSkills === undefined ? {} : { noSkills: flags.noSkills }),
    ...(flags?.skillsList === undefined || flags.skillsList.length === 0
      ? {}
      : { skillsList: flags.skillsList }),
    ...(flags?.dangerouslySkipApprovals === true
      ? { dangerouslySkipApprovals: true }
      : {}),
  };
}

export function tuiDepsWithDefaults(
  provided: TuiDepsInput,
  // The boot the deps drive. Absent means the prod bootTuiLane; tests pass a
  // wrapper to observe (or re-root) exactly what the projection forwards.
  boot: typeof bootTuiLane = bootTuiLane,
): TuiRunDeps {
  return {
    out: provided.out,
    ...(provided.err === undefined ? {} : { err: provided.err }),
    createTerminal: () => new ProcessTerminal(),
    ...(provided.modes === undefined ? {} : { modes: provided.modes }),
    // Issue #327: the non-git orchestrator refusal needs a real probe before
    // the alt-screen opens. Lazy: solo sessions never call it.
    isGitRepo: () => defaultIsGitRepo(),
    // The seat arrives as an argument from runTuiCommand — see TuiRunDeps.
    bootLane: (
      sessionId?: string,
      answer?: TuiApprovalSeat,
      flags?: TuiBootFlags,
    ) => boot(sessionId, tuiBootOptions(provided, flags, answer)),
  };
}

// Issue #311: the §17 inspectable pair reads the session journal through
// the SAME projection `kubic diff` uses (diffEntries: one change per path,
// latest attribution). Reads are throttled like the transcript refresh: a
// burst of tool-end events collapses into one read per window, and a
// settlement (or the boot) reads at once. A read failure never reaches the
// loop — the panels keep their last rows.
export const JOURNAL_REFRESH_MS = 100;

// The one builtin whose writes bypass the journal's own recording (issue
// #311): a turn that ran it needs the reconcile sweep at settlement.
const SHELL_TOOL_NAME = 'bash';

export class JournalPanelFeed {
  private readonly read: () => ReadonlyArray<JournalChangeLike>;
  private readonly apply: (rows: ReadonlyArray<JournalChangeLike>) => void;
  private readonly schedule: (fn: () => void) => void;
  private readonly onError: (error: unknown) => void;
  private pending = false;
  private token = 0;

  constructor(options: {
    read: () => ReadonlyArray<JournalChangeLike>;
    apply: (rows: ReadonlyArray<JournalChangeLike>) => void;
    // Injectable window (tests); absent means a JOURNAL_REFRESH_MS timer.
    schedule?: (fn: () => void) => void;
    // Observes a failed read or apply. The feed still swallows it (the
    // journal is observed, never a gate); the hook exists so a defect in
    // `apply` (a TDZ read at boot, a throwing render) is testable instead of
    // silently indistinguishable from "the journal was unreadable".
    onError?: (error: unknown) => void;
  }) {
    this.read = options.read;
    this.apply = options.apply;
    this.onError = options.onError ?? ((): void => undefined);
    this.schedule =
      options.schedule ??
      ((fn: () => void): void => {
        const timer = setTimeout(fn, JOURNAL_REFRESH_MS);
        timer.unref?.();
      });
  }

  // A tool call ended: read once the current window closes.
  request(): void {
    if (this.pending) return;
    this.pending = true;
    this.token += 1;
    const token = this.token;
    this.schedule(() => {
      if (token !== this.token) return;
      this.pending = false;
      this.load();
    });
  }

  // Settlement / boot: read now; a pending window is superseded.
  now(): void {
    this.token += 1;
    this.pending = false;
    this.load();
  }

  private load(): void {
    try {
      this.apply(this.read());
    } catch (error) {
      // The journal is observed, never a gate: a failed read keeps the
      // panels on their last rows.
      this.onError(error);
    }
  }
}

function keyIs(data: string, key: string): boolean {
  try {
    return parseKey(data) === key;
  } catch {
    return false;
  }
}

export interface TuiTurnOutcome {
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly detail?: string;
}

// One-line footer for a settled turn: the editor row is the loop's only
// always-visible status surface besides the status bar, and a silent
// outcome (especially a cancellation) would leave the user guessing.
export function footerForOutcome(outcome: TuiTurnOutcome): string {
  if (outcome.status === 'completed') return '';
  if (outcome.status === 'cancelled') return 'cancelled';
  return `error: ${outcome.detail ?? 'the turn failed'}`;
}

// Drives one accepted prompt to settlement (the durable submit + wait) and
// folds the conversation's committed lane events into the views as they
// arrive. `cancel` aborts the conversation through the loop's durable abort
// (#395/D6.2) — the same path the quit drain uses — and a Ctrl-C that lands
// while the submit is still in flight is replayed on the real turn rather
// than being lost (or worse, treated as a quit, which would kill the
// process mid-turn).
// Issue #334: what the busy latch reads for one submitted turn. `pending` is
// the window between `run()` and the harness' admission answer (a Ctrl-C
// there must cancel, never quit); `placed` is work the harness put in the
// transcript. Neither is true for a submission waiting in the inbox — a
// follow-up admitted during a turn, or one a failed run left behind.
interface TuiRunState {
  placed: boolean;
  pending: boolean;
  submissionId?: string;
}

export class TuiTurnRunner {
  private readonly app: TuiApp;
  private readonly loop: TuiLaneLoop;
  private model: string;
  // Issue #334: every turn in flight, from the moment a submit is accepted
  // by the runner, with the placement fact the busy latch reads. A busy
  // Enter adds a QUEUED follow-up's own run here while the running turn is
  // still in it, and the single subscription below serves both: the
  // follow-up's run streams into the same transcript (exactly one lane
  // consumer per conversation, §15.3).
  private readonly runs = new Map<Promise<TuiTurnOutcome>, TuiRunState>();
  // The first run of the busy period owns the placement latch (Ctrl-C waits
  // for THE running turn to be placed, not for a queued follow-up's
  // admission, which is immediate and needs no placement).
  private placementOwned = false;
  // The one lane-event subscription of the current busy period.
  private attached = false;
  private attaching: Promise<void> | undefined;
  private detach: (() => Promise<void>) | undefined;
  private aborted = false;
  // The durable run has started (the `run-start` lane event): the placement
  // signal a pre-submit Ctrl-C waits for, so its abort cannot slip between
  // the submit and the moment the run owns the conversation. Kept from the
  // FIRST run of the busy period: a queued follow-up is admitted at once,
  // so the turn the operator asked to cancel is the one that was running.
  private placed: Promise<void> = Promise.resolve();
  private markPlaced: () => void = () => {};
  // Set once a quit starts draining: from then on the operation's kills stay
  // registered for the session close's backstop even if the turn settles.
  private quitting = false;

  // Called after a mid-turn transcript apply lands (the root repaints).
  private readonly onUpdate: (() => void) | undefined;

  // Issue #311: every lane event, after the app folded it in (the root
  // requests a journal read on tool-end).
  private readonly onLaneEvent: ((event: KubicLaneEvent) => void) | undefined;

  constructor(
    app: TuiApp,
    loop: TuiLaneLoop,
    model: string,
    onUpdate?: () => void,
    onLaneEvent?: (event: KubicLaneEvent) => void,
    // Issue #346: the session's committed spend, so the first live usage
    // event APPENDS to it instead of replacing the bar with the new row
    // alone (a resumed session's earlier turns are not re-emitted).
    usageRows: ReadonlyArray<StatusUsageRow> = [],
  ) {
    this.app = app;
    this.loop = loop;
    this.model = model;
    this.onUpdate = onUpdate;
    this.onLaneEvent = onLaneEvent;
    this.usageRows = [...usageRows];
  }

  // Issue #227: the live model label (updated by a `/model` switch), so the
  // `/model` report and the headers never read a stale boot snapshot.
  get modelRef(): string {
    return this.model;
  }

  // Issue #227: `/model provider/id`. The loop owns the lane-side switch
  // (catalog resolution, conversation.configure, read-back); this runner
  // keeps the model the app's status bar and every later header names.
  async switchModel(selection: ModelSelection): Promise<string> {
    const switchModel = this.loop.switchModel;
    if (switchModel === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    const label = await switchModel(
      { provider: selection.provider, modelId: selection.id },
      this.loop.context,
    );
    this.model = label;
    this.app.setModel(label);
    // Issue #347: the gauge follows the model. A loop without the lookup
    // (injected viewer shells) leaves the seeded limits alone.
    const limits = this.loop.contextLimits?.(selection.provider, selection.id);
    if (limits !== undefined) this.app.setContextLimits(limits);
    return label;
  }

  // Busy from the moment a submit is accepted by the loop — not from the
  // moment the durable turn lands — so the Ctrl-C that follows Enter by a
  // keystroke still cancels instead of quitting. Busy means PLACED work
  // (#334): a follow-up waiting in the inbox — admitted while a turn ran, or
  // left behind by a failed run — is not a run, so the spinner stops and the
  // queued row is the state the operator sees.
  isRunning(): boolean {
    for (const state of this.runs.values()) {
      if (state.pending || state.placed) return true;
    }
    return false;
  }

  // The single lane-event consumer for this conversation (§15.3: exactly
  // one). The committed entries the events carry are folded into the feed
  // (REPLACE on the attach snapshot, upsert on a committed message or tool
  // result) instead of re-reading the lane per event; tool status drives the
  // tree and usage rows drive the status bar (#398/D2).
  private readonly sink: LaneEventSink = (event: KubicLaneEvent): void => {
    this.app.applyLaneEvent(event);
    this.onLaneEvent?.(event);
    if (event.type === 'run-start') {
      // The run is placed: a latched Ctrl-C may now abort it for real, and a
      // submission the harness queued earlier (a follow-up waiting behind a
      // failed run) counts as work in flight from this moment (#334).
      this.markPlaced();
      this.markPlacedInputs(event.inputs);
    }
    if (event.type === 'snapshot') {
      // REPLACE semantics (D2): the attach snapshot is the transcript.
      this.replaceLaneEntries(event.entries);
      return;
    }
    if (event.type === 'usage') {
      // The row names the provider/model that answered (#287); the status
      // bar reads tokens + cost only.
      this.usageRows.push({
        model: event.row.model,
        provider: event.row.provider,
        usage: event.row.usage,
        ...(event.row.entryId === undefined
          ? {}
          : { entryId: event.row.entryId }),
        ...(event.row.toolCallId === undefined
          ? {}
          : { toolCallId: event.row.toolCallId }),
      });
      this.app.setUsage([...this.usageRows]);
      this.foldLaneEntries([event.entry]);
      return;
    }
    if (event.type === 'tool-end' && event.entry !== undefined) {
      // A tool result that faulted or was orphaned has no entry: the tree
      // already shows the error, and the transcript has nothing to append.
      this.foldLaneEntries([event.entry]);
    }
  };

  private readonly usageRows: StatusUsageRow[];

  // The accumulated committed-transcript feed: the attach snapshot replaces
  // it, every later entry-bearing event upserts into it, and every apply is a
  // fresh snapshot for the app (revision semantics).
  private laneEntries: LaneEntryLike[] = [];
  private readonly laneEntryIndex = new Map<string, number>();

  private replaceLaneEntries(entries: readonly EntryRecord[]): void {
    this.laneEntries = [];
    this.laneEntryIndex.clear();
    this.foldLaneEntries(entries);
  }

  private foldLaneEntries(entries: readonly EntryRecord[]): void {
    for (const entry of entries) {
      const cell = laneEntryFor(entry);
      if (cell === undefined) continue;
      const id = String(cell.id);
      const at = this.laneEntryIndex.get(id);
      if (at === undefined) {
        this.laneEntryIndex.set(id, this.laneEntries.length);
        this.laneEntries.push(cell);
      } else {
        this.laneEntries[at] = cell;
      }
    }
    this.applyLaneEntries();
  }

  private applyLaneEntries(): void {
    // Every apply replaces the transcript's cells instead of appending them
    // (the app's revision counter makes the snapshot a replacement).
    this.app.applyLaneEntries(this.laneEntries);
    this.onUpdate?.();
  }

  // The in-flight runs (issue #312): a quit waits on them, bounded. The
  // runner is BUSY while a submit is still being admitted or a run is placed
  // — a queued item waiting in the inbox is not work in flight (#334).
  run(prompt: string, options: TuiTurnOptions = {}): Promise<TuiTurnOutcome> {
    const state: TuiRunState = { placed: false, pending: true };
    const running = this.runTurn(
      prompt,
      {
        ...options,
        onSubmitted: (submissionId, admitted) => {
          state.pending = false;
          state.submissionId = submissionId;
          // A submission admitted into the inbox (a busy follow-up, or one
          // queued behind a failed run's leftovers) is not placed work: it
          // becomes busy only if the harness places it later, which the
          // `run-start` event below reports.
          state.placed = admitted === 'placed';
          options.onSubmitted?.(submissionId, admitted);
        },
      },
      state,
    );
    this.runs.set(running, state);
    const finished = (): void => {
      this.runs.delete(running);
      // The busy period ends with its LAST turn: only then is the lane-event
      // subscription released (a queued follow-up still streaming must keep
      // its consumer).
      if (this.runs.size === 0) void this.releaseSubscription();
    };
    void running.then(finished, finished);
    return running;
  }

  // Issue #334: the harness placed a submission (`run-start`): the run that
  // was waiting for it is working now, so the busy latch must follow.
  private markPlacedInputs(inputs: readonly SubmissionId[]): void {
    for (const state of this.runs.values()) {
      if (state.submissionId === undefined) continue;
      if (inputs.some((input) => String(input) === state.submissionId)) {
        state.placed = true;
      }
    }
  }

  // Issue #334: the busy period's ONE subscription. It is taken by the first
  // turn and dropped when the last settles, so a queued follow-up's run —
  // placed by the harness after the first turn answers — keeps feeding the
  // same app feed. The attach snapshot is snapshot-safe (#398): REPLACE
  // semantics mean re-taking it loses nothing.
  private async ensureSubscription(): Promise<void> {
    if (this.attached) return;
    const attaching =
      this.attaching ??
      (async () => {
        this.detach = await this.loop.subscribe(this.sink, this.loop.context);
        this.attached = true;
      })();
    this.attaching = attaching;
    try {
      await attaching;
    } finally {
      if (this.attaching === attaching) this.attaching = undefined;
    }
  }

  private async releaseSubscription(): Promise<void> {
    // A turn may have subscribed and settled inside the same tick: wait for
    // that attempt before reading what it installed.
    if (this.attaching !== undefined) {
      await this.attaching.catch(() => undefined);
    }
    // A turn may have arrived while this release waited for the attach:
    // never drop the consumer of a live run.
    if (this.runs.size > 0 || !this.attached) return;
    const detach = this.detach;
    this.detach = undefined;
    this.attached = false;
    try {
      await detach?.();
    } catch {
      // A torn-down watch is not a turn failure.
    }
  }

  // Issue #312 (§18, #109): quitting mid-turn aborts and drains the
  // conversation — the durable abort, then every registered kill — and waits
  // for the run to settle, at most until `bound` resolves. A quit that lands
  // before the submit waits for the placement and aborts then (see below).
  // When the bound wins, the registered kills still run: the registry drain
  // is the backstop and must not queue behind an abort that may never answer
  // (`abortLane` drains them again — a no-op).
  async drainForQuit(bound: Promise<void>): Promise<void> {
    if (!this.isRunning()) return;
    this.aborted = true;
    this.quitting = true;
    // The run may not be placed yet: aborting now would hit an idle
    // conversation and the turn would outlive the quit. Wait for the
    // placement (or the turn's end) first, bounded by the same quit bound so
    // a submit that never lands cannot hang the quit either.
    await Promise.race([this.placed, bound]);
    await Promise.race([
      this.loop.abort(this.loop.context).catch(() => undefined),
      bound,
    ]);
    for (const kill of this.loop.kills.drain(this.loop.killsKey)) {
      try {
        kill();
      } catch {
        // Already exited — the registry drains every entry regardless.
      }
    }
    // Every turn of the busy period settles before the quit resolves: the
    // follow-ups the abort withdrew settle as aborted on the same path.
    const settled = Promise.all(
      [...this.runs.keys()].map((running) =>
        running.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ).then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([settled, bound]);
  }

  // One turn: settle it on the durable lane, then hand the turn's own record
  // to the run's §46 trajectory (issue #383) — the recording never changes
  // the turn's outcome. The record is per-turn (#334): two runs can overlap
  // while a follow-up waits in the inbox.
  private async runTurn(
    prompt: string,
    options: TuiTurnOptions,
    state: TuiRunState,
  ): Promise<TuiTurnOutcome> {
    const startedAt = Date.now();
    const record: { turn?: TurnOutcome } = {};
    const outcome = await this.drive(prompt, options, record, state);
    try {
      await this.loop.recordTurn?.({
        prompt,
        startedAt,
        outcome,
        ...(record.turn === undefined ? {} : { turn: record.turn }),
      });
    } catch {
      // The trajectory observes the turn; it never changes its outcome.
    }
    return outcome;
  }

  private async drive(
    prompt: string,
    options: TuiTurnOptions,
    record: { turn?: TurnOutcome },
    state: TuiRunState,
  ): Promise<TuiTurnOutcome> {
    this.aborted = false;
    // The first run of the busy period owns the placement latch: Ctrl-C
    // waits for THE running turn to be placed, not for a queued follow-up's
    // admission (which is immediate and needs no placement).
    const first = !this.placementOwned;
    this.placementOwned = true;
    let markPlaced: () => void = () => {};
    const placed = new Promise<void>((resolve) => {
      markPlaced = resolve;
    });
    if (first) {
      this.placed = placed;
      this.markPlaced = markPlaced;
    }
    try {
      // The subscription is snapshot-safe (#398): the attach snapshot
      // replaces the feed, so nothing committed between the boot read and
      // this turn can be lost, and no event can arrive before the sink is
      // listening. ONE subscription serves the whole busy period (#334).
      await this.ensureSubscription();
      const turn = await this.loop.runTurn(prompt, {
        // The prompt is this invocation's own intent: a fresh id per submit
        // so pi-durable's requestId dedupe never collapses two prompts the
        // operator really sent (#395 idempotency rule).
        requestId: randomUUID(),
        context: this.loop.context,
        // Issue #334: a queued follow-up / steer is the caller's explicit
        // mode; anything else keeps `reject` — a submit that races a
        // settling turn fails loudly instead of sitting in the inbox.
        whenBusy: options.whenBusy ?? 'reject',
        ...(options.onSubmitted === undefined
          ? {}
          : { onSubmitted: options.onSubmitted }),
      });
      record.turn = turn;
      // A SETTLED turn's kills are forgotten, not run: a kept background job
      // outlives Kubic, and a recycled pid must not receive a stale group
      // SIGTERM. A failed outcome is not settled — the busy refusal never
      // owned a turn and a failed wait may still have a live durable run —
      // so its kills stay registered for the abort/quit drain. A quit keeps
      // them for the session close's backstop either way.
      if (
        !this.quitting &&
        (turn.kind === 'completed' || turn.kind === 'aborted')
      ) {
        this.loop.forgetKills();
      }
      // One settling read completes the feed (the user entry the submit
      // committed is not carried by any mapped event): events drive the live
      // transcript, this single read is the turn's full one.
      await this.refreshTranscript();
      // The lane's own terminal record is authoritative: an abort that raced
      // a completing turn must not be relabelled as cancelled (the work
      // really did land), and a turn the abort did stop settles 'aborted'.
      if (turn.kind === 'completed') return { status: 'completed' };
      if (turn.kind === 'aborted') return { status: 'cancelled' };
      // `FailureCode` is #52's closed vocabulary; the busy refusal is Kubic's
      // own reason (D6.1) and may or may not be part of it depending on the
      // turn module's typing, so the comparison is on the plain string.
      const reason: string = turn.reason;
      if (reason === TURN_BUSY_REASON) {
        // The busy refusal keeps the shape the operator saw when the lane
        // refused an admission: the prompt never reaches the model.
        return {
          status: 'failed',
          detail: `lane refused the prompt: ${turn.error ?? 'the conversation is busy'}`,
        };
      }
      return {
        status: 'failed',
        detail: turn.error ?? `lane ${turn.reason}`,
      };
    } catch (error) {
      // Defensive: lane/turn.ts maps a rejected submit to a busy failure
      // (D6.1), so a ConversationBusy escaping here is a wiring bug — report
      // it as the refusal it is instead of crashing the loop.
      if (error instanceof ConversationBusy) {
        return {
          status: 'failed',
          detail: `lane refused the prompt: ${error.message}`,
        };
      }
      throw error;
    } finally {
      // A run that never started (a refused submit, a failure) must not
      // leave a latched Ctrl-C waiting for a placement that cannot come, nor
      // hold the busy latch as a pending submit forever.
      state.pending = false;
      if (first) this.placementOwned = false;
      markPlaced();
    }
  }

  // The durable abort path (D6.2): conversation.abort + the conversation's
  // kill drain. It THROWS when the abort or a kill fails, so the cancel path
  // reports a refusal instead of a silent no-op and the quit drain can bound
  // it. The abort targets the conversation, which is the only turn that can
  // be in flight here (the runner admits one turn at a time).
  private async abort(): Promise<void> {
    await this.loop.abort(this.loop.context);
  }

  // Ctrl-C: true (the solo lane always is; the orchestrator lane only when
  // its drive exposes an abort seam). Part of TuiTurnDriver.
  canCancel(): boolean {
    return true;
  }

  // True between a cancel request and the turn settling: the loop uses it to
  // distinguish the *first* Ctrl-C (cancel the operation) from a second one
  // (quit), which is the shipped contract in docs/cli/commands.md.
  isCancelling(): boolean {
    return this.aborted && this.isRunning();
  }

  // Cancels the in-flight turn. Returns false when nothing is running, so
  // the caller can fall through to quit. Before the submit lands the request
  // is latched and replayed by `drive`, so the key is never lost. It THROWS
  // when the abort refused (abortLane aggregates the failure); the key
  // handler catches it and reports it, so a refusal is never a silent no-op
  // and never an unhandled rejection.
  async cancel(): Promise<boolean> {
    if (!this.isRunning()) return false;
    this.aborted = true;
    // A Ctrl-C can beat the durable submit: aborting an idle conversation is
    // a no-op, so the abort waits for the run's own `run-start` placement (or
    // for the turn to end) instead of slipping between the two.
    await this.placed;
    if (this.quitting) return true;
    await this.abort();
    return true;
  }

  // Reads are tagged in issue order: a background refresh that resolves
  // after a newer one (e.g. the settlement refresh) is dropped instead of
  // overwriting the fresher feed.
  private readSeq = 0;
  private appliedSeq = 0;

  async refreshTranscript(): Promise<void> {
    this.readSeq += 1;
    const seq = this.readSeq;
    const entries = await this.loop.entries(this.loop.context);
    if (seq < this.appliedSeq) return;
    this.appliedSeq = seq;
    // The accumulated event feed is the live transcript; a settling read
    // replaces it with the completed one (D6.5's readConversationEntries).
    this.replaceLaneEntries(entries);
  }
}

// The `/model` command of the interactive loop (issue #227; §38.1). One
// parser for the three forms the loop acts on — report, switch, invalid —
// so the submit path and its tests agree on what is a command and what is a
// prompt handed to the lane.
export type TuiModelCommand =
  | { kind: 'report' }
  | { kind: 'switch'; selection: ModelSelection }
  | { kind: 'invalid'; message: string };

export function parseModelCommand(prompt: string): TuiModelCommand | undefined {
  if (prompt !== '/model' && !prompt.startsWith('/model ')) return undefined;
  const argument =
    prompt === '/model' ? '' : prompt.slice('/model '.length).trim();
  if (argument === '') return { kind: 'report' };
  try {
    return { kind: 'switch', selection: parseModelFlag(argument) };
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// The `/compact [instructions]` command of the interactive loop (#330;
// §27.2). `undefined` means the draft is a prompt, not the command; the
// focus is the instructions Pi hands the summarizer (verbatim, via
// compaction.ts's compact prompt), absent when the operator typed `/compact`
// alone. One parser for the dispatch and its tests.
export interface TuiCompactCommand {
  readonly focus: string | undefined;
}

export function parseTuiCompactCommand(
  prompt: string,
): TuiCompactCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/compact' && !trimmed.startsWith('/compact ')) {
    return undefined;
  }
  const focus = parseCompactCommand(trimmed).trim();
  return { focus: focus === '' ? undefined : focus };
}

// The parsed `kubic tui` invocation (commander owns the argv:
// ./commands/solo.ts). The parity flags (issue #113) carry the same names
// and value rules as their `kubic run` counterparts.
export interface TuiCommandOptions {
  readonly session?: string;
  readonly role?: string;
  readonly skills?: readonly string[];
  readonly noSkills?: boolean;
  // §41.4 (issue #308): session-scoped full access (bare `kubic` and `tui`).
  readonly dangerouslySkipApprovals?: boolean;
  // Issue #295: `--model <provider/id>`, parsed by the registrar for help and
  // validation only — dispatch already fed it to the config load as the `cli`
  // layer, so the boot reads it from the projected pin, never from here.
  readonly model?: ModelSelection;
  // Issue #327 (§17, §81): `--orchestrator` — start the session in
  // orchestrator mode (delegation stays opt-in; solo is the default).
  readonly orchestrator?: boolean;
}

export async function runTuiCommand(
  options: TuiCommandOptions,
  deps: TuiRunDeps,
): Promise<number> {
  const sessionId = options.session;
  // Issue #327 (§17, §81): solo is the architecture and the default; the
  // flag is the explicit opt-in and the config `[modes]` key is the session
  // default under it. resolveOrchestratorMode owns the precedence.
  const mode = resolveOrchestratorMode({
    cliFlag: options.orchestrator === true,
    configValue: deps.modes?.orchestrator === true,
  });
  // Orchestrator mode needs git worktrees: refuse BEFORE the alt-screen
  // opens, with the manager lane's own named message and exit 5 — never a
  // silent fallback to solo.
  if (mode === 'orchestrator' && deps.isGitRepo !== undefined) {
    const isRepo = await deps.isGitRepo();
    if (!isRepo) {
      const refusal = buildOrchestratorRefusal();
      (deps.err ?? deps.out)(`error: ${refusal.message}`);
      return refusal.exitCode;
    }
  }
  const flags: TuiBootFlags = {};
  if (options.role !== undefined) flags.role = options.role;
  if (options.noSkills === true) flags.noSkills = true;
  const skillsList = options.skills ?? [];
  if (skillsList.length > 0) flags.skillsList = [...skillsList];
  if (options.dangerouslySkipApprovals === true) {
    flags.dangerouslySkipApprovals = true;
  }
  // commander validated the id already; re-checked because it becomes a
  // path segment under the sessions root.
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    (deps.err ?? deps.out)(
      `error: invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
    return RUN_EXIT_USAGE;
  }
  // Issue #96: the approval surface must exist BEFORE the lane boots, because
  // the boot installs the policy that consults the seat. The root therefore
  // creates the surface, hands its ask to the boot AS the seat, and attaches
  // the same surface to the app it builds for this boot — one object, so the
  // verdict collected on screen is the verdict the lane receives.
  const surface = createApprovalSurface({
    ...(deps.approvalArmingMs === undefined
      ? {}
      : { armingMs: deps.approvalArmingMs }),
    ...(deps.approvalClock === undefined ? {} : { now: deps.approvalClock }),
  });
  let boot: TuiLaneBoot;
  try {
    boot = await deps.bootLane(sessionId, surface.seat, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (deps.err ?? deps.out)(`error: ${message}`);
    if (error instanceof ModelSelectError)
      return RUN_EXIT_PROVIDER_PROBE_FAILED;
    return mapCaughtErrorToTerminus(error) === 'workspace_unavailable'
      ? RUN_EXIT_WORKSPACE_UNAVAILABLE
      : RUN_EXIT_FAILED;
  }
  // Colour only for a real terminal; NO_COLOR / FORCE_COLOR honoured.
  // Issue #319: the level is injectable (tests pass 'none', so the suite
  // never depends on the shell's colour variables) and the theme this run
  // replaces is restored when it ends — the global never leaks.
  const previousTheme = tuiTheme();
  setTuiTheme(
    createTuiTheme(
      deps.colorLevel ??
        detectColorLevel(process.env, process.stdout.isTTY === true),
    ),
  );
  // Issue #308: the full-access warning lands on stderr (the main screen)
  // before the alt-screen opens, and the bar shows OFF from the first frame.
  for (const notice of boot.notices ?? []) {
    (deps.err ?? deps.out)(`warning: ${notice}`);
  }
  const app = createTuiApp({
    sessionId: boot.sessionId,
    model: boot.model,
    approvalSurface: surface,
    // Issue #307/#327: the session mode comes from the resolution above —
    // never a literal, so the indicator and the submit routing cannot
    // disagree with what the entry actually selected. The approvals half
    // still comes from the installed policy.
    mode,
    approvalsSkipped: boot.approvalsSkipped?.() ?? boot.fullAccess === true,
    ...(boot.contextLimits?.contextWindow === undefined
      ? {}
      : { contextWindow: boot.contextLimits.contextWindow }),
    ...(boot.contextLimits?.compactionThreshold === undefined
      ? {}
      : { compactionThreshold: boot.contextLimits.compactionThreshold }),
  });
  // Issue #346: the resumed session's committed spend is on the bar from the
  // first frame, not only after the next turn's usage event.
  app.setUsage(boot.usageRows ?? []);
  // Re-read after each turn (and each mid-turn refresh): a posture change
  // lands on the indicator in the same frame the loop paints next.
  const syncPosture = (): void => {
    if (boot.approvalsSkipped !== undefined)
      app.setApprovalsSkipped(boot.approvalsSkipped());
  };
  const terminal = deps.createTerminal();
  // Solo no-isolation notice (issue #89): the trust statement is carried in
  // the editor footer — the loop's always-visible status surface — from the
  // first render, and it returns after every turn that has no outcome of its
  // own to report. Suppressed for orchestrator-managed children
  // (KUBIC_WORKER_ID set) and for the documented KUBIC_NO_NOTICE opt-out;
  // the text is solo-warning.ts's, never re-worded here.
  const soloNotice = shouldEmitSoloNotice(process.env) ? soloTuiLine() : '';
  // Issue #327: an orchestrator session gets the orchestrator's own honest
  // limits, not the solo statement — the footer must never describe the
  // wrong lane. The text is orchestrator-notice.ts's, verbatim.
  const orchestratorNotice = buildOrchestratorWorktreeNotice()
    .slice(0, 2)
    .join(' · ');
  const laneNotice = (laneMode: StatusMode): string =>
    laneMode === 'orchestrator' ? orchestratorNotice : soloNotice;
  // The faux testing provider is never silent: while it answers, the
  // footer says so next to (or instead of) the lane notice.
  const noticeFor = (laneMode: StatusMode): string => {
    const base = laneNotice(laneMode);
    return boot.model === `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`
      ? [FAUX_FOOTER, base].filter((part) => part !== '').join(' · ')
      : base;
  };
  const notice = noticeFor(mode);
  // Issue #311: the Ctrl-O / Ctrl-R panels read the session journal the
  // boot created — loaded once now (a resumed session shows its earlier
  // turns), after each tool call (throttled) and at every settlement.
  // Declared before the feed: its `apply` reads both, and the boot read below
  // runs synchronously — a `let` declared later is a TDZ ReferenceError there
  // that the feed's catch would swallow on every boot.
  let screen: Screen | undefined;
  let stopped = false;
  const journalStore = boot.journal;
  const journalFeed =
    journalStore === undefined
      ? undefined
      : new JournalPanelFeed({
          read: () => diffEntries(journalStore, {}),
          apply: (rows) => {
            app.setJournalChanges(rows);
            if (!stopped) screen?.update();
          },
          ...(deps.journalFeedError === undefined
            ? {}
            : { onError: deps.journalFeedError }),
        });
  journalFeed?.now();
  // Issue #311: set when a shell tool ended in the turn in flight — the only
  // builtin whose writes bypass the journal, so the only reason a settlement
  // needs the reconcile sweep (which walks and hashes the whole workspace:
  // not free, so file-tool and read-only turns skip it).
  let shellRanThisTurn = false;
  // Issue #334: the conversation's inbox as the lane reports it (`pi.inbox`
  // via `inbox_update`), plus the prompt text of every submission the loop
  // queued — the inbox carries ids, not content. The `queued: …` rows are
  // derived from the two (and only from them), so admission, placement and
  // withdrawal all come from pi-durable's own queue: Kubic owns no queue
  // state and cannot promise a delivery the harness did not take.
  let queuedInbox: readonly KubicInboxItem[] = [];
  const queuedText = new Map<string, string>();
  const queuedCount = (): number =>
    queuedInbox.filter((item) => queuedText.has(item.id)).length;
  const syncQueuedRows = (): void => {
    app.setQueuedPrompts(
      queuedInbox
        .map((item) => queuedText.get(item.id))
        .filter((text): text is string => text !== undefined),
    );
  };
  const turn =
    boot.loop === undefined
      ? undefined
      : new TuiTurnRunner(
          app,
          boot.loop,
          boot.model,
          () => {
            syncPosture();
            if (!stopped) screen?.update();
          },
          (event) => {
            if (event.type === 'tool-end') {
              if (event.toolName === SHELL_TOOL_NAME) shellRanThisTurn = true;
              journalFeed?.request();
            }
            // Issue #334: a fresh inbox list replaces the queued rows (it is
            // a snapshot); a `run-start` names the submission the harness
            // just PLACED, so its row becomes the pending echo instead.
            if (event.type === 'inbox') {
              queuedInbox = event.items;
              syncQueuedRows();
              if (!stopped) screen?.update();
            }
            if (event.type === 'run-start') {
              for (const input of event.inputs) {
                const id = String(input);
                const text = queuedText.get(id);
                if (text === undefined) continue;
                queuedText.delete(id);
                app.setPendingEcho(text);
              }
              syncQueuedRows();
              // The placed submission is work in flight now: a queued
              // follow-up that waited behind a failed run starts the spinner
              // again (#334 review).
              syncBusyForLoop?.();
              if (!stopped) screen?.update();
            }
          },
          boot.usageRows,
        );
  // Issue #327: the orchestrator turn the toggle switches to. Absent means
  // this boot is solo-only (viewer/fake lanes): the submit path refuses by
  // name instead of falling back into solo silently.
  const orchestratorTurn =
    boot.orchestrator === undefined
      ? undefined
      : new TuiOrchestratorTurn(boot.orchestrator, (line) => {
          app.appendReport([line]);
          if (!stopped) screen?.update();
        });
  // The driver of the turn in flight, whichever lane owns it (#327).
  let activeTurn: TuiTurnDriver | undefined;
  // Issue #334 (review): the busy latch follows PLACED work, and the lane
  // event handler above (registered before the submit path exists) must
  // re-sync it when the harness places a queued submission.
  let syncBusyForLoop: (() => void) | undefined;
  // The working indicator animates while a turn runs.
  let spinner: ReturnType<typeof setInterval> | undefined;
  const stopSpinner = (): void => {
    if (spinner !== undefined) clearInterval(spinner);
    spinner = undefined;
  };
  const startSpinner = (): void => {
    stopSpinner();
    spinner = setInterval(() => {
      if (stopped || app.busyElapsedMs() === undefined) {
        stopSpinner();
        return;
      }
      screen?.update();
    }, 100);
    spinner.unref?.();
  };
  let exitCode = RUN_EXIT_OK;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  // Issue #313 (§16.1, §18): SIGINT, SIGTERM and SIGHUP all run the same
  // shutdown (mid-turn drain, restore, sweep, close) and exit 128+signo. The
  // listeners stay attached until the terminal is restored, so a second
  // signal during the drain only shortens it; they are detached before the
  // session close, so a signal after that takes the default disposition.
  const signals: TuiProcessEvents = deps.signals ?? process;
  const signalListeners = new Map<TuiSignal, (value: unknown) => void>();
  for (const name of TUI_SIGNALS) {
    signalListeners.set(name, () => {
      if (!stopped) exitCode = signalExitCode(name);
      shutdown();
    });
  }
  let signalsAttached = false;
  const attachSignals = (): void => {
    if (signalsAttached) return;
    signalsAttached = true;
    for (const [name, listener] of signalListeners) signals.on(name, listener);
  };
  const detachSignals = (): void => {
    if (!signalsAttached) return;
    signalsAttached = false;
    for (const [name, listener] of signalListeners) signals.off(name, listener);
  };
  // Issue #313: the last-resort restore. An exception in input or render, or
  // an unhandled rejection, would otherwise kill the process with the alt
  // screen, raw mode, mouse tracking and the Kitty protocol still active.
  // The terminal is restored first (nothing is printed — the layout may be
  // what threw), then the error is reported and the process exits 1.
  let fatalHandled = false;
  const fatal = (error: unknown): void => {
    if (fatalHandled) return;
    fatalHandled = true;
    stopped = true;
    exitCode = RUN_EXIT_FAILED;
    stopSpinner();
    endDrain?.();
    try {
      screen?.restore();
    } catch {
      // Best effort: the report below must still happen.
    }
    detachSignals();
    detachFatal();
    stdin?.removeListener('end', onStdinEnd);
    stdin?.removeListener('close', onStdinEnd);
    surface.cancelPending('the session ended before the approval was answered');
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    (deps.err ?? deps.out)(`error: kubic tui crashed: ${detail}`);
    (deps.exit ?? ((code: number) => process.exit(code)))(RUN_EXIT_FAILED);
    resolveExit();
  };
  const fatalListener = (value: unknown): void => {
    fatal(value);
  };
  let fatalAttached = false;
  const attachFatal = (): void => {
    if (fatalAttached) return;
    fatalAttached = true;
    for (const name of TUI_FATAL_EVENTS) signals.on(name, fatalListener);
  };
  const detachFatal = (): void => {
    if (!fatalAttached) return;
    fatalAttached = false;
    for (const name of TUI_FATAL_EVENTS) signals.off(name, fatalListener);
  };
  // Stdin EOF (a closed pty, `kubic tui < /dev/null`, or a shell that
  // detached the tty) is a quit: Pi's terminal never reports it, so a
  // missing handler would leave the alt-screen hung on a dead input stream
  // forever. Registered only when the stream exists, and always removed.
  const stdin = process.stdin;
  const onStdinEnd = (): void => {
    shutdown();
  };
  // Issue #312: set while a quit drains a running turn; calling it ends the
  // wait at once (a second Ctrl-C, a second SIGINT, or the bound firing).
  let endDrain: (() => void) | undefined;
  const shutdown = (): void => {
    if (stopped) {
      // A second quit while the drain waits shortens it: the kills already
      // ran, so the loop exits now instead of at the bound.
      endDrain?.();
      return;
    }
    stopped = true;
    stopSpinner();
    // Issue #96: a quit (SIGINT, stdin EOF, or the loop's own quit path) must
    // settle a pending approval as a deny — the turn that is waiting on it
    // would otherwise sit until the lane's timeout, and the operator gets no
    // second chance to answer a screen they have left.
    surface.cancelPending('the session quit before the approval was answered');
    stdin?.removeListener('end', onStdinEnd);
    stdin?.removeListener('close', onStdinEnd);
    // Issue #312 (§18, §42.5, #109): a turn still running is aborted and
    // drained BEFORE the sweep and the session close — otherwise its detached
    // process group outlives the session, its late writes escape both the
    // journal and the reconciliation, and the operation never records a
    // terminal status. The screen stays up (footer: cancelling…) until the
    // drain ends, bounded by drainTimeoutMs.
    const draining = activeTurn?.isRunning() === true;
    // Issue #312: the drain has its own bound, and the close gets a FRESH one
    // of its own: pi-durable's `Harness.close` joins live task invocations
    // (`beforeClose`), so a provider that ignores the abort must not hang the
    // quit — but a drain that consumed its whole budget must not leave the
    // close (the session lock release among it) zero time either.
    let drainBound: Promise<void> | undefined;
    let endBound: () => void = () => {};
    if (draining) {
      drainBound = new Promise<void>((resolve) => {
        endDrain = resolve;
        endBound = (deps.setDrainTimer ?? defaultDrainTimer)(
          deps.drainTimeoutMs ?? TUI_DRAIN_TIMEOUT_MS,
          resolve,
        );
      });
      app.setEditorFooter('cancelling…');
      screen?.render();
    }
    void (async () => {
      if (draining && activeTurn !== undefined && drainBound !== undefined) {
        try {
          await activeTurn.drainForQuit(drainBound);
        } catch {
          // The drain is best-effort; the sweep and close still run.
        }
      }
      if (fatalHandled) return;
      // Issue #313: pop the Kitty protocol and let late input (the quitting
      // key's release, especially over SSH) arrive and be swallowed here
      // instead of printing as `[27;1:3u` in the operator's shell.
      try {
        await terminal.drainInput();
      } catch {
        // Draining is best effort; the restore below still runs.
      }
      if (fatalHandled) return;
      try {
        screen?.stop((line: string) => deps.out(line));
      } catch {
        // Restore failures never mask the clean quit.
      }
      detachSignals();
      // The close joins the harness's live task invocations: a close that
      // cannot finish inside ITS OWN fresh bound is abandoned — the process is
      // leaving anyway, and the next attach reclaims the stale lock by pid
      // liveness. The harness's own storage may stay open until then. A quit
      // key that arrives while the close waits ends that wait at once
      // (`endDrain` points at the close bound from here on).
      endBound();
      const closeBound = new Promise<void>((resolve) => {
        endDrain = resolve;
        endBound = (deps.setDrainTimer ?? defaultDrainTimer)(
          deps.drainTimeoutMs ?? TUI_DRAIN_TIMEOUT_MS,
          resolve,
        );
      });
      try {
        await Promise.race([boot.close?.(), closeBound]);
      } catch {
        // Close failures never mask the clean quit.
      }
      endBound();
      endDrain = undefined;
      detachFatal();
      resolveExit();
    })();
  };
  try {
    const booted = bootScreen(terminal, app.root);
    screen = booted;
    // Issue #88: focus the editor, not the tree — the loop's primary input
    // target is the prompt. T/t no longer toggle (they type); Ctrl-T does.
    booted.tui.setFocus(app.editor);
    app.editor.bind(booted.tui);
    // Issue #96: the overlay seat. The app renders the approval through the
    // live alt-screen from here on; on a terminal too narrow for the overlay
    // (its own visible() gate) the inline body is the surface instead.
    app.attachApprovalOverlay(booted.tui);
    // The trust statement is on screen before the operator types anything
    // (issue #89): the footer is set before the first render, so the very
    // first frame carries it. Empty when suppressed.
    // Issue #147: a pending operation settled at boot is reported first;
    // the trust statement returns as the idle footer after the next turn.
    app.setEditorFooter(
      [boot.pendingNotice, boot.modelNotice]
        .filter((line): line is string => line !== undefined)
        .join(' · ') || notice,
    );
    attachFatal();

    booted.render();
    attachSignals();
    stdin?.once('end', onStdinEnd);
    stdin?.once('close', onStdinEnd);
    booted.tui.addInputListener((data: string) => {
      // Issue #313: an exception anywhere in input handling (including the
      // synchronous paints it triggers) restores the terminal first.
      try {
        return routeInput(data);
      } catch (error) {
        fatal(error);
        return { consume: true };
      }
    });
    // Issue #334: the one submit path is defined with the lane wiring below
    // (it needs the drivers and the session mode), while this key router is
    // registered first — so the steer key reaches it through this holder.
    let submitForLoop:
      | ((prompt: string, steer: boolean) => TuiSubmitOutcome)
      | undefined;
    // Issue #334: how many queued prompts the cancel in flight is about to
    // withdraw. pi-durable's abort clears the inbox, so the settlement
    // footer of every cancelled turn names the count — deterministic,
    // whichever of the running/queued turns settles last.
    let droppedOnCancel = 0;
    const routeInput = (data: string): { consume: true } | undefined => {
      if (stopped) {
        // Issue #312: while a quit drains, a second Ctrl-C ends the wait.
        // Only a real press counts (issue #306): a held key's repeats and
        // its release are the same key, and repeats of global keys are
        // ignored everywhere else, so a held Ctrl-C must not cut the drain.
        if (!isKeyRelease(data) && !isKeyRepeat(data) && keyIs(data, 'ctrl+c'))
          shutdown();
        return { consume: true };
      }
      // Issue #306, defence in depth: TuiApp.handleInput already drops Kitty
      // key releases, but the quit/cancel counting below must never see one
      // even if a future caller routes around it — a Ctrl-C release counted
      // as the second Ctrl-C would quit the session on key-up.
      if (isKeyRelease(data)) return { consume: true };
      const routed = app.handleInput(data);
      // Issue #334: Alt+Enter carried the draft out of the editor. Busy, the
      // text steers the running turn through the harness' steer queue; idle,
      // it submits like Enter (with the same pending echo).
      if (routed.steer !== undefined) {
        const steered = routed.steer;
        const outcome = submitForLoop?.(steered, true);
        if (outcome === 'refused') {
          // Issue #334 (review): only a REFUSAL hands the draft back — the
          // app already cleared it for the key, and an accepted `/model`
          // steer must not resurrect the command it just ran.
          app.restoreDraft(steered);
        } else if (
          outcome === 'accepted' &&
          parseModelCommand(steered) === undefined
        ) {
          app.setPendingEcho(steered);
        }
        return { consume: true };
      }
      if (routed.quit) {
        if (routed.cancel && activeTurn?.isRunning()) {
          // Issue #327: a lane that cannot cancel never fakes it — Ctrl-C
          // quits instead (the shutdown drain is bounded, and the manager's
          // signal guard reaps live workers on process exit).
          if (!activeTurn.canCancel()) {
            shutdown();
            return { consume: true };
          }
          // Ctrl-C during a turn. The first one cancels the operation and
          // keeps the session alive; a second one (while the cancellation is
          // still draining) quits, which is the contract docs/cli/commands.md
          // ships. The footer is set synchronously so the cancellation is
          // visible on the very next frame — the abort itself is async.
          if (!activeTurn.isCancelling()) {
            const cancelling = activeTurn;
            // Issue #334: the queue is pi-durable's, and the abort withdraws
            // every queued input with it (`conversation.abort()`). Count what
            // goes so the cancelled turns' footers can say it, instead of
            // the prompts silently vanishing.
            droppedOnCancel = queuedCount();
            app.setEditorFooter('cancelling…');
            screen?.render();
            void cancelling
              .cancel()
              .then((accepted) => {
                if (stopped) return;
                // A refused abort must never be silent: without this the
                // operator presses Ctrl-C, the lane refuses (requestLaneAbort
                // throws LaneDriveError), and the screen shows nothing —
                // a no-op key with no explanation. The loop keeps running.
                if (!accepted) {
                  droppedOnCancel = 0;
                  app.setEditorFooter('cancel failed — turn still running');
                }
                screen?.render();
              })
              .catch((error: unknown) => {
                if (stopped) return;
                app.setEditorFooter(
                  `cancel failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                screen?.render();
              });
            return { consume: true };
          }
        }
        shutdown();
        return { consume: true };
      }
      // Issue #274: a consuming listener pre-empts pi-tui's own post-input
      // render (it only runs on the focused-component path), so every key
      // the app consumed — a typed character, a global toggle, an approval
      // decision — asks for its frame here. Without it nothing repaints
      // while idle: no spinner, no turn refresh.
      if (routed.consumed) {
        screen?.update();
        return { consume: true };
      }
      return undefined;
    };
    if (turn !== undefined || orchestratorTurn !== undefined) {
      // Issue #227: `/model` never reaches the lane as a prompt. The report
      // and the refusal are footer lines (the editor row's always-visible
      // status surface); a successful switch updates the app's model label
      // and leaves a confirmation behind.
      const handleModelCommand = (command: TuiModelCommand): void => {
        if (turn === undefined) {
          app.setEditorFooter('model switch needs the solo lane');
          if (!stopped) screen?.render();
          return;
        }
        if (command.kind === 'report') {
          app.setEditorFooter(`model: ${turn.modelRef}`);
          if (!stopped) screen?.render();
          return;
        }
        if (command.kind === 'invalid') {
          app.setEditorFooter(`model switch failed: ${command.message}`);
          if (!stopped) screen?.render();
          return;
        }
        app.setEditorFooter(
          `switching model to ${command.selection.provider}/${command.selection.id}…`,
        );
        if (!stopped) screen?.render();
        void turn
          .switchModel(command.selection)
          .then((label) => {
            if (stopped) return;
            app.setEditorFooter(`model: ${label} (switched)`);
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `model switch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };
      // Issue #334: one accepted prompt → one turn on its driver. A busy
      // Enter starts a SECOND run while the first is still in flight (the
      // harness queues it), so the busy latch counts turns instead of
      // holding one: the spinner and the editor stay in flight until the
      // last settles.
      let inFlightTurns = 0;
      // Issue #334 (review): the busy latch follows PLACED work, not
      // submitted promises. A follow-up waiting in the inbox — admitted while
      // a turn ran, or left behind by a failed run (pi-durable keeps queued
      // inputs after a fault) — is not a run: the spinner stops and the
      // queued row is what the operator sees. `activeTurn` outlives it, so a
      // later submit places the queue and the same driver runs again.
      const syncBusy = (): void => {
        if (stopped) return;
        const running = activeTurn?.isRunning() === true;
        if (running && !app.isBusy()) {
          app.setBusy(true);
          startSpinner();
        } else if (!running && app.isBusy()) {
          app.setBusy(false);
          stopSpinner();
        }
        if (!stopped) screen?.render();
      };
      syncBusyForLoop = syncBusy;
      const startTurn = (
        driver: TuiTurnDriver,
        prompt: string,
        options?: TuiTurnOptions,
      ): void => {
        activeTurn = driver;
        inFlightTurns += 1;
        app.setBusy(true);
        startSpinner();
        screen?.render();
        // The settlement footer is applied in `finally`, AFTER the busy
        // reset: `setBusy(false)` clears the footer row, so a footer set in
        // `then` would be wiped when the last turn of the busy period ends.
        let footer: string | undefined;
        void driver
          .run(prompt, {
            ...(options ?? {}),
            // The admission answer decides the latch: placed work keeps the
            // spinner, a queued item releases it (#334 review).
            onSubmitted: (submissionId, admitted) => {
              options?.onSubmitted?.(submissionId, admitted);
              syncBusy();
            },
          })
          .then((outcome) => {
            syncPosture();
            // Issue #311: a bash-made change is journaled only by the sweep;
            // run it BEFORE the panel read so this turn's shell effects are
            // on screen at settlement, not just at quit. A quit in progress
            // owns its own final sweep (close), and a failed sweep leaves
            // the panels on the rows they have.
            if (shellRanThisTurn && !stopped) {
              shellRanThisTurn = false;
              try {
                boot.reconcile?.();
              } catch {
                // Reconciliation observes, it never gates the loop.
              }
            }
            journalFeed?.now();
            // A completed turn has no outcome line of its own, so the footer
            // falls back to the lane's trust statement instead of going
            // blank (issue #89) — a cancelled/failed turn keeps its own
            // report.
            footer = footerForOutcome(outcome) || noticeFor(app.mode());
            if (outcome.status === 'cancelled' && droppedOnCancel > 0) {
              footer = `${footer} · dropped ${droppedOnCancel} queued prompt${droppedOnCancel === 1 ? '' : 's'}`;
            }
            // A driver with its own settlement line (the compaction's
            // `compacted: …`, #330) reports it instead of a turn outcome.
            footer = driver.settlementFooter?.() ?? footer;
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            footer = `error: ${message}`;
          })
          .finally(() => {
            inFlightTurns -= 1;
            if (inFlightTurns === 0) {
              droppedOnCancel = 0;
              if (activeTurn === driver) activeTurn = undefined;
            }
            // Sync BEFORE the footer: `setBusy(false)` clears the footer row.
            syncBusy();
            if (footer !== undefined && !stopped) app.setEditorFooter(footer);
            if (!stopped) screen?.render();
          });
      };

      // Issue #334: the one submit path — Enter, and Alt+Enter when idle.
      // `steer` marks the Alt+Enter form, which becomes a harness steer
      // while a turn runs instead of a queued follow-up.
      const submitPrompt = (
        prompt: string,
        steer: boolean,
      ): TuiSubmitOutcome => {
        if (stopped) return 'refused';
        const busy = activeTurn?.isRunning() === true;
        // Issue #330: `/compact [instructions]` is a lane operation, never a
        // prompt. It runs through the same busy/cancel wrapper as a turn, so
        // the spinner shows and Ctrl-C aborts it; the command text itself
        // never reaches the model or the transcript.
        const compactCommand = parseTuiCompactCommand(prompt);
        if (compactCommand !== undefined) {
          const lane = boot.loop;
          // The session's own transcript is the SOLO lane's; in orchestrator
          // mode the visible lane is the run report, so the command is
          // refused by name instead of compacting a conversation the
          // operator is not looking at (#330 review).
          if (app.mode() === 'orchestrator') {
            app.setEditorFooter(
              'compact: the orchestrator lane has no session transcript to compact',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          if (busy) {
            app.setEditorFooter(
              'compact: finish the current turn before compacting',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          if (lane?.compact === undefined) {
            app.setEditorFooter('compaction needs the solo lane');
            if (!stopped) screen?.render();
            return 'refused';
          }
          startTurn(new TuiCompactionTurn(lane, compactCommand.focus), prompt);
          return 'accepted';
        }
        const modelCommand = parseModelCommand(prompt);
        if (modelCommand !== undefined) {
          // A live switch is a conversation.configure: it never races a run.
          if (busy) {
            app.setEditorFooter(
              'model: finish the current turn before switching',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          handleModelCommand(modelCommand);
          return 'accepted';
        }
        // Issue #327: the NEXT submit goes to the lane the session mode
        // names. The mode is read at submit time, so a Ctrl-G between turns
        // routes the very next prompt — and a session booted without the
        // lane refuses by name instead of pretending it ran there.
        const wantsOrchestrator = app.mode() === 'orchestrator';
        const driver = wantsOrchestrator ? orchestratorTurn : turn;
        if (driver === undefined) {
          app.setEditorFooter(
            wantsOrchestrator
              ? 'error: orchestrator mode is unavailable in this session'
              : 'error: the solo lane is unavailable in this session',
          );
          if (!stopped) screen?.render();
          return 'refused';
        }
        if (busy) {
          // Issue #334: the solo lane queues the prompt in the
          // conversation's OWN inbox — a follow-up (placed when the run
          // answers) for Enter, a steer (placed after the current tool
          // round, joining the running work) for Alt+Enter. The orchestrator
          // lane has one objective and no inbox: it refuses by name instead
          // of pretending to queue.
          if (driver !== turn) {
            app.setEditorFooter(
              'error: an orchestrator run is in flight — wait for it to finish',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          startTurn(
            driver,
            prompt,
            steer
              ? { whenBusy: 'steer' }
              : {
                  whenBusy: 'followUp',
                  onSubmitted: (id) => {
                    queuedText.set(id, prompt);
                    syncQueuedRows();
                  },
                },
          );
          return 'queued';
        }
        startTurn(driver, prompt);
        return 'accepted';
      };

      app.onSubmit((prompt: string) => submitPrompt(prompt, false));
      // The steer key's own entry point (the key router is defined above).
      submitForLoop = submitPrompt;
      await turn?.refreshTranscript();
    }
  } catch (error) {
    // Post-start setup (boot/setFocus/render/input routing) can throw
    // after the alt-screen went active — restore the main screen and
    // close the lane so the reject never strands either. The setup
    // error stands.
    detachSignals();
    detachFatal();
    stdin?.removeListener('end', onStdinEnd);
    stdin?.removeListener('close', onStdinEnd);
    try {
      screen?.stop((line: string) => deps.out(line));
    } catch {
      // Restore failures never mask the setup error.
    }
    try {
      await boot.close?.();
    } catch {
      // Close failures never mask the setup error.
    }
    setTuiTheme(previousTheme);
    throw error;
  }
  await exited;
  setTuiTheme(previousTheme);
  return exitCode;
}
