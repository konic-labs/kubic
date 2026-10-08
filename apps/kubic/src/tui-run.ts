// `kubic tui` (prompt loop): interactive alt-screen over the
// solo lane. The composition root owns every side effect: it boots the real
// solo lane (same session/model setup as the headless runner), opens the
// alt-screen on the replicated presentation, routes keyboard input through
// the tui controller, drives the lane for whatever the user submits, feeds
// lane events into the tree and usage rows into the status bar, and restores
// the main screen with the final document printed — on quit, on a signal,
// and exactly once. `kubic run` is untouched (headless regression:
// tui-command.test.ts + binary exit codes).
//
// Cancellation: Ctrl-C during a turn aborts
// the in-flight conversation through the lane's own durable abort
// (conversation.abort + the conversation's kill drain) and keeps the
// session alive; a second Ctrl-C quits. While idle the first Ctrl-C quits.
// Esc and Ctrl-D-on-an-empty-draft quit too, so no honoured key is a silent
// no-op.

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
  type ManualCompactionOptions,
  type ManualCompactionOutcome,
  parseCompactCommand,
  runCompactCommand,
} from '../../../packages/agent/src/compaction.js';
import {
  abortLane,
  forgetLaneKills,
  type OperationKillRegistry,
} from '../../../packages/agent/src/lane/abort.js';
import type {
  KubicInboxItem,
  KubicLaneEvent,
  LaneEventSink,
} from '../../../packages/agent/src/lane/events.js';
import { subscribeLaneEvents } from '../../../packages/agent/src/lane/events.js';
import {
  describePendingSettlement,
  inspectPending,
  pendingInputText,
  settlePending,
} from '../../../packages/agent/src/lane/pending.js';
import {
  attachSession,
  createSession,
  forkSession,
  listSessions,
  openSessionStore,
} from '../../../packages/agent/src/lane/session-store.js';
import {
  bootLane,
  escalateLaneModel,
  type LaneCompactionOptions,
  type Lane,
} from '../../../packages/agent/src/lane/solo.js';
import {
  entriesToTranscript,
  readConversationEntries,
  type TranscriptItem,
} from '../../../packages/agent/src/lane/transcript.js';
import {
  runTurn,
  TURN_BUSY_REASON,
  type TurnOutcome,
  turnLaneRecord,
} from '../../../packages/agent/src/lane/turn.js';
import type { EscalationLadder } from '../../../packages/agent/src/model-select.js';
import {
  type AnyModel,
  clampThinking,
  ModelSelectError,
  type ModelSelection,
  NoModelAvailableError,
  parseModelFlag,
  supportedThinking,
} from '../../../packages/agent/src/model-select.js';
import {
  isThinkingLevel,
  THINKING_LEVELS,
} from '../../../packages/agent/src/models-config.js';
import { OPERATIONS } from '../../../packages/agent/src/ops/registry.js';
import { walkFiles } from '../../../packages/agent/src/ops/walk.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  ConversationBusy,
  type EntryRecord,
  type ModelThinkingLevel,
  type MutableModels,
  type SubmissionId,
} from '../../../packages/agent/src/pi-boundary.js';
import type { PermissionClasses } from '../../../packages/agent/src/policy.js';
import {
  checkAgreement,
  DEFAULT_PERMISSIONS,
  validateClasses,
} from '../../../packages/agent/src/policy.js';
import type { ModelEscalationEvent } from '../../../packages/agent/src/prompts.js';
import {
  expandSkillInvocation,
  type LoadedSkill,
} from '../../../packages/agent/src/skills/skills.js';
import {
  resolveStreamOptions,
  type StreamTuningTables,
} from '../../../packages/agent/src/stream-options.js';
import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
  EXIT_USAGE,
  EXIT_WORKSPACE,
  type ExitCode,
  INTERRUPT_EXIT_CODES,
} from '../../../packages/core/src/cli/exit-codes.js';
import { formatCost } from '../../../packages/core/src/cli/kit.js';
import type { LaneImagePart } from '../../../packages/core/src/presentation.js';
import {
  type FileSystem,
  NodeExecutionEnv,
} from '../../../packages/exec/src/env.js';
import type { FileBridge } from '../../../packages/exec/src/file-bridge.js';
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
  applyUndo,
  planUndo,
} from '../../../packages/exec/src/journal-undo.js';
import { createSecretCommandRunner } from '../../../packages/exec/src/secret-runner.js';
import {
  type ApprovalRequest,
  type ApprovalVerdict,
  enableSessionFullAccess,
  fullAccessInForceWarning,
  type InstalledPolicy,
  installPolicy,
  type SessionFullAccessGrant,
  type ApprovalConfig,
} from '../../../packages/host/src/approvals.js';
import type { RoleModelEntry } from '../../../packages/host/src/config/config.js';
import { createLedgerModelKeyResolver } from '../../../packages/host/src/config/model-key-audit.js';
import type {
  RuntimeEscalation,
  RuntimeThinking,
} from '../../../packages/host/src/config/runtime.js';
import {
  FAUX_FOOTER,
  FAUX_MODEL_ID,
  FAUX_PROVIDER_ID,
  fauxProviderActive,
} from '../../../packages/host/src/faux-provider.js';
import {
  shouldEmitNotice,
  noIsolationTuiLine,
  noIsolationNoticeLines,
} from '../../../packages/host/src/limits/solo-warning.js';
import {
  type AssembledModels,
  assembleModels,
} from '../../../packages/host/src/models-cli.js';
import {
  readSessionUsage,
  type SessionUsageRow,
} from '../../../packages/host/src/ops/cost/cost-cli.js';
import { resolveRunBaseRevision } from '../../../packages/host/src/policy/audit-ledger.js';
import {
  type EffectivePolicy,
  hasModelPolicy,
  hasToolPolicy,
  isModelAllowed,
  isToolAllowedByEnterprise,
} from '../../../packages/host/src/policy/enterprise.js';
import { PresentationProjector } from '../../../packages/host/src/presentation/projector.js';
import { findProjectRoot } from '../../../packages/host/src/project-root.js';
import { providerKeyHints } from '../../../packages/host/src/provider-key-hints.js';
import type { RoleLayerInput } from '../../../packages/host/src/roles/resolver.js';
import { effectiveRoleClasses } from '../../../packages/host/src/roles/resolver.js';
import {
  rolePromptFor,
  selectRole,
} from '../../../packages/host/src/roles/roles-boot.js';
import {
  mapCaughtErrorToTerminus,
  type RunTerminusKind,
  SESSION_ID_PATTERN,
} from '../../../packages/host/src/run-cli.js';
import {
  TurnSpans,
  type TurnSpansSink,
} from '../../../packages/host/src/run-spans.js';
import {
  type SessionSummary,
  summarizeProjectSessions,
} from '../../../packages/host/src/session-summaries.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import type { SkippedSkill } from '../../../packages/host/src/skills-boot.js';
import {
  bootSkills,
  describeSkillSkips,
} from '../../../packages/host/src/skills-boot.js';
import type { DebugSink } from '../../../packages/host/src/spans.js';
import { hookErrorLine, modelLine } from '../../../packages/host/src/spans.js';
import type { RunOutcome } from '../../../packages/host/src/trajectory/run-trajectory.js';
import { createApprovalSurface } from '../../../packages/tui/src/approval-surface.js';
import {
  type AttachmentImage,
  formatImageBytes,
  IMAGE_MAX_BYTES,
  inlineImageTerminatorEnd,
  scanInlineImageChunk,
  validateImageAttachment,
} from '../../../packages/tui/src/attachments.js';
import { formatClock } from '../../../packages/tui/src/chrome.js';
import {
  createKeyRegistry,
  KeybindingsError,
  type KeyRegistry,
  parseKeybindingsJson,
} from '../../../packages/tui/src/keybindings.js';
import {
  type ForkPoint,
  forkPickerRows,
  type LaneEntryLike,
  userPromptsOf,
} from '../../../packages/tui/src/lane-cells.js';
import { renderNoKeyPreflight } from '../../../packages/tui/src/preflight.js';
import type { Screen } from '../../../packages/tui/src/screen.js';
import { bootScreen } from '../../../packages/tui/src/screen.js';
import {
  findSlashCommand,
  helpLines,
  type ParsedSlashCommand,
  parseSlashCommand,
  SLASH_COMMAND_NAMES,
  SLASH_COMMANDS,
} from '../../../packages/tui/src/slash-commands.js';
import type { StatusUsageRow } from '../../../packages/tui/src/status-bar.js';
import {
  builtinThemePalette,
  type ColorLevel,
  createThemeFromPalette,
  detectColorLevel,
  isThemeBuiltin,
  parseThemeJson,
  setTuiTheme,
  ThemeError,
  type TuiTheme,
  tuiTheme,
} from '../../../packages/tui/src/theme.js';
import {
  createTuiApp,
  type JournalChangeLike,
  type TuiApp,
  type TuiPickerRow,
  type TuiSubmitOutcome,
  type TuiWorkspace,
} from '../../../packages/tui/src/tui-app.js';
import type { Terminal } from '../../../packages/tui/src/tui-boundary.js';
import {
  isKeyRelease,
  isKeyRepeat,
  ProcessTerminal,
  parseKey,
} from '../../../packages/tui/src/tui-boundary.js';
import {
  clipboardSupported,
  osc52,
} from '../../../packages/tui/src/ui/clipboard.js';
import { loadHighlighter } from '../../../packages/tui/src/ui/highlight.js';
import { formatAge } from '../../../packages/tui/src/ui/palette.js';
import {
  AUTO_ESCALATION_TOOL_FAILURES,
  createAutoEscalation,
  formatEscalationRow,
  markAutoEscalated,
  nextLadderRung,
  noteAutoEscalationTurn,
  resetAutoEscalation,
  shouldAutoEscalate,
  toTrajectoryEscalation,
} from './auto-escalation.js';
import {
  resolveLaneLadder,
  resolveRoleThinking,
  roleModelScope,
  type runtimeLaneDeps,
  selectBootModel,
  selectModelUnderPolicy,
} from './config-runtime.js';
import {
  assistantSummary,
  composePromptSections,
  NO_ASSISTANT_TEXT_SUMMARY,
} from './headless-run.js';
import { hasExplicitModelSelection } from './model-projection.js';
import { persistRunTrajectory } from './run-trajectory.js';
import { formatScopedModels } from './scoped-models.js';
import { readTuiWorkspace } from './tui-workspace.js';

// The interaction surface the root shares with the app: the seat
// the installed policy consults and the surface the loop renders are the SAME
// object, so a verdict collected on screen is the verdict the lane receives.
export type TuiApprovalSeat = (
  request: ApprovalRequest,
  // The installed service's own bound. The surface withdraws the
  // ask it is showing when it aborts, so a timed-out question never blocks the
  // next one.
  signal?: AbortSignal,
) => Promise<ApprovalVerdict | undefined>;
// The lane surface the loop drives (pi-durable). Narrow on purpose:
// one turn (submit + wait), the conversation's committed event stream, the
// transcript read, and the abort/drain pair — nothing else. Every member is
// a real lane call, so the prod wiring is a straight passthrough.
export interface TuiLaneLoop {
  /**
   * One turn on the durable lane (lane/turn.ts). The busy policy is
   * the caller's: the loop's own submits use `reject` (a race with a
   * settling turn fails loudly), while a busy Enter passes `followUp` and
   * the steer key `steer`, so pi-durable queues them in the conversation's
   * inbox.
   */
  runTurn(
    prompt: string,
    opts: {
      requestId: string;
      context: Context;
      whenBusy?: 'reject' | 'followUp' | 'steer';
      // The admitted submission's id and whether it was placed at
      // once or queued in the inbox — the busy latch follows placed work.
      onSubmitted?: (submissionId: string, state: 'placed' | 'queued') => void;
      // Images attached to this prompt. They become Pi's
      // user-message content parts, so the committed entry stores them.
      images?: readonly LaneImagePart[];
    },
  ): Promise<TurnOutcome>;
  /**
   * One manual compaction (`/compact [focus]`), admitted and awaited
   * to terminal — the pre-cut context estimate, or the harness' own failure.
   * Absent means this boot has no live lane to compact.
   */
  compact?(
    focus: string | undefined,
    context: Context,
    options?: ManualCompactionOptions,
  ): Promise<ManualCompactionOutcome>;
  /**
   * The conversation's committed lane events. The attach snapshot
   * REPLACES the feed's committed entries; every later event is appended.
   */
  subscribe(
    sink: LaneEventSink,
    context: Context,
  ): Promise<() => Promise<void>>;
  /**
   * The live conversation's transcript entries, transcript order
   * (the one entry read path; never a per-event re-read).
   */
  entries(context: Context): Promise<ReadonlyArray<EntryRecord>>;
  /**
   * Abort the conversation and drain its kills — every kill
   * attempted, failures aggregated into one throw. A refused abort is not
   * silent: the cancel path reports it on the footer.
   */
  abort(context: Context): Promise<void>;
  /**
   * A settled turn's kills are FORGOTTEN, not run — a kept
   * background job outlives Kubic, and a recycled pid must not receive a
   * stale group SIGTERM. The quit drain still has the registry backstop.
   */
  forgetKills(): void;
  /** The kill registry key — String(conversation.id). */
  killsKey: string;
  kills: OperationKillRegistry;
  context: Context;
  /**
   * The live model switch (`/model`). The prod boot resolves
   * the id against the live catalog (an unknown provider or model fails by
   * name), commits the change through conversation.configure, and returns
   * the live read-back. A viewer-shell stub may omit it; `/model` then says
   * so instead of pretending to switch.
   */
  switchModel?: (
    model: { provider: string; modelId: string },
    context: Context,
    // The reason the climb records — `/model <ref>`
    // by default, the operator's words after `/escalate <ref>`. Absent
    // on the plain switch path, which records nothing.
    reason?: string,
  ) => Promise<string>;
  /** The live model label (provider/id) — the status bar and usage rows. */
  model?: (context: Context) => Promise<string>;
  /**
   * Whether the conversation's CURRENT model accepts
   * image input. Read when an attachment is offered, so a model without
   * image support refuses it by name instead of sending bytes the provider
   * would reject mid-turn. Absent (injected viewer shells) refuses too: the
   * attach path never guesses.
   */
  supportsImages?: (context: Context) => Promise<boolean>;
  // The resolved model's context window and compaction
  // threshold, so the gauge follows a `/model` switch. Absent (injected
  // viewer loops) leaves the seeded limits in place — the gauge never keeps
  // a window that belongs to a model the session does not run.
  contextLimits?: (provider: string, id: string) => ContextLimits;
  /**
   * The thinking level the live conversation's agent carries (the
   * `pi.agent` document), for `/thinking`'s report and the cycle key.
   */
  thinking?: (context: Context) => Promise<ModelThinkingLevel>;
  /**
   * `/thinking <level>` — commit the level through the conversation's
   * agent (`configure`), CLAMPED to what the live model supports, and return
   * the effective level Pi will use. Absent means this boot has no live lane.
   */
  switchThinking?: (
    level: ModelThinkingLevel,
    context: Context,
  ) => Promise<ModelThinkingLevel>;
  /** The levels the LIVE model supports, in ladder order. */
  supportedThinking?: (
    context: Context,
  ) => Promise<readonly ModelThinkingLevel[]>;
  /**
   * The catalog rows the `/model` picker offers (usable providers
   * only), the live model marked. Absent means this boot cannot list them.
   */
  listModels?: (context: Context) => Promise<readonly TuiModelChoice[]>;
  /** Every provider, usable or not, for the picker's headers. */
  listProviders?: (context: Context) => Promise<readonly TuiProviderChoice[]>;
  // Trajectory per settled turn: the prod boot persists
  // <sessions-root>/<id>/trajectory.json here. Absent (injected test loops)
  // means no trajectory; a failure never changes the turn's outcome.
  recordTurn?: (turn: TuiTurnRecord) => Promise<void> | void;
  // The transcript rows for climbs recorded since
  // the last drain. The runner drains this after every settled turn so
  // each climb is reported once; absent means this boot records no climbs.
  drainEscalationRows?: () => string[];
  // Warnings the boot and the settled turns' trajectory writes raised, as
  // transcript lines. The screen owns the terminal, so they never reach
  // stderr: drained once the first read lands and after every settled turn.
  drainNotices?: () => string[];
}

// One row of the model picker's catalog (the lane's `listModels`
// member, projected into the tui app's own row shape by the loop).
export interface TuiModelChoice {
  readonly provider: string;
  readonly id: string;
  readonly current: boolean;
  /** The provider's origin (built-in / custom / testing), when known. */
  readonly note?: string;
  /** The palette's model columns (context, thinking). */
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
  /** The thinking levels the model supports. */
  readonly thinking?: readonly ModelThinkingLevel[];
}

// One provider of the model picker — keyless ones included, so
// the picker can say what to set instead of hiding them.
export interface TuiProviderChoice {
  readonly id: string;
  readonly usable: boolean;
  /** Where the key comes from (`ANTHROPIC_API_KEY`). */
  readonly keySource?: string;
  /** What to set when there is none (`OPENAI_API_KEY`). */
  readonly keyVar?: string;
}

// One settled turn as the runner saw it: the prompt, when it started, the
// footer outcome, and — when the lane settled it — the durable TurnOutcome that
// is the lane record's source (completed/failed/aborted, the reason and the
// human message).
interface TuiTurnRecord {
  prompt: string;
  startedAt: number;
  outcome: TuiTurnOutcome;
  turn?: TurnOutcome;
}

// The terminus of a durable failure: the reason code carries
// the classification the terminal-status mapping derives, so the
// TUI trajectory keeps the same envelope vocabulary as `kubic run`. A code
// this map does not know stays a plain failure — never an invented terminus.
function terminusOfFailure(reason: string): RunTerminusKind {
  switch (reason) {
    case 'approval_denied':
      return 'approval_denied';
    case 'approval_timed_out':
      return 'approval_timed_out';
    case 'workspace_failed':
      return 'workspace_unavailable';
    // A mid-run provider error is a task failure with its own
    // terminus, never the pre-run probe (`provider_probe_failed`, exit 6).
    case 'provider_transient':
      return 'provider_transient';
    case 'provider_auth':
      return 'provider_auth';
    default:
      return 'failed';
  }
}

// A turn's own options. The solo lane queues a busy follow-up
// in the conversation's inbox (`followUp`) or joins the running work with a
// steer (`steer`); `onSubmitted` reports the admitted submission's id the
// moment the harness takes it, so the loop can key its `queued: …` rows.

export interface TuiTurnOptions {
  whenBusy?: 'followUp' | 'steer';
  onSubmitted?: (submissionId: string, state: 'placed' | 'queued') => void;
  // Images attached to this prompt, in order.
  images?: readonly LaneImagePart[];
}

// One turn's driver (a prompt turn or a compaction): the input loop's busy
// latch, Ctrl-C handling and quit drain stay one contract.
interface TuiTurnDriver {
  isRunning(): boolean;
  isCancelling(): boolean;
  // False means Ctrl-C cannot cancel this turn: the runner quits instead of
  // showing a "cancelling…" that the lane cannot honour.
  canCancel(): boolean;
  run(prompt: string, options?: TuiTurnOptions): Promise<TuiTurnOutcome>;
  cancel(): Promise<boolean>;
  drainForQuit(bound: Promise<void>): Promise<void>;
  /**
   * The settlement line this driver reports INSTEAD of the generic turn
   * outcome — a compaction is not a turn (`compacted: …`), and its failure
   * text is the harness' own. Absent means the loop's `footerForOutcome`.
   */
  settlementFooter?(): string | undefined;
}

// `/compact [focus]` is a lane operation, not a prompt — Pi's
// manual compaction task (lane/compaction.ts). It is driven through the same
// busy/cancel wrapper as a turn, so the spinner shows, Ctrl-C aborts the
// conversation (Pi settles the task aborted/orphaned) and the quit drain
// waits on it; its settlement line is the compaction's own, never a turn
// outcome.
export class TuiCompactionTurn implements TuiTurnDriver {
  private readonly loop: TuiLaneLoop;
  private readonly focus: string | undefined;
  private readonly onSettled: (() => Promise<void>) | undefined;
  private running: Promise<TuiTurnOutcome> | undefined;
  private outcome: ManualCompactionOutcome | undefined;
  private aborted = false;

  constructor(
    loop: TuiLaneLoop,
    focus: string | undefined,
    onSettled?: () => Promise<void>,
  ) {
    this.loop = loop;
    this.onSettled = onSettled;
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
        detail: 'compaction needs a live lane',
      });
    }
    const running = (async (): Promise<TuiTurnOutcome> => {
      const outcome = await compact(this.focus, this.loop.context, {
        // A Ctrl-C that landed while the task was still being admitted hit
        // an idle conversation: replay it now that the task exists, so the
        // cancel is never lost.
        onAdmitted: async () => {
          if (this.aborted) await this.loop.abort(this.loop.context);
        },
      });
      this.outcome = outcome;
      if (outcome.status === 'completed') {
        // The new compaction entry reaches the transcript.
        await this.onSettled?.();
        return { status: 'completed' };
      }
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
      // No summary entry was placed, and saying `compacted` would claim work
      // that never happened. The line says why, in words.
      return outcome.reason === 'most-recent-turn'
        ? `nothing to compact: no history older than the most recent turn (${outcome.tokensBefore} tokens of context)`
        : `nothing to compact: no cut point before the most recent turn (${outcome.tokensBefore} tokens)`;
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

// One row of the `/resume` picker.
interface TuiSessionChoice {
  readonly id: string;
  readonly cwd?: string;
  readonly createdAt?: string;
}

export interface TuiLaneBoot {
  sessionId: string;
  model: string;
  close?: () => Promise<void> | void;
  // The session's journal store, exposed so callers (and
  // tests) can observe the retention policy the boot installed. The loop
  // itself uses the lane's own recording; this is the same store.
  journal?: FileJournalStore;
  // The mid-session reconcile sweep. A `bash` write is not
  // intercepted by the file tools, so it reaches the journal only through the
  // sweep; the root runs it when a turn that used the shell settles, so the
  // Ctrl-O / Ctrl-R panels show that change now instead of at quit. Safe to
  // repeat (a path's expected state is its last journaled entry, so an
  // unchanged tree appends nothing); a failure never reaches the loop.
  reconcile?: () => void;
  // Start a new reconciliation turn — the workspace as it
  // is now becomes the baseline, so the next sweep journals only that turn's
  // changes (tagged with `turn`) and an edit made between prompts is absorbed
  // instead of attributed to the agent. Safe to call when nothing changed.
  rebaseline?: (turn: number) => void;
  // Install the interactive turn supplier — the loop's live
  // counter, sampled per tool call so tool-journaled entries share the
  // sweep numbering. Installed post-boot (the counter lives in the loop,
  // not the boot); unset means turn-less entries, like headless runs.
  setCurrentTurnSupplier?: (supplier: () => number | undefined) => void;
  // The workspace's files for `@` mentions, workspace-relative —
  // the gitignore-aware, bounded walk the find/grep tools use.
  listFiles?: () => readonly string[];
  // Fork THIS session at an entry into a
  // new session (the store fork) and return its id. Needs the session's
  // lock free: the loop closes this boot first.
  forkAt?: (at: number) => Promise<string>;
  // The installed policy's own full-access predicate (the SAME
  // one its ask auto-approves on), read for the posture indicator at boot and
  // after every turn. Absent (a viewer boot with no policy) means approvals
  // are in force — there is no policy that could skip them.
  approvalsSkipped?: () => boolean;
  // The boot hands the loop its drive surface. Injected boots in
  // the existing tests omit it — the loop then runs as the viewer shell,
  // which keeps the screen/restore contract testable on its own.
  loop?: TuiLaneLoop;
  // Per-turn spans. The runner forwards the turn's run/tool
  // events to `turns`; a settled turn's artifact lines go through `write`.
  // Absent (injected boots) means no spans — the turn works exactly as
  // before.
  turnSpans?: TurnSpansSink;
  // The debug sink for the boot's session/role lines and
  // the turn's fault and token lines (threaded to the runner below).
  // Absent (prod: `kubic tui` has no --debug flag yet) means the lines
  // are dropped — except the fault, which always lands as a transcript
  // notice because the TUI has no other failure channel.
  debug?: DebugSink;
  // The outcome line for a turn a crashed process left open on
  // this session (durably aborted at boot). Shown in the editor footer from
  // the first render; absent when nothing was pending.
  pendingNotice?: string;
  // The model reconciliation line for a resumed session whose
  // stored model differs from the selection (kept or switched). Shown in
  // the footer from the first render alongside any pending-op notice.
  modelNotice?: string;
  // The lane's committed thinking level, read
  // back from the agent document after boot — `runTuiCommand` seeds the
  // status bar from this, so the first frame shows the level the lane
  // actually runs (never the seed default). Absent (injected boots) means
  // the seed default.
  thinking?: string;
  // The role's resolved allowed set for
  // `/scoped-models` — the loop reports it as a local read. Absent (no
  // role, or an injected boot) means unconstrained.
  scopedModels?: { role: string; models: RoleModelEntry[] | undefined };
  // The approval posture the lane was installed with —
  // true seeds the status bar's OFF indicator from the first frame.
  fullAccess?: boolean;
  // Boot warnings (the full-access grant/in-force warning, skipped skills).
  // Startup prints them on stderr before the alt-screen opens; a lane that
  // /new or /resume boots shows them as transcript rows instead.
  notices?: string[];
  // The in-session full-access toggle. Writes
  // posture.json and one audit row through the same host helpers the CLI
  // paths use and flips the INSTALLED policy's live posture, so the very
  // next challenged call follows and the indicator moves in one frame.
  // Absent (viewer boots) means the toggle refuses by name.
  setFullAccess?: (enabled: boolean) => SessionFullAccessGrant;
  // The installed policy's turn boundary — an `allow all edits
  // this turn` answer stops applying — and whether one applies right now.
  endApprovalTurn?: () => void;
  editsApprovedThisTurn?: () => boolean;
  // `/resume`'s rows — the sessions store this boot belongs to,
  // newest first. Absent (injected boots) means `/resume` refuses by name.
  listSessions?: () => Promise<readonly TuiSessionChoice[]>;
  // This project's other sessions with their first prompt,
  // turns, cost and age (read without a lock; a held one is listed, never
  // opened). Absent means `/resume` falls back to `listSessions`.
  summarizeSessions?: (exclude?: string) => Promise<readonly SessionSummary[]>;
  // Where a provider's key comes from, for the first screen.
  keySourceOf?: (provider: string) => string | undefined;
  // The workspace root the journal (and `/undo`) resolves paths
  // against. Absent means `/undo` refuses by name rather than guessing.
  cwd?: string;
  // The session's committed spend, read from its `pi.usage`
  // ledger before the first frame, so a resumed session never renders
  // $0.00. Absent for a fresh session and for injected viewer boots.
  usageRows?: StatusUsageRow[];
  // The running model's context window and compaction threshold,
  // so the status bar's gauge can render from the first committed request.
  // Absent when the catalog does not know the window.
  contextLimits?: ContextLimits;
  // Explicit skill invocation — the booted
  // (gated-visible, hidden included, withheld excluded) skill names for
  // `/skill:` completion, with the expander that resolves a name plus the
  // operator's instructions to turn-prompt text. The expander throws the
  // named unknown-skill error; absent (injected viewer boots) means
  // `/skill:` refuses by name.
  skillInvocation?: {
    names: string[];
    invoke: (name: string, instructions?: string) => string;
  };
}

// A model's context window and the token level at which the solo
// lane compacts (window − reserve, the same policy the harness reads).
// `undefined` means the catalog does not know the window: the gauge then
// stays off rather than showing a made-up percentage. will make the
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

// A session's `pi.usage` buckets as status-bar rows. A model
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
  // `answer` is the seat the boot's installed policy must consult. It is an
  // ARGUMENT rather than a deps field because the seat and the rendered surface
  // are one object created by runTuiCommand: a boot that closed over the deps
  // would never see it, which is exactly the bug the end-to-end test caught
  // (the overlay never appeared, the call was refused with
  // NO_ANSWER_SURFACE_REASON). The prod boot forwards it to installSoloPolicy;
  // a boot may ignore it (the viewer shell does).
  bootLane: (
    sessionId?: string,
    answer?: (
      request: ApprovalRequest,
      // The installed service's bound reaches the seat as an
      // AbortSignal, so the seat can withdraw the ask it is showing.
      signal?: AbortSignal,
    ) => Promise<ApprovalVerdict | undefined>,
    // The parsed parity flags travel with the boot call —
    // the command shell owns parsing, the boot owner owns the defaults.
    options?: TuiBootFlags,
  ) => Promise<TuiLaneBoot>;
  // Observes a failed journal-panel read or apply (tests; the
  // loop itself swallows it — the journal is observed, never a gate).
  journalFeedError?: (error: unknown) => void;
  // The bound on the quit-time drain (a turn still running when
  // the operator quits is aborted, its kills run, and the loop waits at most
  // this long for it to settle before the sweep and session close). Absent
  // means TUI_DRAIN_TIMEOUT_MS; the timer is injectable so tests are
  // deterministic. It returns a canceller.
  drainTimeoutMs?: number;
  setDrainTimer?: (ms: number, fire: () => void) => () => void;
  // The process-level event source — SIGINT/SIGTERM/SIGHUP and
  // uncaughtException/unhandledRejection. Absent means the real process;
  // tests inject an emitter so the runner itself is never signalled.
  signals?: TuiProcessEvents;
  // How a fatal error (an exception in input or render, an
  // unhandled rejection) ends the process once the terminal is restored.
  // Absent means process.exit; tests inject a recorder.
  exit?: (code: number) => void;
  // The approval overlay's arming delay and the clock it runs
  // on. Absent means APPROVAL_ARMING_MS on the real clock; tests inject 0
  // (or a manual clock) instead of sleeping.
  approvalArmingMs?: number;
  approvalClock?: () => number;
  // The colour depth. Absent means detectColorLevel over
  // process.env and stdout's TTY flag (the shipped behaviour); tests pass
  // 'none' so the shell's NO_COLOR / FORCE_COLOR never reach them.
  colorLevel?: ColorLevel;
  // The config `[ui] theme` reference — a built-in name
  // (`default`, `dark`, `light`, `terminal`) or a path to a JSON theme file, resolved
  // and validated before the alt-screen opens.
  theme?: string;
  // The keybindings file; default
  // `~/.kubic/keybindings.json`. Absent means the shipped bindings.
  keybindingsFile?: string;
  // The header's project / branch / dirty count, read after the
  // screen opens and again after every settled turn. Absent leaves the
  // header without them (injected fakes).
  readWorkspace?: () => Promise<TuiWorkspace>;
  // The header clock's time source; absent hides the clock.
  clock?: () => Date;
  // The version the first screen names, and the project
  // layer's trust state (absent: the project has no layer).
  version?: string;
  projectTrust?: 'loaded' | 'untrusted';
}

type TuiSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
type TuiProcessEvent = TuiSignal | 'uncaughtException' | 'unhandledRejection';

export interface TuiProcessEvents {
  on(event: TuiProcessEvent, listener: (value: unknown) => void): unknown;
  off(event: TuiProcessEvent, listener: (value: unknown) => void): unknown;
}

const TUI_SIGNALS: readonly TuiSignal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const TUI_FATAL_EVENTS = ['uncaughtException', 'unhandledRejection'] as const;

// A signalled quit exits 128+signo (SIGHUP 129, SIGINT 130,
// SIGTERM 143) — the shell convention, so a supervisor can tell a signalled
// TUI from a clean quit.
function signalExitCode(signal: TuiSignal): ExitCode {
  return INTERRUPT_EXIT_CODES[signal];
}

// How long a quit waits for an aborted turn to settle. The kills
// have already run by then; the wait only lets the lane record its terminal
// status and the killed tool finish its last write before the sweep.
const TUI_DRAIN_TIMEOUT_MS = 3000;

// How often the header clock checks whether its minute changed.
export const TUI_CLOCK_TICK_MS = 30_000;

function defaultDrainTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}

// The `kubic tui` parity flags: same names and semantics as
// the `kubic run` counterparts.
export interface TuiBootFlags {
  role?: string;
  noSkills?: boolean;
  skillsList?: string[];
  // `--dangerously-skip-approvals` for the booted session.
  dangerouslySkipApprovals?: boolean;
  // `--tools <a,b>` / `--no-tools`.
  tools?: string[];
  noTools?: boolean;
  // `--model` is deliberately NOT a boot flag: dispatch
  // pre-scans it from the raw argv into the ONE config load as the `cli`
  // layer, so `TuiConfigProjection.model` already carries cli > env > file
  // precedence and the enterprise freeze. A flag patched over that
  // projection afterwards would bypass the freeze `kubic run` honours.
}

export interface TuiRunOptions {
  sessionsRoot?: string;
  env?: NodeExecutionEnv;
  // Config-sourced permission classes: the TUI is a
  // config-consuming command, so it takes the same projection `kubic run`
  // does. Absent means the documented SOLO_DEFAULTS.
  classes?: PermissionClasses;
  // `--tools <a,b>` / `--no-tools` —
  // intersected with the classes/role/enterprise sets, never widening.
  toolSelection?: string[];
  noTools?: boolean;
  // The config layer's own record of where the classes came from
  // ('default' when nothing configured them). Absent means 'default'.
  policySource?: 'config' | 'default';
  // The debug sink for the boot's session/role lines
  // (threaded to the runner for its fault and token lines). A test seam:
  // prod `kubic tui` passes none (`tui` has no --debug flag yet), so the
  // lines are dropped there — the fault notice still renders (it does not
  // need the sink).
  debug?: DebugSink;
  // The config `[approvals]` policy — the same projection
  // `kubic run` installs. Absent means the documented defaults.
  approvals?: ApprovalConfig;
  // The installed-policy seat: the same derivation the headless
  // runner installs. Absent means the shipped default (classes above +
  // destructive/network/confine guards + the approval ask); tests inject a
  // variant. `kubic tui` drives the same lane, so it takes the same policy.
  policy?: InstalledPolicy;
  // Model registry injection: the same seam `runHeadlessPrompt`
  // takes as `models`, so the reconciliation tests can boot the REAL path
  // hermetically with faux models. Absent means the assembled prod catalog.
  models?: MutableModels;
  // The answer seat: the interactive path's approval surface.
  // Attached by runTuiCommand; absent means the no-surface refusal.
  answer?: (
    request: ApprovalRequest,
    signal?: AbortSignal,
  ) => Promise<ApprovalVerdict | undefined>;
  // Skills discovery, `--role`
  // documents, and journal retention reach the interactive lane exactly
  // as they reach the headless one — same options, same semantics.
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The config `skills` projection — resolved at
    // load, loaded with source 'settings'. Absent means none configured.
    settingsSkills?: string[];
  };
  noSkills?: boolean;
  skillsList?: string[];
  role?: string;
  roles?: {
    cwd?: string;
    layers?: RoleLayerInput[];
    // Project trust for the repo documents —
    // same projection as `kubic run`. Absent both means untrusted.
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The home directory whose `.kubic/roles` layer
    // under the project documents — same projection as `kubic run`.
    // Absent means no global source.
    homeDir?: string;
  };
  journalRetention?: JournalRetention;
  // [agent] systemPromptFile contents: the same projection
  // `kubic run` threads, so the interactive lane assembles the same
  // prompt. Absent means the lane assembles its prompt unchanged.
  systemPromptSection?: string;
  // The `[session]` compaction policy — the same
  // projection `kubic run` threads, so the interactive lane compacts under
  // config, not the lane defaults. Absent means the own defaults.
  compaction?: LaneCompactionOptions;
  // Out-of-scope paths: the same projection `kubic run`
  // threads, so a declared directory is excluded from this lane's
  // baseline and sweep too. Absent means the mechanism's own skips only.
  reconcileOutOfScope?: string[];
  // The per-path trust check (the store's
  // resolved-root decision plus the env opt-in), from the composition
  // root's config load — gates the project models.json and the ancestor
  // project skills on the interactive lane exactly as `kubic run` gates
  // them. Absent falls back to the env.
  trustProject?: (path: string) => boolean;
  // The lane's agent id: the configured `[agent].name`, from
  // the SAME runtimeLaneDeps projection `kubic run` consumes. Absent means
  // 'root' — the shipped attribution, unchanged.
  agentId?: string;
  // Enable full access for the booted session through
  // the one host enable path before the policy is installed.
  dangerouslySkipApprovals?: boolean;
  // With: the runtime pin the config load projected
  // (cli `--model` > `KUBIC_MODEL` > `[model]`), from the SAME runtimeModelPin
  // seam `kubic run` consumes. It beats the role layer's model, which beats
  // first-available; an explicit pin selects the model and makes a resumed
  // session switch, absent means the default pick.
  model?: ModelSelection;
  // Request options: the merged `[model]` tuning plus
  // every `[roles.<name>]` table that sets a key (runtimeStreamTuning) —
  // the same projection `kubic run` consumes. The boot resolves them
  // against `--role` into `settings.stream`. Absent means untuned.
  streamTuning?: StreamTuningTables;
  // Enterprise policy: the same EffectivePolicy the
  // headless runner gates with — the interactive lane is not the
  // unprotected one.
  modelPolicy?: EffectivePolicy;
  // The runtime pin above is a frozen enterprise `[model]`
  // — the session override (`/model`, the same level as `--model`)
  // cannot leave it, exactly as the flag cannot.
  modelPinFrozen?: boolean;
  // Thinking level: the effective level with its source
  // (`--thinking` > `KUBIC_MODEL_THINKING` > file layers), from the SAME
  // `RuntimeThinking` projection `kubic run` consumes. The boot resolves it
  // against the session's stored level and the role default and clamps it
  // to the effective model — a clamp is never silent.
  thinking?: RuntimeThinking;
  // The merged `[model]` ladder, from the same
  // projection. The boot climbs the role's own rungs first
  // (`resolveLaneLadder`); absent means escalation is unconfigured.
  escalate?: RuntimeEscalation;
  // The `[ui] theme` reference. Not a lane option — it
  // travels on the boot options object because that is the one projection
  // `tuiBootOptions` builds, and `runTuiCommand` reads it from the deps
  // before the alt-screen opens.
  theme?: string;
}

// The durable loop surface over one booted solo lane — exactly what
// bootTuiLane installs. Exported so the prod boot, embedders and the tests
// share ONE wiring: a lane member the loop needs cannot be forgotten in a
// hand-spread fake (the failure mode that hides a dropped dep).
export function tuiLoop(
  lane: Lane,
  context: Context = BACKGROUND_CONTEXT,
): TuiLaneLoop {
  return {
    runTurn: (prompt, opts) => runTurn(lane, prompt, opts),
    // The live model's own input modalities. The boot
    // model is what this closure can see; `bootTuiLane` overrides it with
    // the catalog read so a `/model` switch moves the verdict with it.
    supportsImages: async () => lane.model.input.includes('image'),
    subscribe: (sink, loopContext) =>
      subscribeLaneEvents(
        lane.harness,
        lane.conversation.id,
        sink,
        loopContext,
      ),
    entries: (loopContext) =>
      readConversationEntries(lane.conversation, loopContext),
    // `/compact [focus]` — Pi's manual compaction task with Kubic's compact
    // prompt as the summarizer instructions, under the manual keep window.
    compact: (focus, loopContext, options) =>
      runCompactCommand(lane, focus, loopContext, options),
    // The shared abort+drain (conversation.abort, every kill
    // attempted, failures aggregated) and the settled-turn forget.
    abort: async (loopContext) => {
      await abortLane(lane, loopContext);
    },
    forgetKills: () => forgetLaneKills(lane),
    killsKey: String(lane.conversation.id),
    kills: lane.kills,
    // The lane's own context: every member is called with it, so an embedder
    // that booted the lane on a bounded context is never silently
    // un-cancellable.
    context,
  };
}

// Prod solo boot: same session/model setup as the headless runner
// (create-or-attach, journal dir, assembled models, default select, lane
// boot) plus the loop surface the interactive path drives.
class ToolSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolSelectionError';
  }
}

// The per-invocation tool selection is
// validated before the lane boots — mutual exclusion, unknown names and the
// Agreement with the permission classes all fail closed (exit 2)
// rather than silently narrowing the run.
function assertToolSelection(
  selection: readonly string[] | undefined,
  noTools: boolean,
  classes: PermissionClasses | undefined,
): void {
  if (selection !== undefined && noTools) {
    throw new ToolSelectionError(
      '--tools and --no-tools are mutually exclusive',
    );
  }
  if (selection === undefined) return;
  const known = Object.keys(OPERATIONS).sort();
  const unknown = selection.find((tool) => !known.includes(tool));
  if (unknown !== undefined) {
    throw new ToolSelectionError(
      `unknown tool ${JSON.stringify(unknown)} (known tools: ${known.join(', ')})`,
    );
  }
  const agreement = checkAgreement(
    validateClasses({ ...(classes ?? DEFAULT_PERMISSIONS) }),
    [...selection],
  );
  if (!agreement.agree) throw new ToolSelectionError(agreement.reason);
}

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
  assertToolSelection(
    options.toolSelection,
    options.noTools === true,
    options.classes,
  );
  const context = BACKGROUND_CONTEXT;
  const bridge = createNodeFileBridge(root);
  const store = openSessionStore(root, bridge);
  const session =
    sessionId === undefined
      ? await createSession(store, { cwd: process.cwd() }, context)
      : await attachSession(store, sessionId, context);
  const id = session.id;
  // The [session] debug line names the session.
  options.debug?.(`[session] id=${id}`);
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
  // Baseline + end-of-run sweep: the TUI's run end is its
  // close — quit, SIGINT, EOF — so the sweep rides that `close`. There is no
  // closed-latch: idempotence comes from `reconcile`'s per-path after-hash
  // comparison, so a second close on an unchanged tree appends nothing, while
  // a mutation landing between two closes IS appended (pinned by the exec
  // suite). Assigned inside the try below.
  let reconciliation: RunReconciliation | undefined;
  // The installed policy's end-of-session posture check.
  let settlePolicy: (() => void) | undefined;
  // The booted lane, once it exists. The session release is the caller's job:
  // the harness closes first, then the handle gives the lock back.
  let lane: Lane | undefined;
  // The quit's last-resort kill drain. keys every bash group
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
      await lane?.close(context);
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
    // The store takes the same retention policy the
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
        ...(options.reconcileOutOfScope === undefined
          ? {}
          : { outOfScope: options.reconcileOutOfScope }),
      });
    } catch {
      // Reported below by the loop's own surfaces; the boot stands.
    }
    // Request-time provider keys, audited per use.
    // `!command` secret refs execute in the run's workspace
    // through the production runner — rerun per request.
    const keyResolver = createLedgerModelKeyResolver({
      workspace: options.env?.cwd ?? process.cwd(),
      role: 'root',
      sessionId: () => id,
      runCommand: createSecretCommandRunner({
        cwd: options.env?.cwd ?? process.cwd(),
      }),
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
    // pick never takes a keyless built-in.
    const fauxPinned =
      options.models === undefined && fauxProviderActive(process.env);
    // `--role` derives both halves of the boot from
    // the role document — prompt text and tool allowlist — with the same
    // fail-closed refusals as `kubic run`. An unknown role refuses the
    // boot (the catch below closes the session and rethrows for the
    // command shell to print) rather than silently booting a roleless
    // lane. Resolved BEFORE model selection: the role layer's model pin is
    // a selection input.
    // Enterprise policy: the same gates the headless runner
    // applies — role grants are checked and the model selection is gated.
    const enterprisePolicy = options.modelPolicy;
    const toolGate =
      enterprisePolicy !== undefined && hasToolPolicy(enterprisePolicy)
        ? (tool: string): boolean =>
            isToolAllowedByEnterprise(enterprisePolicy, tool)
        : undefined;
    // The stored model of a resumed session is gated too: the
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
      // Role documents resolve at the project root, so
      // `--role` from a subdirectory finds `<root>/.kubic/roles/*.md`.
      const selected = selectRole({
        bridge: rolesBridge,
        cwd: rolesCwd,
        role: options.role,
        projectRoot: findProjectRoot(rolesBridge, rolesCwd, homedir()),
        ...(options.roles?.layers === undefined
          ? {}
          : { layers: options.roles.layers }),
        // Trust-gated like `kubic run` — the
        // `roles` projection already carries the config load's check.
        ...(options.roles?.trusted === undefined
          ? {}
          : { trusted: options.roles.trusted }),
        ...(options.roles?.trustProject === undefined
          ? {}
          : { trustProject: options.roles.trustProject }),
        // The global `~/.kubic/roles` layer under the
        // project documents — same projection as `kubic run`.
        ...(options.roles?.homeDir === undefined
          ? {}
          : { home: options.roles.homeDir }),
        ...(enterprisePolicy === undefined
          ? {}
          : { toolPolicy: enterprisePolicy }),
      });
      const promptText = rolePromptFor(selected.doc, selected.markdown);
      // The document's `skills` list travels with the
      // resolved role for the skill gate.
      return {
        resolved: selected.resolved,
        prompt: promptText,
        docSkills: selected.doc.skills,
      };
    })();
    // The [policy] line names the resolved role — or the
    // default the boot runs as when no --role was given (mirrors the
    // headless runner's line).
    if (selectedRole === undefined) {
      options.debug?.(`[policy] role=solo (default)`);
    } else {
      options.debug?.(
        `[policy] role=${selectedRole.resolved.name} tools=${selectedRole.resolved.tools.join(',')}`,
      );
    }
    const roleBoot: { rolePrompt?: string; toolAllowlist?: string[] } =
      selectedRole === undefined
        ? {}
        : {
            rolePrompt: selectedRole.prompt,
            ...(selectedRole.resolved.tools.length === 0
              ? {}
              : { toolAllowlist: selectedRole.resolved.tools }),
          };
    // The ONE projection `kubic run` and
    // `kubic tui` share — the runtime pin (cli `--model` > env > `[model]`)
    // beats the role layer's model, which beats the first usable provider;
    // the implicit pick never takes a keyless built-in. The
    // Enterprise policy gates the explicit/role selection
    // and the provider pool. The explicit-selection predicate is the
    // rule: any pin (faux, runtime or role) switches a resumed session
    // whose stored model differs, the default pick never does.
    const model = selectBootModel({
      models,
      fauxPinned,
      pin: options.model,
      roleModel: selectedRole?.resolved.model,
      fallbackProviders: assembled?.fallbackProviders,
      policy: enterprisePolicy,
      // The role's allowed set: the same gate
      // `kubic run` applies, so a scoped role boots in-set on both.
      roleScope: roleModelScope(selectedRole?.resolved),
    });
    const explicitModel = hasExplicitModelSelection({
      fauxPinned,
      pin: options.model,
      roleModel: selectedRole?.resolved.model,
    });
    // The `provider/id` the audit rows name: seeded with
    // the selection, re-pointed at the model the lane reports once the boot
    // has applied the stored-model rule and again on every `/model` switch —
    // the policy is installed before the lane exists, so it reads this at
    // record time instead of freezing the pre-boot pick.
    let liveModelRef = `${model.provider}/${model.id}`;
    // The run's escalation ladder: the role's own
    // rungs win over the merged `[model]` ones (`resolveLaneLadder`),
    // and the record lives here — one ladder object per boot, so every
    // explicit climb and the single auto climb draw from the
    // same budget. Undefined when nothing configured a ladder: the
    // `/model` switch keeps its existing path.
    const laneLadderSteps = resolveLaneLadder(
      options.escalate,
      selectedRole?.resolved.escalate,
    );
    const laneLadder: EscalationLadder | undefined =
      laneLadderSteps === undefined
        ? undefined
        : {
            steps: [...laneLadderSteps.steps],
            maxEscalations: laneLadderSteps.maxEscalations,
            record: [],
          };
    // The climbs this run recorded: the sink every
    // escalateSoloModel call reports to — the trajectory event and the
    // transcript line read them from here.
    const escalationEvents: ModelEscalationEvent[] = [];
    // The single automatic trigger's streak:
    // consecutive tool-failure turns climb one rung, once per run.
    const autoEscalation = createAutoEscalation();
    // Transcript rows already reported: the drain
    // below reports each recorded climb once, however many turns settle.
    let reportedEscalations = 0;
    // Warnings for the transcript, never stderr: the screen owns the terminal.
    // The skill loader's unresolvable --skill and each settled turn's
    // trajectory write push here; the loop drains them.
    const transcriptNotices: string[] = [];
    const env = options.env ?? new NodeExecutionEnv(process.cwd());
    // Audit identity: the base revision this run started
    // from — captured once here, `none` outside git — and the thinking
    // level the lane runs, re-pointed after boot and on every change.
    const runBase = await resolveRunBaseRevision(env.cwd, (cmd, args) =>
      env.shell
        .spawn(cmd, args, {
          provenance: {
            sessionId: id,
            agentId: options.agentId ?? 'root',
            toolCallId: 'tui:base-revision',
            turnId: 0,
            operation: 'tui',
          },
        })
        .wait(),
    );
    let liveThinkingRef: string | undefined;
    // The loaded skill names, for the trajectory's resources.
    let skillNames: string[] = [];
    // The invocable skills (admitted + gate-passed,
    // hidden included, withheld excluded), so `/skill:` expands and
    // completes against the boot's gated set — never the raw load.
    let bootedSkillList: LoadedSkill[] = [];
    // The skills the loader met but did not load — the TUI
    // drops none of these lines: they ride the boot notices once.
    let skillSkips: SkippedSkill[] = [];
    // Installed policy: `kubic tui` drives the same solo lane as
    // `kubic run`, so it installs the same policy — one derivation
    // (host/approvals.installSoloPolicy), which is also what `doctor`
    // reports. Without this the interactive path would be the unprotected
    // one, which is the gap this install closes.
    // The explicit flag records full access for THIS
    // session (posture.json + one audit row) before the policy is installed.
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
      installPolicy({
        workspace: env.cwd,
        // The lane enforces the most
        // restrictive merge of the config classes and the role's, and
        // the role's approval obligations challenge on the triggers.
        // No role means the config (or the lane default).
        ...(selectedRole === undefined
          ? {
              ...(options.classes === undefined
                ? {}
                : { classes: options.classes }),
            }
          : {
              classes: effectiveRoleClasses(
                { ...DEFAULT_PERMISSIONS, ...options.classes },
                selectedRole.resolved.classes,
              ),
              ...(selectedRole.resolved.requires.length === 0
                ? {}
                : { requires: selectedRole.resolved.requires }),
            }),
        source: options.policySource ?? 'default',
        ...(options.approvals ?? {}),
        sessionDir: join(root, id),
        // The session root in use is refused control-plane state.
        sessionsRoot: root,
        // Audit identity: every resolved ask names the
        // session and the model the lane runs on, like `kubic run`'s.
        sessionId: id,
        model: () => liveModelRef,
        // The thinking level at record time, and the base
        // revision captured above.
        thinking: () => liveThinkingRef,
        base: runBase,
        // The answer seat: with the overlay's surface attached,
        // `kubic tui` is the command that can actually collect a verdict on a
        // challenged call instead of refusing it unseen. Injected policies
        // (tests, and any caller that supplies its own) keep their own seat.
        ...(options.answer === undefined ? {} : { answer: options.answer }),
      });
    // The same rule as `kubic run` — a pin (faux,
    // runtime, or the role's default) switches a resumed session whose
    // stored model differs; the default pick keeps the session's own model.
    const modelNotices: string[] = [];
    // The turn cell the loop's counter fills post-boot via
    // setCurrentTurnSupplier. Unwired (undefined) reads turn-less, so a
    // boot without a loop behaves like a headless run.
    const turnCell: { supplier?: () => number | undefined } = {};
    // Request options: the merged `[model]` tuning with
    // `--role` layered over it becomes this lane's `settings.stream` — the
    // same resolution `kubic run` performs.
    const stream = resolveStreamOptions(
      options.streamTuning?.model,
      options.role === undefined
        ? undefined
        : options.streamTuning?.roles?.[options.role],
    );
    // The same request shape as `kubic run` — a
    // per-run source is the override, a file-layer source the config
    // default, and the role default loses to the session's stored level.
    // A clamp joins the model notices: it names the model, the request
    // and the level applied, and the footer line says the same thing.
    const requestThinking = options.thinking;
    // A matching set entry's thinking wins over the flat role default —
    // resolved against the SELECTED model.
    const roleThinking = resolveRoleThinking(
      selectedRole?.resolved,
      model.provider,
      model.id,
    );
    const booted = await bootLane({
      session,
      models,
      model,
      modelPolicy: explicitModel ? 'selected' : 'stored',
      onModelNotice: (line) => modelNotices.push(line),
      onThinkingNotice: (line) => modelNotices.push(line),
      ...(requestThinking === undefined && roleThinking === undefined
        ? {}
        : {
            thinking: {
              ...(requestThinking === undefined
                ? {}
                : requestThinking.source === 'cli' ||
                    requestThinking.source === 'env' ||
                    requestThinking.source === 'enterprise'
                  ? {
                      override: {
                        level: requestThinking.level,
                        source: requestThinking.source,
                      },
                    }
                  : {
                      config: {
                        level: requestThinking.level,
                        source: requestThinking.source,
                      },
                    }),
              ...(roleThinking === undefined ? {} : { role: roleThinking }),
            },
          }),
      // The session id pins the boot model
      // for the task — escalateSoloModel is the only path off it, so an
      // off-ladder `/model` target refuses instead of silently switching.
      taskId: id,
      env,
      sessionId: id,
      agentId: options.agentId ?? 'root',
      // The configured compaction policy — absent
      // means the own defaults.
      ...(options.compaction === undefined
        ? {}
        : { compaction: options.compaction }),
      journal,
      // An untuned boot omits `stream` — the provider
      // defaults stand, never an invented Kubic one.
      ...(stream === undefined ? {} : { settings: { stream } }),
      currentTurn: () => turnCell.supplier?.(),
      // Skills discovery at boot, same as the headless
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
          // The config `skills` projection loads
          // with source 'settings'.
          ...(options.skills?.settingsSkills === undefined
            ? {}
            : { settingsSkills: options.skills.settingsSkills }),
          // The injected set depends on the resolved
          // role and the installed classes — withheld skills never reach
          // the prompt, with the reason on the debug sink.
          ...(selectedRole === undefined
            ? {}
            : { role: selectedRole.resolved.name }),
          ...(selectedRole?.docSkills === undefined
            ? {}
            : { roleSkills: selectedRole.docSkills }),
          classes: installed.classes,
          // An unresolvable explicit --skill is a transcript notice, never
          // only a line on this debug sink the TUI drops — so a typo cannot
          // read as a loaded skill.
          warn: (line: string): void => {
            transcriptNotices.push(`warning: ${line}`);
          },
          log: () => {
            // TUI: no debug footer on the alt-screen; loader lines are
            // intentionally dropped (the block itself is observable).
          },
        });
        skillNames = skills.skills.map((skill) => skill.name);
        bootedSkillList = skills.invocable;
        skillSkips = skills.skipped;

        return {
          // The system prompt file section lands ahead of the
          // skills block — same composition `kubic run` uses.
          ...(() => {
            const sections = composePromptSections(
              options.systemPromptSection,
              skills.block,
            );
            return sections === undefined ? {} : { promptSections: sections };
          })(),
          // The advertised skills outside the cwd stay readable.
          ...(skills.readRoots.length === 0
            ? {}
            : { skillReadRoots: skills.readRoots }),
        };
      })(),
      // `--role` derives both halves of the boot from
      // the role document — prompt text and tool allowlist — resolved above,
      // before model selection, with the same fail-closed refusals as
      // `kubic run`.
      ...roleBoot,
      // The CLI's `--tools`/`--no-tools`
      // selection narrows the booted lane's tool set (never widens).
      ...(options.toolSelection === undefined
        ? {}
        : { toolSelection: options.toolSelection }),
      ...(options.noTools === true ? { noTools: true } : {}),
      // The same installed policy `kubic run` boots with: one
      // derivation, so the interactive path is not the unprotected one.
      policy: {
        classes: installed.classes,
        interceptors: installed.interceptors,
        ...(installed.contributions.length === 0
          ? {}
          : { contributions: [...installed.contributions] }),
        // Enterprise tool gate: the same active-tools /
        // prompt-tools intersection the headless lane installs.
        ...(toolGate === undefined ? {} : { toolAllowed: toolGate }),
        ...(modelGate === undefined ? {} : { modelAllowed: modelGate }),
      },
    });
    // The booted lane: `solo` stays optional for the close closure (a boot
    // that failed before the assignment must still release the session).
    lane = booted;
    {
      const running = await liveModelOf(booted, context);
      liveModelRef = `${running.provider}/${running.id}`;
      // The thinking level the lane actually runs (pi-durable
      // defaults an unset level to `off`, the same answer `/thinking`
      // reports) — the audit rows name this, and the switches below keep it.
      liveThinkingRef =
        (await booted.conversation.agent(context)).thinkingLevel ?? 'off';
    }
    killRemaining = (): void => {
      // Every bash group is keyed by the conversation id, so the quit's
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
    // A turn a dead process left open would sit until its guarded resume timed
    // out; the interactive policy is the durable abort — its approvals would
    // need the overlay, which is not on screen yet, and the operator is present
    // to re-send. The interrupted prompt's own text is named too when the dead
    // process had already placed it (the "resume this very prompt" rule): the
    // operator sees WHAT was interrupted. The outcome is named in the footer
    // from the first render.
    const pendingNotices: string[] = [];
    const pending = await inspectPending(lane, context);
    if (pending.pending) {
      const interrupted = await pendingInputText(lane, context);
      const settlement = await settlePending(lane, 'abort', {
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
    // The model the lane actually runs: the status bar, the
    // usage rows the turn runner records and the context gauge all
    // read this.
    const runningModel = await liveModelOf(lane, context);
    // The thinking level the lane actually
    // runs — read back from the committed agent document, exactly the
    // value whose clamp (or keep) the boot notices already reported. The
    // seed below shows this from the first frame; a stale seed would
    // disagree with the lane until the first turn's refresh.
    const runningThinking =
      (await lane.conversation.agent(context)).thinkingLevel ?? 'off';
    return {
      sessionId: id,
      model: `${runningModel.provider}/${runningModel.id}`,
      // The injected sink, threaded to the turn runner
      // for its fault and token lines (absent in prod — no --debug flag).
      debug: options.debug,
      // Per-turn spans next to the headless artifact — the
      // session's spans.jsonl carries one run span per TUI turn plus its
      // tool spans. Best-effort: telemetry never fails a turn or a boot.
      turnSpans: {
        turns: new TurnSpans(id),
        write: (artifact: string): void => {
          try {
            bridge.appendFile(join(id, 'spans.jsonl'), artifact);
          } catch {
            // A failed artifact write is not a turn failure.
          }
        },
      },
      thinking: runningThinking,
      // The resolved set travels on the boot so the
      // `/scoped-models` case (a different closure) can report it.
      scopedModels:
        selectedRole === undefined
          ? undefined
          : {
              role: selectedRole.resolved.name,
              models:
                selectedRole.resolved.models === undefined
                  ? undefined
                  : [...selectedRole.resolved.models],
            },
      // The gauge needs the running model's window; a catalog
      // that does not know it yields none and the gauge stays off.
      contextLimits: contextLimitsOf(
        models,
        runningModel.provider,
        runningModel.id,
      ),
      journal,
      // `/resume` lists THIS boot's sessions store; `/undo`
      // resolves journal paths against the same workspace root.
      keySourceOf: (provider: string) =>
        assembled?.providers.get(provider)?.authSource,
      // The workspace a TUI session records is the process cwd (see the
      // createSession above), so "this project" is matched against it. Each
      // summary parses a session file, so one read serves the palette and
      // `/resume` for SESSION_SUMMARY_TTL_MS.
      summarizeSessions: cachedSummaries((exclude) =>
        summarizeProjectSessions({
          sessionsRoot: root,
          workspace: process.cwd(),
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
      cwd: env.cwd,
      // The turn boundary of `allow all edits this turn`.
      endApprovalTurn: () => installed.endTurn?.(),
      editsApprovedThisTurn: () => installed.editsApprovedThisTurn?.() === true,
      // The toggle's host path. `installed.setFullAccess` flips
      // the live posture the ask reads and writes posture.json + the
      // row; the returned grant carries the warning the caller reports.
      setFullAccess: (enabled: boolean): SessionFullAccessGrant => {
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
      },
      reconcile: () => {
        reconciliation?.sweep();
      },
      rebaseline: (turn: number) => {
        reconciliation?.rebaseline(turn);
      },
      // The lane samples this cell per tool call (through
      // SoloBootOptions.currentTurn) — installing the loop's counter here
      // keeps tool entries on the sweep numbering without touching boot.
      setCurrentTurnSupplier: (supplier: () => number | undefined) => {
        turnCell.supplier = supplier;
      },
      listFiles: workspaceFileLister(env),
      // Explicit skill invocation over the invocable
      // set — hidden skills included, withheld skills excluded (their
      // names resolve unknown, and completion never lists them).
      skillInvocation: {
        names: bootedSkillList.map((skill) => skill.name),
        invoke: (name: string, instructions?: string) =>
          expandSkillInvocation(bootedSkillList, name, instructions),
      },
      forkAt: async (at: number) =>
        (await forkSession(store, id, { at }, context)).id,
      ...(modelNotices.length === 0
        ? {}
        : { modelNotice: modelNotices.join('; ') }),
      ...(pendingNotices.length === 0
        ? {}
        : { pendingNotice: pendingNotices.join('; ') }),
      fullAccess,
      usageRows,
      // The loader lines for skipped skills ride the boot notices once: one
      // notice (warning on stderr before the
      // alt-screen opens, via the runner below). A clean boot stays
      // silent: `describeSkillSkips` is undefined when nothing was
      // skipped.
      ...((): { notices?: string[] } => {
        const skillSkipNotice = describeSkillSkips(skillSkips);
        const notices = [
          ...(fullAccess
            ? [fullAccessGrant?.warning ?? fullAccessInForceWarning(id)]
            : []),
          ...(skillSkipNotice === undefined ? [] : [skillSkipNotice]),
        ];
        return notices.length === 0 ? {} : { notices };
      })(),
      approvalsSkipped: installed.approvalsSkipped,
      loop: {
        ...tuiLoop(booted, context),
        // The LIVE model's modalities, resolved against the same
        // catalog `/model` switches through — a switch to a text-only model
        // refuses the next attachment (and clears the pending ones).
        supportsImages: async (loopContext) => {
          const live = await liveModelOf(booted, loopContext);
          return (
            models
              .getModels(live.provider)
              .find((model) => model.id === live.id)
              ?.input.includes('image') === true
          );
        },
        // A `/model` switch moves the context window with it, so
        // the gauge never keeps the old model's percentage.
        contextLimits: (provider, id) => contextLimitsOf(models, provider, id),
        // Resolve against the live catalog before touching the
        // conversation, so `/model typo/nope` fails by name and the lane
        // keeps the model it had; configure then commits the change to the
        // session's agent document, and the read-back is the label
        // every surface shows. The enterprise gate is the
        // boot's own: a switch outside `allowed_models`/`allowed_providers`
        // is refused with the same named error before the lane is touched,
        // so the live model stays put.
        switchModel: async (selection, loopContext, reason) => {
          // `/model` is the session override, and a
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
            // Escalation outside the role's set is refused: the live model
            // stays put, like the enterprise gate.
            roleModelScope(selectedRole?.resolved),
          );
          // With a ladder configured the switch climbs
          // it through escalateSoloModel — one-way, budget-bounded,
          // recorded — so an off-ladder target, a down-step, or an
          // exhausted budget refuses by name with the live model untouched.
          // Naming the live model is a no-op pass down the plain path
          // (no budget burned, no event); without a ladder the plain path
          // below runs exactly as before. After a climb, control falls
          // through to the re-clamp below, which commits the thinking
          // level for the NEW model in the same switch.
          const requested = `${selection.provider}/${selection.modelId}`;
          if (laneLadder !== undefined && requested !== liveModelRef) {
            await escalateLaneModel(
              booted,
              laneLadder,
              requested,
              reason ?? `/model ${requested}`,
              loopContext,
              (event) => escalationEvents.push(event),
            );
          }
          // A switch re-clamps the thinking level to the
          // NEW model's ladder and commits both in one change, so the stored
          // level, the `/thinking` report, the cycle key and the status bar
          // agree with what the provider will actually be asked for.
          const agent = await booted.conversation.agent(loopContext);
          const effective = clampThinking(
            models,
            resolved,
            agent.thinkingLevel ?? 'off',
          );
          await booted.conversation.configure(
            {
              model: { provider: resolved.provider, modelId: resolved.id },
              thinkingLevel: effective,
            },
            loopContext,
          );
          // The agent document is the truth: read the live model back instead
          // of echoing the request (it also re-clamps the compaction reserve,
          // which follows the current model live).
          const live = await liveModelOf(booted, loopContext);
          liveModelRef = `${live.provider}/${live.id}`;
          // The switch committed a re-clamped level with the
          // model — the audit rows follow it.
          liveThinkingRef = effective;
          // An explicit climb moves the auto
          // trigger's streak out from under it — restart the count on
          // the new model without spending the single auto slot.
          resetAutoEscalation(autoEscalation);
          return liveModelRef;
        },
        model: async (loopContext) => {
          const running = await liveModelOf(booted, loopContext);
          return `${running.provider}/${running.id}`;
        },
        // The thinking level lives in the same `pi.agent`
        // document as the model — nothing extra to persist, and a
        // resume restores it. The clamp is Kubic's own: a level
        // the live model does not support resolves to the nearest one, and
        // the caller reports the EFFECTIVE value, never the requested one.
        thinking: async (loopContext) => {
          const agent = await booted.conversation.agent(loopContext);
          return agent.thinkingLevel ?? 'off';
        },
        switchThinking: async (level, loopContext) => {
          const live = await liveModelOf(booted, loopContext);
          const model = models.getModel(live.provider, live.id) as
            | AnyModel
            | undefined;
          const effective =
            model === undefined ? level : clampThinking(models, model, level);
          await booted.conversation.configure(
            { thinkingLevel: effective },
            loopContext,
          );
          const agent = await booted.conversation.agent(loopContext);
          // The audit rows name the committed level.
          const committed = agent.thinkingLevel ?? effective;
          liveThinkingRef = committed;
          return committed;
        },
        supportedThinking: async (loopContext) => {
          const live = await liveModelOf(booted, loopContext);
          const model = models.getModel(live.provider, live.id) as
            | AnyModel
            | undefined;
          return model === undefined
            ? ['off']
            : supportedThinking(models, model);
        },
        // The picker's catalog. Only providers the assembly
        // marked usable are offered (a keyless built-in would fail at the
        // request, not at the switch); an injected test catalog has no
        // receipt, so every registered provider counts as usable there.
        listModels: async (loopContext) => {
          const live = await liveModelOf(booted, loopContext);
          const rows: TuiModelChoice[] = [];
          for (const provider of models.getProviders()) {
            if (assembled !== undefined) {
              const info = assembled.providers.get(provider.id);
              if (info !== undefined && !info.usable) continue;
            }
            const note =
              assembled === undefined
                ? undefined
                : assembled.providers.get(provider.id)?.origin;
            for (const model of models.getModels(provider.id)) {
              rows.push({
                provider: provider.id,
                id: model.id,
                current: provider.id === live.provider && model.id === live.id,
                ...(note === undefined ? {} : { note }),
                contextWindow: model.contextWindow,
                reasoning: model.reasoning,
                thinking: supportedThinking(models, model as AnyModel),
              });
            }
          }
          return rows;
        },
        // The picker's provider headers. A keyless built-in is
        // listed with the variable Pi's auth check would read; an injected
        // test catalog has no receipt, so every provider counts as usable.
        listProviders: async () => {
          const providers = models.getProviders().map((provider) => {
            const info = assembled?.providers.get(provider.id);
            return {
              id: provider.id,
              usable: info?.usable ?? true,
              ...(info?.authSource === undefined
                ? {}
                : { keySource: info.authSource }),
            };
          });
          const keyless = providers
            .filter((provider) => !provider.usable)
            .map((provider) => provider.id);
          const hints =
            keyless.length === 0
              ? new Map<string, string>()
              : await providerKeyHints(keyless);
          return providers.map((provider) => {
            const keyVar = hints.get(provider.id);
            return keyVar === undefined ? provider : { ...provider, keyVar };
          });
        },
        // Trajectory per settled turn: the same record
        // `kubic run` writes, holding the session's latest settled turn.
        // The entries and the transcript come adapter —
        // never a second entry reader.
        recordTurn: async (turn) => {
          const entries = await readConversationEntries(
            booted.conversation,
            context,
          );
          // The live model can have moved since boot (`/model`), so the
          // trajectory records what the lane actually runs — the same read
          // the returned `model` and the status bar use.
          let live = await liveModelOf(booted, context);
          // The single automatic trigger — N
          // consecutive tool-failure turns climb one rung, once per run,
          // never back. Runs before the trajectory persist so the
          // settling turn's own record already carries the climb.
          noteAutoEscalationTurn(
            autoEscalation,
            turn.turn?.kind === 'failed' ? turn.turn.reason : undefined,
          );
          if (laneLadder !== undefined && shouldAutoEscalate(autoEscalation)) {
            const next = nextLadderRung(
              laneLadder.steps,
              `${live.provider}/${live.id}`,
            );
            if (next !== undefined) {
              try {
                await escalateLaneModel(
                  booted,
                  laneLadder,
                  next,
                  `${AUTO_ESCALATION_TOOL_FAILURES} consecutive tool failures`,
                  context,
                  (event) => escalationEvents.push(event),
                );
                markAutoEscalated(autoEscalation);
                // The climb moved the lane: the trajectory below names
                // what the lane runs now, not what ran the settled turn.
                live = await liveModelOf(booted, context);
              } catch {
                // Best-effort: a refused climb (the shared budget burned
                // by explicit climbs since the streak started) leaves the
                // run intact; the next tool-failure retries while the
                // streak holds. escalateSoloModel validates before it
                // mutates, so a refusal records nothing.
              }
            }
          }
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
            // Every climb this run recorded —
            // explicit and automatic — lands on the trajectory, oldest
            // first. The file is overwritten per settled turn, so the
            // full sink ships every time, never a delta.
            ...(escalationEvents.length === 0
              ? {}
              : {
                  escalations: escalationEvents.map((event) =>
                    toTrajectoryEscalation(event, null),
                  ),
                }),
            // An unreadable ledger or journal is a transcript notice: the
            // screen is up, so a stderr line would paint over it.
            warn: (line: string): void => {
              transcriptNotices.push(`warning: ${line}`);
            },
          });
        },
        // The transcript rows for recorded climbs.
        // The runner drains this after every settled turn — each climb is
        // reported once, however many turns settle afterwards.
        drainEscalationRows: () => {
          const rows = escalationEvents
            .slice(reportedEscalations)
            .map((event) => formatEscalationRow(event));
          reportedEscalations = escalationEvents.length;
          return rows;
        },
        // The notices recorded since the last drain: the boot's skill
        // warnings and the settled turn's trajectory warnings.
        drainNotices: () => transcriptNotices.splice(0),
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// A settled TUI turn → the outcome its trajectory records: the
// durable turn record decides, exactly as it does for `kubic run`; a
// turn the lane never settled is a plain failure, never an invented terminus.
function tuiTurnOutcome(
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

// The model the conversation actually runs: the committed
// `pi.agent` document first, the boot model as the fallback for the window
// before the first configure.
async function liveModelOf(
  lane: Lane,
  context: Context,
): Promise<{ provider: string; id: string }> {
  const agent = await lane.conversation.agent(context);
  const live = agent.model;
  if (live !== undefined) {
    return { provider: live.provider, id: live.modelId };
  }
  return { provider: lane.model.provider, id: lane.model.id };
}

// One durable entry → the coarse transcript cell the TUI app renders. The
// tui package may not import worker types (dep-lint), so the entry is
// projected into the structural `LaneEntryLike` by hand. Message-bearing
// entries render as prompt/assistant/tool cells; a `pi.compaction` summary
// and a `pi.reset` handoff render as their own cells, while the
// positional `pi.system` prompt carries empty content and has none.
function laneEntryFor(entry: EntryRecord): LaneEntryLike | undefined {
  const role =
    entry.kind === 'pi.user'
      ? 'user'
      : entry.kind === 'pi.assistant'
        ? 'assistant'
        : entry.kind === 'pi.tool-result'
          ? 'toolResult'
          : undefined;
  if (role === undefined) {
    // A compaction summary (or a reset handoff) is part of the
    // session's story — the transcript shows it instead of dropping it. No
    // `branch_summary` entry exists in pi-durable 1.0: branching forks into a
    // new conversation.
    if (entry.kind !== 'pi.compaction' && entry.kind !== 'pi.reset') {
      return undefined;
    }
    const carried = entry.model?.[0] as { content?: unknown } | undefined;
    const content = normalizeMessageContent(carried?.content);
    if (content === undefined) return undefined;
    const data = entry.data as { reason?: unknown } | undefined;
    const reason =
      typeof data?.reason === 'string' && data.reason !== ''
        ? data.reason
        : undefined;
    return {
      id: String(entry.id),
      seq: entry.id,
      type: entry.kind === 'pi.compaction' ? 'compaction' : 'reset',
      message: { role: 'user', content },
      ...(reason === undefined ? {} : { reason }),
    };
  }
  const message = entry.model?.[0] as
    | {
        content?: unknown;
        isError?: unknown;
        toolCallId?: unknown;
        timestamp?: unknown;
        details?: unknown;
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
      // The prompt block's `you · HH:MM:SS`.
      ...(typeof message.timestamp === 'number'
        ? { timestamp: message.timestamp }
        : {}),
      // A file change's display record rides the details.
      ...(message.details === undefined ? {} : { details: message.details }),
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
  // The first screen's version and the project layer's trust
  // state — invocation facts, forwarded by name below.
  version?: string;
  projectTrust?: 'loaded' | 'untrusted';
} & TuiConfigProjection;

// The config projections `kubic tui` consumes. The lane half is
// `runtimeLaneDeps`' own return type BY NAME: a key that projection gains can
// never be silently dropped here, because the forwarding table in
// tuiBootOptions must name every key of this type.
type TuiConfigProjection = {
  // Config projections: the TUI installs the same policy
  // the headless runner does. Absent means the documented safe default.
  classes?: PermissionClasses;
  policySource?: 'config' | 'default';
  approvals?: ApprovalConfig;
  policy?: InstalledPolicy;
  // Config journal retention, threaded from the same
  // runtimeRunDeps projection `kubic run` uses.
  journalRetention?: JournalRetention;
  // Config out-of-scope paths, from that same
  // projection — the interactive lane's baseline and sweep honour them too.
  reconcileOutOfScope?: string[];
  // With: the runtime model pin the config load projected
  // (cli `--model` > `KUBIC_MODEL` > `[model]`), from the SAME runtimeModelPin
  // projection `kubic run` consumes, so the interactive boot selects what the
  // headless one selects.
  model?: ModelSelection;
  // Enterprise policy: the SAME resolved EffectivePolicy
  // `kubic run` gates with (`HeadlessRunDeps.modelPolicy`). It is the only
  // Dep the run path threads — the role-grant check, the model gate and
  // the lane tool intersection all derive from it — so a projection that
  // drops it leaves every enterprise gate inert on the
  // interactive lane.
  modelPolicy?: EffectivePolicy;
  // The pin above is a frozen enterprise `[model]`, so the
  // live `/model` switch is bound by it too (see TuiRunOptions.modelPinFrozen).
  modelPinFrozen?: boolean;
  // The `[session]` compaction policy, from the same
  // projection `kubic run` consumes — the interactive lane compacts under
  // the configured policy, not the lane defaults. Absent means the own
  // defaults.
  compaction?: LaneCompactionOptions;
  // The file text the runtime read
  // at load, from the same projection `kubic run` consumes — the
  // interactive lane assembles the same prompt. Absent means the lane
  // assembles its prompt unchanged.
  systemPromptSection?: string;
  // The `[ui] theme` reference (a built-in name or a
  // JSON theme path), threaded from the same config load `kubic run`
  // consumes. Absent means the shipped brand palette.
  theme?: string;
  // The project-trust check for skills discovery,
  // threaded from the same config report `kubic run` consumes — a store
  // grant checked per ancestor on the interactive lane.
  skills?: {
    homeDir?: string;
    cwd?: string;
    trusted?: boolean;
    trustProject?: (dir: string) => boolean;
    // The config `skills` projection.
    settingsSkills?: string[];
  };
  // The same check gates the project models.json on
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
// the config deps plus the parsed parity flags. Pure and exported so the prod
// wiring — including the model pin — is testable without opening a terminal.
// The forwarding table lives here: every TuiConfigProjection key must appear
// (possibly undefined), so omitting one is a compile error.
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
    // The `[session]` compaction policy `kubic run` threads.
    compaction: provided.compaction,
    // The `[agent] systemPromptFile` text `kubic run` threads.
    systemPromptSection: provided.systemPromptSection,
    // `[agent].name` (journal and reconciliation attribution)
    // and the `[roles.<name>]` layers `--role` merges under the document.
    agentId: provided.agentId,
    roles: provided.roles,
    // The effective thinking level with its source
    // (`--thinking` > `KUBIC_MODEL_THINKING` > file layers) — the lane
    // resolves it against the session's stored level and the role default.
    thinking: provided.thinking,
    // The merged `[model]` ladder — the lane climbs
    // the role's own rungs first.
    escalate: provided.escalate,
    model: provided.model,
    // Enterprise policy: the role-grant, model and tool
    // gates of the interactive boot all read this one object.
    modelPolicy: provided.modelPolicy,
    modelPinFrozen: provided.modelPinFrozen,
    // The `[ui] theme` reference (resolved by runTuiCommand
    // before the alt-screen opens).
    theme: provided.theme,
    // The per-path trust check and the skills roots it gates.
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
    ...(flags?.tools === undefined || flags.tools.length === 0
      ? {}
      : { toolSelection: flags.tools }),
    ...(flags?.noTools === true ? { noTools: true } : {}),
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
    // The `[ui] theme` reference, resolved by
    // runTuiCommand before the alt-screen opens (a named error and exit 2
    // when the file is missing or invalid).
    ...(provided.theme === undefined ? {} : { theme: provided.theme }),
    // The first screen's version and trust row.
    ...(provided.version === undefined ? {} : { version: provided.version }),
    ...(provided.projectTrust === undefined
      ? {}
      : { projectTrust: provided.projectTrust }),
    // The header's workspace facts and clock.
    readWorkspace: () =>
      readTuiWorkspace(
        new NodeExecutionEnv(process.cwd()).shell,
        process.cwd(),
      ),
    clock: () => new Date(),
    // The seat arrives as an argument from runTuiCommand — see TuiRunDeps.
    bootLane: (
      sessionId?: string,
      answer?: TuiApprovalSeat,
      flags?: TuiBootFlags,
    ) => boot(sessionId, tuiBootOptions(provided, flags, answer)),
  };
}

// The inspectable pair reads the session journal through
// the SAME projection `kubic diff` uses (diffEntries: one change per path,
// latest attribution). Reads are throttled like the transcript refresh: a
// burst of tool-end events collapses into one read per window, and a
// settlement (or the boot) reads at once. A read failure never reaches the
// loop — the panels keep their last rows.
const JOURNAL_REFRESH_MS = 100;

// The one builtin whose writes bypass the journal's own recording: a turn that
// ran it needs the reconcile sweep at settlement.
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
function footerForOutcome(outcome: TuiTurnOutcome): string {
  if (outcome.status === 'completed') return '';
  if (outcome.status === 'cancelled') return 'cancelled';
  return `error: ${outcome.detail ?? 'the turn failed'}`;
}

// Drives one accepted prompt to settlement (the durable submit + wait) and
// folds the conversation's committed lane events into the views as they arrive.
// `cancel` aborts the conversation through the loop's durable abort — the same
// path the quit drain uses — and a Ctrl-C that lands while the submit is still
// in flight is replayed on the real turn rather than being lost (or worse,
// treated as a quit, which would kill the process mid-turn). What the busy
// latch reads for one submitted turn. `pending` is the window between `run()`
// and the harness' admission answer (a Ctrl-C there must cancel, never quit);
// `placed` is work the harness put in the transcript. Neither is true for a
// submission waiting in the inbox — a follow-up admitted during a turn, or one
// a failed run left behind.
interface TuiRunState {
  placed: boolean;
  pending: boolean;
  submissionId?: string;
}

// The key a turn's spans hang on — the placed submission ids
// the harness names on both `run-start` and `run-end`.
function turnKey(inputs: readonly SubmissionId[]): string {
  return inputs.map((input) => String(input)).join(',');
}

export class TuiTurnRunner {
  private readonly app: TuiApp;
  private readonly loop: TuiLaneLoop;
  private model: string;
  // Every turn in flight, from the moment a submit is accepted
  // by the runner, with the placement fact the busy latch reads. A busy
  // Enter adds a QUEUED follow-up's own run here while the running turn is
  // still in it, and the single subscription below serves both: the
  // follow-up's run streams into the same transcript (exactly one lane
  // consumer per conversation).
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

  // Every lane event, after the app folded it in (the root
  // requests a journal read on tool-end).
  private readonly onLaneEvent: ((event: KubicLaneEvent) => void) | undefined;

  // Per-turn spans (absent means the turn records none).
  private readonly spans: TurnSpansSink | undefined;

  // The debug sink (absent means lines are dropped,
  // except the fault notice which always renders).
  private readonly debug: DebugSink | undefined;

  constructor(
    app: TuiApp,
    loop: TuiLaneLoop,
    model: string,
    onUpdate?: () => void,
    onLaneEvent?: (event: KubicLaneEvent) => void,
    // The session's committed spend, so the first live usage
    // event APPENDS to it instead of replacing the bar with the new row
    // alone (a resumed session's earlier turns are not re-emitted).
    usageRows: ReadonlyArray<StatusUsageRow> = [],
    // Per-turn spans; absent means the turn records none.
    spans?: TurnSpansSink,
    // The debug sink; absent drops the lines (the fault
    // notice below still renders — it does not need the sink).
    debug?: DebugSink,
  ) {
    this.app = app;
    this.loop = loop;
    this.model = model;
    this.onUpdate = onUpdate;
    this.onLaneEvent = onLaneEvent;
    this.usageRows = [...usageRows];
    this.spans = spans;
    this.debug = debug;
    this.projector = new PresentationProjector(app.presentationSeed());
  }

  // The inbox carries submission ids, not prompt text —
  // the loop owns the text of the submissions it queued, so it hands its
  // in-place map in and the projector resolves `lane.queued` from it. The
  // state is then the ONE writer of the `queued:` rows: the app writes them
  // on every presentation apply instead of only on the two events that used
  // to re-sync them.
  setQueuedText(text: ReadonlyMap<string, string>): void {
    this.projector.setQueuedText(text);
  }

  // The queue map changed under the state (a submission
  // was just admitted), so hand the app the resolved state now — the state is
  // the only writer of the `queued:` rows, and without this the row would
  // wait for the next lane event.
  refreshPresentation(): void {
    this.app.applyPresentation(this.projector.state());
    this.onUpdate?.();
  }

  // The live model label (updated by a `/model` switch), so the
  // `/model` report and the headers never read a stale boot snapshot.
  get modelRef(): string {
    return this.model;
  }

  // `/model provider/id`. The loop owns the lane-side switch
  // (catalog resolution, conversation.configure, read-back); this runner
  // keeps the model the app's status bar and every later header names.
  // The reason rides to the loop for the escalation event —
  // `/model` passes none, `/escalate` the operator's words.
  async switchModel(
    selection: ModelSelection,
    reason?: string,
  ): Promise<string> {
    const switchModel = this.loop.switchModel;
    if (switchModel === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    const label = await switchModel(
      { provider: selection.provider, modelId: selection.id },
      this.loop.context,
      reason,
    );
    this.model = label;
    // The switch re-clamped the level in the lane, so the
    // cache is dropped and re-read — the status bar and `/thinking` report
    // the effective level, not the one the previous model carried.
    this.thinking = undefined;
    const thinking = await this.liveThinking().catch(() => undefined);
    this.app.setModel(label, thinking);
    // The gauge follows the model. A loop without the lookup
    // (injected viewer shells) leaves the seeded limits alone.
    const limits = this.loop.contextLimits?.(selection.provider, selection.id);
    if (limits !== undefined) this.app.setContextLimits(limits);
    return label;
  }

  // The live thinking level (the `pi.agent` document). Read once
  // from the lane, then kept by every switch — the status bar and the
  // `/thinking` report read the same value.
  private thinking: ModelThinkingLevel | undefined;

  get thinkingRef(): ModelThinkingLevel | undefined {
    return this.thinking;
  }

  /** The live level, read from the lane on first use. */
  async liveThinking(): Promise<ModelThinkingLevel> {
    if (this.thinking !== undefined) return this.thinking;
    const read = this.loop.thinking;
    if (read === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    this.thinking = await read(this.loop.context);
    return this.thinking;
  }

  // `/thinking <level>` and the cycle key. The lane clamps to
  // what the live model supports and returns the EFFECTIVE level; the app's
  // status bar moves to it (the header keeps the model).
  async switchThinking(level: ModelThinkingLevel): Promise<ModelThinkingLevel> {
    const switchThinking = this.loop.switchThinking;
    if (switchThinking === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    const effective = await switchThinking(level, this.loop.context);
    this.thinking = effective;
    this.app.setModel(this.model, effective);
    return effective;
  }

  /** The levels the live model supports, in ladder order. */
  async supportedThinking(): Promise<readonly ModelThinkingLevel[]> {
    const supported = this.loop.supportedThinking;
    if (supported === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    return supported(this.loop.context);
  }

  /** The catalog rows the picker offers, the live model marked. */
  async listModels(): Promise<readonly TuiModelChoice[]> {
    const list = this.loop.listModels;
    if (list === undefined) {
      throw new Error('this session has no live lane to switch');
    }
    return list(this.loop.context);
  }

  /** Every provider, keyless ones included (none: an empty list). */
  async listProviders(): Promise<readonly TuiProviderChoice[]> {
    return (await this.loop.listProviders?.(this.loop.context)) ?? [];
  }

  // Busy from the moment a submit is accepted by the loop — not from the moment
  // the durable turn lands — so the Ctrl-C that follows Enter by a keystroke
  // still cancels instead of quitting. Busy means PLACED work: a follow-up
  // waiting in the inbox — admitted while a turn ran, or left behind by a
  // failed run — is not a run, so the spinner stops and the queued row is the
  // state the operator sees.
  isRunning(): boolean {
    for (const state of this.runs.values()) {
      if (state.pending || state.placed) return true;
    }
    return false;
  }

  // The single lane-event consumer for this conversation (exactly
  // one). The committed entries the events carry are folded into the feed
  // (REPLACE on the attach snapshot, upsert on a committed message or tool
  // result) instead of re-reading the lane per event; tool status drives the
  // tree and usage rows drive the status bar.
  private readonly sink: LaneEventSink = (event: KubicLaneEvent): void => {
    // The loop's own bookkeeping runs FIRST: it owns the queue map the state
    // resolves `lane.queued` from (a `run-start` drops the id the harness just
    // placed), so folding before it would hand the app a row the placement
    // already consumed — and then no further event would clear it.
    this.onLaneEvent?.(event);
    // The projector folds the event; the app renders the
    // state it produces (the presentation never folds raw events).
    const revision = this.projector.revision();
    this.projector.apply(event);
    this.app.applyPresentation(this.projector.state());
    if (this.projector.revision() !== revision) {
      // The loop's bookkeeping above repaints
      // BEFORE this write (it owns the map the state resolves the queue
      // from), so the state the write produced needs a paint of its own —
      // without one a `queued:` row it just resolved only appears on the
      // next tick. Events that do not change the state (a `message-delta`,
      // a committed `entry`) keep their own paint paths.
      this.onUpdate?.();
    }
    if (event.type === 'run-start') {
      // The run is placed: a latched Ctrl-C may now abort it for real, and a
      // submission the harness queued earlier (a follow-up waiting behind a
      // failed run) counts as work in flight from this moment.
      this.markPlaced();
      this.markPlacedInputs(event.inputs);
      // The turn's run span opens on placement.
      this.spans?.turns.startRun(turnKey(event.inputs));
    }
    if (event.type === 'snapshot') {
      // REPLACE semantics: the attach snapshot is the transcript.
      // It is also the rebase — a consumer that fell behind the
      // watch gets a fresh snapshot, so the streamed draft is stale and goes.
      this.clearStream();
      this.replaceLaneEntries(event.entries);
      return;
    }
    if (event.type === 'message-delta') {
      // The in-flight generation's text, rendered as a draft
      // while it streams. The committed entry replaces it at
      // `message_end`, so this only ever appends to the draft.
      this.streamText += event.text;
      this.app.setStream(this.streamText);
      this.onUpdate?.();
      return;
    }
    if (event.type === 'usage') {
      // The row names the provider/model that answered; the status
      // bar reads tokens + cost only.
      // The same row feeds the [model] token line (sink
      // only — the status bar already shows the spend, so the transcript
      // stays quiet).
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
      this.debug?.(
        modelLine(
          event.row.usage.input,
          event.row.usage.output,
          event.row.usage.cacheRead,
          `${event.row.provider}/${event.row.model}`,
        ),
      );
      // The committed assistant entry is here. Clear the draft
      // FIRST — `clearStream` paints nothing, so no frame can show the text
      // vanishing — and fold second, because the fold's own paint is the one
      // frame that must carry the committed cell WITHOUT the draft beside it
      // (folding first would paint the just-committed text twice).
      this.clearStream();
      this.foldLaneEntries([event.entry]);
      return;
    }
    if (event.type === 'entry') {
      // A committed non-assistant entry (a compaction summary, a
      // reset handoff, a user turn) joins the transcript live.
      this.foldLaneEntries([event.entry]);
      return;
    }
    if (event.type === 'tool-start') {
      // The turn's tool span opens with the call.
      this.spans?.turns.startTool(event.toolCallId, event.toolName);
    }
    if (event.type === 'fault') {
      // A faulted harness task (pi-durable `task_failed` —
      // Pi 1.0 has no `handler_error` event) is the handler_error
      // line. It rides the debug sink when one is attached, and it ALWAYS
      // lands as a transcript notice: the TUI has no --debug channel, so
      // a silent sink would swallow an extension/hook failure whole.
      const line = hookErrorLine(event.code, event.message);
      this.debug?.(line);
      this.app.appendNotice([line]);
    }
    if (event.type === 'tool-end' && event.entry !== undefined) {
      // A tool result that faulted or was orphaned has no entry: the tree
      // already shows the error, and the transcript has nothing to append.
      this.foldLaneEntries([event.entry]);
    }
    if (event.type === 'tool-end') {
      // Entry or not, the call settled — a faulted or orphaned
      // call has no entry but its span still closes.
      this.spans?.turns.endTool(event.toolCallId, event.isError);
    }
    if (event.type === 'run-end') {
      // The turn settled — flush its artifact (run span plus
      // its tool spans). Telemetry never fails a turn.
      const spans = this.spans;
      if (spans !== undefined) {
        const artifact = spans.turns.endRun(turnKey(event.inputs));
        if (artifact !== undefined) {
          try {
            spans.write(artifact);
          } catch {
            // A failed artifact write is not a turn failure.
          }
        }
      }
    }
  };

  // The presentation state the app renders. Seeded from the app's own
  // session facts and fed every lane event the subscription delivers.
  private readonly projector: PresentationProjector;

  // The text streamed for the in-flight generation. Cleared when
  // the committed entry lands, on a snapshot rebase and at settlement.
  private streamText = '';

  private clearStream(): void {
    if (this.streamText === '') return;
    this.streamText = '';
    this.app.setStream(undefined);
  }

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

  // The in-flight runs: a quit waits on them, bounded. The
  // runner is BUSY while a submit is still being admitted or a run is placed
  // — a queued item waiting in the inbox is not work in flight.
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

  // The harness placed a submission (`run-start`): the run that
  // was waiting for it is working now, so the busy latch must follow.
  private markPlacedInputs(inputs: readonly SubmissionId[]): void {
    for (const state of this.runs.values()) {
      if (state.submissionId === undefined) continue;
      if (inputs.some((input) => String(input) === state.submissionId)) {
        state.placed = true;
      }
    }
  }

  // The busy period's ONE subscription. It is taken by the first
  // turn and dropped when the last settles, so a queued follow-up's run —
  // placed by the harness after the first turn answers — keeps feeding the
  // same app feed. The attach snapshot is snapshot-safe: REPLACE
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

  // Quitting mid-turn aborts and drains the
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
  // to the run's trajectory — the recording never changes
  // the turn's outcome. The record is per-turn: two runs can overlap
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
    // The turn's trajectory warnings, as transcript notices (the
    // screen is up, so stderr would paint over it).
    for (const line of this.loop.drainNotices?.() ?? []) {
      this.app.appendNotice([line]);
    }
    // Report recorded climbs — explicit or
    // automatic — as transcript rows, each exactly once. The drain is
    // idempotent, so a turn settling right after a switch reports the
    // row even when the switch already drained it (then: nothing new).
    for (const row of this.loop.drainEscalationRows?.() ?? []) {
      this.app.appendNotice([row]);
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
      // The subscription is snapshot-safe: the attach snapshot
      // replaces the feed, so nothing committed between the boot read and
      // this turn can be lost, and no event can arrive before the sink is
      // listening. ONE subscription serves the whole busy period.
      await this.ensureSubscription();
      const turn = await this.loop.runTurn(prompt, {
        // The prompt is this invocation's own intent: a fresh id per submit
        // so pi-durable's requestId dedupe never collapses two prompts the
        // operator really sent.
        requestId: randomUUID(),
        context: this.loop.context,
        ...(options.images === undefined || options.images.length === 0
          ? {}
          : { images: options.images }),
        // A queued follow-up / steer is the caller's explicit
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
      // A turn that ends without a committed assistant entry
      // (an abort mid-stream) leaves no draft behind.
      this.clearStream();
      await this.refreshTranscript();
      // The lane's own terminal record is authoritative: an abort that raced
      // a completing turn must not be relabelled as cancelled (the work
      // really did land), and a turn the abort did stop settles 'aborted'.
      if (turn.kind === 'completed') return { status: 'completed' };
      if (turn.kind === 'aborted') return { status: 'cancelled' };
      // `FailureCode` is the closed vocabulary; the busy refusal is Kubic's
      // own reason and may or may not be part of it depending on the
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
      // Defensive: lane/turn.ts maps a rejected submit to a busy failure, so a
      // ConversationBusy escaping here is a wiring bug — report it as the
      // refusal it is instead of crashing the loop.
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

  // The durable abort path: conversation.abort + the conversation's
  // kill drain. It THROWS when the abort or a kill fails, so the cancel path
  // reports a refusal instead of a silent no-op and the quit drain can bound
  // it. The abort targets the conversation, which is the only turn that can
  // be in flight here (the runner admits one turn at a time).
  private async abort(): Promise<void> {
    await this.loop.abort(this.loop.context);
  }

  // Ctrl-C: the lane can always be cancelled. Part of TuiTurnDriver.
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
    // replaces it with the completed one (.5's readConversationEntries).
    this.replaceLaneEntries(entries);
  }
}

// How long one read of the session summaries serves the palette
// and `/resume` (a summary parses a whole session file).
export const SESSION_SUMMARY_TTL_MS = 30_000;

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

// The `[ui] theme` reference → the active theme. A
// built-in name (`default`, `dark`, `light`, `terminal`) needs
// no file; anything else is a JSON theme path, read through the exec bridge
// and validated against the schema (v2 token roles, or the v1 seven keys).
// Every failure is a `ThemeError` naming the reference, so the boot can
// report it before the screen opens.
export function resolveTuiTheme(
  ref: string | undefined,
  level: ColorLevel,
  files: FileBridge,
): TuiTheme {
  if (ref === undefined || ref === '' || isThemeBuiltin(ref)) {
    const name = ref === undefined || ref === '' ? 'dark' : ref;
    return createThemeFromPalette(builtinThemePalette(name), level, name);
  }
  let text: string;
  try {
    // The regular-file check comes FIRST: `readTextFile`
    // is an unbounded `readFileSync`, so a config `[ui] theme` naming a FIFO
    // would block the event loop before the alt-screen ever opens (no Ctrl-C
    // handler exists yet), `/dev/zero` would read forever, and a huge file
    // would be read whole. Same rule `readImageFile` follows.
    const info = files.fileInfo(ref);
    if (info.isFile === false) {
      throw new ThemeError(`theme '${ref}': not a regular file`);
    }
    if (info.size > THEME_MAX_BYTES) {
      throw new ThemeError(
        `theme '${ref}': too large (> ${Math.round(THEME_MAX_BYTES / 1024)} KB)`,
      );
    }
    text = files.readTextFile(ref);
  } catch (error) {
    if (error instanceof ThemeError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ThemeError(`theme '${ref}': cannot read (${detail})`);
  }
  return createThemeFromPalette(parseThemeJson(text, ref), level, ref);
}

// The `@` mention source — every file the find/grep walk would
// visit (gitignore rules honoured, node_modules/.git skipped, bounded),
// workspace-relative. Cached for a short window so a burst of keystrokes
// walks once; a failed walk lists nothing.
export const FILE_LIST_TTL_MS = 2000;

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

// The keybindings file → the registry the app
// dispatches through. A missing file is the shipped bindings; a present one
// is read through the exec bridge with the same regular-file and size guard
// as a theme, and an invalid one is a `KeybindingsError` naming the file and
// the entry, so the boot refuses it (exit 2) before the screen opens.
function resolveTuiKeybindings(path: string, files: FileBridge): KeyRegistry {
  if (!files.exists(path)) return createKeyRegistry();
  let text: string;
  try {
    const info = files.fileInfo(path);
    if (info.isFile === false) {
      throw new KeybindingsError(`keybindings '${path}': not a regular file`);
    }
    if (info.size > THEME_MAX_BYTES) {
      throw new KeybindingsError(
        `keybindings '${path}': too large (> ${Math.round(THEME_MAX_BYTES / 1024)} KB)`,
      );
    }
    text = files.readTextFile(path);
  } catch (error) {
    if (error instanceof KeybindingsError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new KeybindingsError(
      `keybindings '${path}': cannot read (${detail})`,
    );
  }
  return createKeyRegistry(parseKeybindingsJson(text, path));
}

// The `/image <path>` command of the interactive loop.
// `undefined` means the draft is a prompt, not the command. One parser for
// the dispatch and its tests: `/image` alone is the usage error, anything
// after it is the path (spaces included — a screenshot path often has them).
type TuiImageCommand =
  | { kind: 'attach'; path: string }
  | { kind: 'invalid'; message: string };

const IMAGE_COMMAND_USAGE = 'usage: /image <path> (png, jpeg, webp or gif)';

// How long an unterminated inline-image sequence is held before it is
// dropped with a footer: long enough for the
// chunks of one real paste (the pty delivers them back to back, and pi-tui's
// StdinBuffer flushes a partial OSC after 50 ms), short enough that a stray
// escape never swallows the operator's typing.
export const PASTE_IDLE_MS = 150;

// The largest theme file Kubic reads: a theme is a few
// hundred bytes of JSON, so this is generous by orders of magnitude while
// still refusing a path that would be read whole for no reason.
export const THEME_MAX_BYTES = 64 * 1024;

export const SKILL_COMMAND_USAGE = 'usage: /skill:<name> [instructions]';

export type TuiSkillInvokeCommand =
  | {
      readonly kind: 'invoke';
      readonly name: string;
      readonly instructions: string;
    }
  | { readonly kind: 'invalid'; readonly message: string };

// Explicit skill invocation: `/skill:<name>` names the
// skill, the rest is the operator's instructions. The registry owns the
// static `skill` entry for discovery; this parser owns the colon form the
// registry cannot enumerate. A bare `/skill` (or an empty name) is the
// usage error; anything else is not a skill command at all.
export function parseSkillInvokeCommand(
  prompt: string,
): TuiSkillInvokeCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/skill' && !trimmed.startsWith('/skill:')) {
    return undefined;
  }
  const rest = trimmed === '/skill' ? '' : trimmed.slice('/skill:'.length);
  const space = rest.search(/\s/);
  const name = (space === -1 ? rest : rest.slice(0, space)).trim();
  const instructions = space === -1 ? '' : rest.slice(space + 1).trim();
  if (name === '') return { kind: 'invalid', message: SKILL_COMMAND_USAGE };
  return { kind: 'invoke', name, instructions };
}

function parseImageCommand(prompt: string): TuiImageCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/image' && !trimmed.startsWith('/image ')) {
    return undefined;
  }
  const path =
    trimmed === '/image' ? '' : trimmed.slice('/image '.length).trim();
  if (path === '') return { kind: 'invalid', message: IMAGE_COMMAND_USAGE };
  return { kind: 'attach', path };
}

// The file half of the attach path: the composition root owns I/O, so the
// read, the regular-file check and the size guard live here — through the
// exec file bridge (I/O confinement), never `node:fs` directly — and the
// tui package only ever sees bytes. An absolute path is taken as typed (the
// operator named it); a relative one resolves against the workspace. A
// missing file, a directory or a file over the cap is refused by name, and
// the read is bounded so an oversize file is never loaded in full.
export type ImageFileRead =
  | { readonly ok: true; readonly filename: string; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly message: string };

export function readImageFile(files: FileBridge, path: string): ImageFileRead {
  const full = files.absolutePath(path);
  const filename = basename(full);
  let bytes: Uint8Array;
  try {
    // The regular-file check comes FIRST: `lstat` is
    // cheap and never blocks, while a synchronous read of a FIFO with no
    // writer — or of a device node like /dev/tty — blocks the event loop
    // forever, so no Ctrl-C handler could ever run. `undefined` means a
    // synthetic entry that intends a regular file.
    if (files.fileInfo(full).isFile === false) {
      return { ok: false, message: `'${filename}' is not a regular file` };
    }
    bytes =
      files.readFileRange?.(full, 0, IMAGE_MAX_BYTES + 1) ??
      files.readBinaryFile(full);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT') || message.includes('no such file')) {
      return { ok: false, message: `no such image: ${path}` };
    }
    return { ok: false, message: `cannot read ${path}: ${message}` };
  }
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    return {
      ok: false,
      message:
        `'${filename}' is too large ` +
        `(> ${formatImageBytes(IMAGE_MAX_BYTES)})`,
    };
  }
  return { ok: true, filename, bytes };
}

// The `/model` command of the interactive loop. One parser for the three forms
// the loop acts on — pick (bare: the picker), switch, invalid — so the submit
// path and its tests agree on what is a command and what is a prompt handed to
// the lane.
export type TuiModelCommand =
  | { kind: 'pick' }
  | { kind: 'switch'; selection: ModelSelection }
  | { kind: 'invalid'; message: string };

export function parseModelCommand(prompt: string): TuiModelCommand | undefined {
  if (prompt !== '/model' && !prompt.startsWith('/model ')) return undefined;
  const argument =
    prompt === '/model' ? '' : prompt.slice('/model '.length).trim();
  if (argument === '') return { kind: 'pick' };
  try {
    return { kind: 'switch', selection: parseModelFlag(argument) };
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// The `/escalate` command of the interactive loop: an
// explicit climb with a recorded reason. Unlike `/model` (the session
// override, which climbs silently), `/escalate` names WHY in the
// escalation event — the trajectory row and the transcript line carry it.
// A bare `/escalate` is a usage refusal, not a report: reporting the
// ladder is `/scoped-models`' successor's job, not this command's.
export type TuiEscalateCommand =
  | { kind: 'switch'; selection: ModelSelection; reason: string | undefined }
  | { kind: 'invalid'; message: string };

export function parseEscalateCommand(
  prompt: string,
): TuiEscalateCommand | undefined {
  if (prompt !== '/escalate' && !prompt.startsWith('/escalate '))
    return undefined;
  const argument =
    prompt === '/escalate' ? '' : prompt.slice('/escalate '.length).trim();
  if (argument === '') {
    return {
      kind: 'invalid',
      message: 'usage: /escalate <provider/id> [reason]',
    };
  }
  const space = argument.search(/\s/);
  const ref = space === -1 ? argument : argument.slice(0, space);
  const reason =
    space === -1 ? undefined : argument.slice(space).trim() || undefined;
  try {
    return { kind: 'switch', selection: parseModelFlag(ref), reason };
  } catch (error) {
    return {
      kind: 'invalid',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

// The `/compact [instructions]` command of the interactive loop. `undefined`
// means the draft is a prompt, not the command; the focus is the instructions
// Pi hands the summarizer (verbatim, via compaction.ts's compact prompt),
// absent when the operator typed `/compact` alone. One parser for the dispatch
// and its tests.
interface TuiCompactCommand {
  readonly focus: string | undefined;
}

function parseTuiCompactCommand(prompt: string): TuiCompactCommand | undefined {
  const trimmed = prompt.trim();
  if (trimmed !== '/compact' && !trimmed.startsWith('/compact ')) {
    return undefined;
  }
  const focus = parseCompactCommand(trimmed).trim();
  return { focus: focus === '' ? undefined : focus };
}

// The `/thinking <level>` command of the interactive loop (thinking.cycle).
// `undefined` means the draft is a prompt, not the command; the level
// vocabulary is the config layer's own (`THINKING_LEVELS`), so `/thinking
// bogus` is refused by name with the levels that exist.
export type TuiThinkingCommand =
  | { kind: 'pick' }
  | { kind: 'switch'; level: ModelThinkingLevel }
  | { kind: 'invalid'; message: string };

export function parseThinkingCommand(
  prompt: string,
): TuiThinkingCommand | undefined {
  if (prompt !== '/thinking' && !prompt.startsWith('/thinking ')) {
    return undefined;
  }
  const argument =
    prompt === '/thinking' ? '' : prompt.slice('/thinking '.length).trim();
  if (argument === '') return { kind: 'pick' };
  if (!isThinkingLevel(argument)) {
    return {
      kind: 'invalid',
      message: `unknown thinking level '${argument}' (levels: ${THINKING_LEVELS.join(', ')})`,
    };
  }
  return { kind: 'switch', level: argument };
}

// The parsed `kubic tui` invocation (commander owns the argv:
// ./commands/solo.ts). The parity flags carry the same names
// and value rules as their `kubic run` counterparts.
export interface TuiCommandOptions {
  readonly session?: string;
  readonly role?: string;
  readonly skills?: readonly string[];
  readonly noSkills?: boolean;
  // Session-scoped full access (bare `kubic` and `tui`).
  readonly dangerouslySkipApprovals?: boolean;
  // `--model <provider/id>`, parsed by the registrar for help and
  // validation only — dispatch already fed it to the config load as the `cli`
  // layer, so the boot reads it from the projected pin, never from here.
  readonly model?: ModelSelection;
  // `--tools <a,b>` narrows the booted
  // lane's tool set; `--no-tools` is the empty set. Mutually exclusive.
  readonly tools?: readonly string[];
  readonly noTools?: boolean;
}

export async function runTuiCommand(
  options: TuiCommandOptions,
  deps: TuiRunDeps,
): Promise<CommandResult> {
  const sessionId = options.session;
  const flags: TuiBootFlags = {};
  if (options.role !== undefined) flags.role = options.role;
  if (options.noSkills === true) flags.noSkills = true;
  const skillsList = options.skills ?? [];
  if (skillsList.length > 0) flags.skillsList = [...skillsList];
  if (options.dangerouslySkipApprovals === true) {
    flags.dangerouslySkipApprovals = true;
  }
  // The selection is a usage rule the
  // parser owns — both flags at once exit 2 before the alt-screen (the
  // boot re-validates names/agreement with the reason).
  if (options.tools !== undefined && options.noTools === true) {
    (deps.err ?? deps.out)(
      'error: --tools and --no-tools are mutually exclusive',
    );
    return { exitCode: EXIT_USAGE };
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    flags.tools = [...options.tools];
  }
  if (options.noTools === true) flags.noTools = true;
  // commander validated the id already; re-checked because it becomes a
  // path segment under the sessions root.
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    (deps.err ?? deps.out)(
      `error: invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
    return { exitCode: EXIT_USAGE };
  }
  // The `[ui] theme` reference is resolved and validated
  // BEFORE anything opens — a missing or invalid theme file is a named
  // `error:` line and exit 2, never a half-painted screen or a silent
  // fallback to the default palette. The path form is read through the exec
  // file bridge, the same seam `/image` uses.
  const files = createNodeFileBridge(process.cwd());
  let resolvedTheme: TuiTheme;
  try {
    resolvedTheme = resolveTuiTheme(
      deps.theme,
      deps.colorLevel ??
        detectColorLevel(process.env, process.stdout.isTTY === true),
      files,
    );
  } catch (error) {
    if (error instanceof ThemeError) {
      (deps.err ?? deps.out)(`error: ${error.message}`);
      return { exitCode: EXIT_USAGE };
    }
    throw error;
  }
  // The keybinding registry, resolved before anything opens. A
  // broken file refuses the boot by name; conflicts and displaced defaults
  // are reported on stderr (the main screen) and the TUI still starts.
  let keys: KeyRegistry;
  try {
    keys = resolveTuiKeybindings(
      deps.keybindingsFile ?? join(homedir(), '.kubic', 'keybindings.json'),
      files,
    );
  } catch (error) {
    if (error instanceof KeybindingsError) {
      (deps.err ?? deps.out)(`error: ${error.message}`);
      return { exitCode: EXIT_USAGE };
    }
    throw error;
  }
  for (const notice of keys.notices) {
    (deps.err ?? deps.out)(`warning: ${notice}`);
  }
  // The approval surface must exist BEFORE the lane boots, because
  // the boot installs the policy that consults the seat. The root therefore
  // creates the surface, hands its ask to the boot AS the seat, and attaches
  // the same surface to the app it builds for this boot — one object, so the
  // verdict collected on screen is the verdict the lane receives.
  const surface = createApprovalSurface({
    keyOverrides: keys.approvalOverrides(),
    ...(deps.approvalArmingMs === undefined
      ? {}
      : { armingMs: deps.approvalArmingMs }),
    ...(deps.approvalClock === undefined ? {} : { now: deps.approvalClock }),
  });
  let boot: TuiLaneBoot;
  try {
    boot = await deps.bootLane(sessionId, surface.seat, flags);
    // Tool-journaled entries share the sweep numbering — the
    // supplier reads the live counter, so creating it before the `let`
    // below executes is safe (it is only ever invoked during turns).
    boot.setCurrentTurnSupplier?.(() => reconcileTurn);
  } catch (error) {
    // No provider has a key — the first screen's
    // no-key block, printed to the terminal (no alt screen was entered, so
    // the `export` lines stay in the scrollback), then exit 6.
    if (error instanceof NoModelAvailableError) {
      const workspace = await deps.readWorkspace?.().catch(() => undefined);
      for (const line of renderNoKeyPreflight(resolvedTheme.ui, {
        project: {
          path: tildePath(process.cwd()),
          ...(workspace === undefined
            ? {}
            : workspace.branch === undefined
              ? { git: false }
              : {
                  branch: workspace.branch,
                  ...(workspace.dirty === undefined
                    ? {}
                    : { dirty: workspace.dirty }),
                }),
        },
      })) {
        (deps.err ?? deps.out)(line);
      }
      return { exitCode: EXIT_PROVIDER };
    }
    const message = error instanceof Error ? error.message : String(error);
    (deps.err ?? deps.out)(`error: ${message}`);
    if (error instanceof ModelSelectError) return { exitCode: EXIT_PROVIDER };
    // A refused tool selection is a usage error (exit 2), not a
    // generic lane boot failure.
    if (error instanceof ToolSelectionError) return { exitCode: EXIT_USAGE };
    return {
      exitCode:
        mapCaughtErrorToTerminus(error) === 'workspace_unavailable'
          ? EXIT_WORKSPACE
          : EXIT_FAILED,
    };
  }
  // Colour only for a real terminal; NO_COLOR / FORCE_COLOR honoured.
  // The level is injectable (tests pass 'none', so the suite
  // never depends on the shell's colour variables) and the theme this run
  // replaces is restored when it ends — the global never leaks.
  const previousTheme = tuiTheme();
  setTuiTheme(resolvedTheme);
  // The full-access warning lands on stderr (the main screen)
  // before the alt-screen opens, and the bar shows OFF from the first frame.
  for (const notice of boot.notices ?? []) {
    (deps.err ?? deps.out)(`warning: ${notice}`);
  }
  // Solo no-isolation notice: the trust statement is in the welcome block from
  // the first frame. Suppressed by the documented KUBIC_NO_NOTICE opt-out; the
  // text is solo-warning.ts's, never re-worded here.
  const noIsolationNotice = shouldEmitNotice(process.env) ? noIsolationTuiLine() : '';
  // The faux testing provider is never silent: while it answers, the
  // welcome block says so next to (or instead of) the lane notice.
  const noticeFor = (): string =>
    boot.model === `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`
      ? [FAUX_FOOTER, noIsolationNotice].filter((part) => part !== '').join(' · ')
      : noIsolationNotice;
  // The terminal the screen opens on (block mode's copies).
  let screenTerminal: Terminal | undefined;
  const app = createTuiApp({
    sessionId: boot.sessionId,
    model: boot.model,
    // The bar shows the lane's committed level
    // from the first frame — never the seed default the lane already moved
    // past (a clamped resume would otherwise read 'off' until Alt+T or a
    // turn refreshed it). Absent on injected boots means that default.
    thinking: boot.thinking ?? 'off',
    approvalSurface: surface,
    keys,
    ...(boot.listFiles === undefined ? {} : { listFiles: boot.listFiles }),
    // File references link under the workspace root.
    fileRoot: boot.cwd ?? process.cwd(),
    // The workspace as the approval card names it.
    cwdLabel: tildePath(boot.cwd ?? process.cwd()),
    // The boot's skill names complete `/skill:` in the
    // editor's popup.
    ...(boot.skillInvocation === undefined
      ? {}
      : { skillNames: boot.skillInvocation.names }),
    // The posture comes from the installed policy.
    approvalsSkipped: boot.approvalsSkipped?.() ?? boot.fullAccess === true,
    ...(boot.contextLimits?.contextWindow === undefined
      ? {}
      : { contextWindow: boot.contextLimits.contextWindow }),
    ...(boot.contextLimits?.compactionThreshold === undefined
      ? {}
      : { compactionThreshold: boot.contextLimits.compactionThreshold }),
    // The welcome block's honest notice, and the header clock.
    laneNotice: noticeFor,
    // Block mode's copies — OSC 52 on the terminal the screen
    // runs on (through tmux's passthrough when inside it); refused on a
    // terminal known to drop it, so a copy is never claimed falsely.
    // The status line's word on a turn's edit batch — the
    // policy of whichever boot is current.
    editsApprovedThisTurn: () => boot.editsApprovedThisTurn?.() === true,
    clipboard: (text: string): boolean => {
      if (!clipboardSupported(process.env)) return false;
      const target = screenTerminal;
      if (target === undefined) return false;
      target.write(osc52(text, { tmux: (process.env.TMUX ?? '') !== '' }));
      return true;
    },
    // The first screen's facts only this boot has.
    preflight: {
      ...(deps.version === undefined ? {} : { version: deps.version }),
      ...(boot.keySourceOf === undefined
        ? {}
        : { keySource: boot.keySourceOf }),
      testingModel: `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`,
      ...(deps.projectTrust === undefined ? {} : { trust: deps.projectTrust }),
      // The limits modules' own lines, verbatim (and suppressed the same
      // way); the faux note is the provider row's, not the isolation row's.
      isolation: noticeFor,
    },
    ...(deps.clock === undefined
      ? {}
      : { clock: () => formatClock(deps.clock?.() ?? new Date()) }),
  });
  // The resumed session's committed spend is on the bar from the
  // first frame, not only after the next turn's usage event.
  app.setUsage(boot.usageRows ?? []);
  // A resumed session's committed prompts seed the
  // editor's Up history before the screen opens. Best-effort: a read that
  // fails leaves the history empty, never the boot.
  if (sessionId !== undefined && boot.loop !== undefined) {
    try {
      const entries = await boot.loop.entries(boot.loop.context);
      app.seedPromptHistory(
        userPromptsOf(
          entries
            .map(laneEntryFor)
            .filter((entry): entry is LaneEntryLike => entry !== undefined),
        ),
      );
    } catch {
      // Recall is a convenience; the resumed session stands without it.
    }
  }
  // Re-read after each turn (and each mid-turn refresh): a posture change
  // lands on the indicator in the same frame the loop paints next.
  const syncPosture = (): void => {
    if (boot.approvalsSkipped !== undefined)
      app.setApprovalsSkipped(boot.approvalsSkipped());
  };
  // Code highlighting's grammars load once, before the first
  // frame — the other commands never pay for them.
  await loadHighlighter();
  const terminal = deps.createTerminal();
  screenTerminal = terminal;
  // The Ctrl-O / Ctrl-R panels read the session journal the
  // boot created — loaded once now (a resumed session shows its earlier
  // turns), after each tool call (throttled) and at every settlement.
  // Declared before the feed: its `apply` reads both, and the boot read below
  // runs synchronously — a `let` declared later is a TDZ ReferenceError there
  // that the feed's catch would swallow on every boot.
  let screen: Screen | undefined;
  let stopped = false;
  // The feed reads the CURRENT boot's store, so `/new` and
  // `/resume` never leave a stale reader behind (the feed itself is
  // session-agnostic and is built once).
  const journalFeed =
    boot.journal === undefined && deps.journalFeedError === undefined
      ? undefined
      : new JournalPanelFeed({
          read: () => {
            const store = boot.journal;
            return store === undefined ? [] : diffEntries(store, {});
          },
          apply: (rows) => {
            app.setJournalChanges(rows);
            if (!stopped) screen?.update();
          },
          ...(deps.journalFeedError === undefined
            ? {}
            : { onError: deps.journalFeedError }),
        });
  journalFeed?.now();
  // Set when a shell tool ended in the turn in flight — the only
  // builtin whose writes bypass the journal, so the only reason a settlement
  // needs the reconcile sweep (which walks and hashes the whole workspace:
  // not free, so file-tool and read-only turns skip it).
  let shellRanThisTurn = false;
  // The reconciliation turn — one per placed run in this
  // process. A run start re-baselines (sweeping a shell turn first if its
  // settlement has not yet), a settlement with no other run in flight
  // re-baselines again, and so does an idle quit: the sweep only ever
  // journals what changed while a turn was running.
  let reconcileTurn = 0;
  // Open from a run start until that turn's settlement re-baselines: a quit
  // while a turn is open (even one already drained) leaves the baseline
  // alone so the close's sweep journals that turn's late writes.
  let reconcileTurnOpen = false;
  const sweepPendingShell = (): void => {
    if (!shellRanThisTurn) return;
    shellRanThisTurn = false;
    try {
      boot.reconcile?.();
    } catch {
      // Reconciliation observes, it never gates the loop.
    }
  };
  const rebaseline = (): void => {
    try {
      boot.rebaseline?.(reconcileTurn);
    } catch {
      // A failed capture leaves the previous baseline; the loop stands.
    }
  };
  // The conversation's inbox as the lane reports it (`pi.inbox`
  // via `inbox_update`), plus the prompt text of every submission the loop
  // queued — the inbox carries ids, not content. The `queued: …` rows are
  // derived from the two (and only from them), so admission, placement and
  // withdrawal all come from pi-durable's own queue: Kubic owns no queue
  // state and cannot promise a delivery the harness did not take.
  let queuedInbox: readonly KubicInboxItem[] = [];
  const queuedText = new Map<string, string>();
  // The images a queued follow-up carries, keyed by submission
  // id — the inbox carries ids, not content, so the echo that replaces the
  // queued row when the harness PLACES it must render them from here.
  const queuedImages = new Map<string, readonly LaneImagePart[]>();
  const queuedCount = (): number =>
    queuedInbox.filter((item) => queuedText.has(item.id)).length;
  // No `app.setQueuedPrompts` here — the state carries
  // the queue (`turn.setQueuedText(queuedText)` below) and the app writes the
  // rows from it on every presentation apply. Writing them from this side too
  // was the bug: the app's own write on the NEXT event wiped what this one
  // had just set.
  // `/new` and `/resume` replace the lane, so the drivers are
  // rebuilt (a fresh runner starts with an empty feed and no subscription).
  let turn: TuiTurnRunner | undefined;
  const buildTurn = (): TuiTurnRunner | undefined => {
    if (boot.loop === undefined) return undefined;
    const next = new TuiTurnRunner(
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
        // A fresh inbox list replaces the queued rows (it is
        // a snapshot); a `run-start` names the submission the harness
        // just PLACED, so its row becomes the pending echo instead.
        // The rows are painted by the runner AFTER it writes the state
        // (the sink's own repaint): this fan-out runs first because it
        // owns the map the state resolves against, so a paint here would
        // be the frame BEFORE the write.
        if (event.type === 'inbox') {
          queuedInbox = event.items;
        }
        if (event.type === 'run-start') {
          sweepPendingShell();
          reconcileTurn += 1;
          reconcileTurnOpen = true;
          rebaseline();
          for (const input of event.inputs) {
            const id = String(input);
            const text = queuedText.get(id);
            if (text === undefined) continue;
            queuedText.delete(id);
            // The queued draft's attachments ride with its echo
            // (`setPendingImages` before `setPendingEcho`, the order the
            // echo's render reads them in).
            const images = queuedImages.get(id) ?? [];
            queuedImages.delete(id);
            app.setPendingImages(images);
            // Nothing is armed any more: the composer is empty and the echo
            // carries the images, so a blank Enter here is a no-op.
            app.setPendingAttachments(0);
            app.setPendingEcho(text);
          }
          // The placed submission is work in flight now: a queued
          // follow-up that waited behind a failed run starts the spinner
          // again.
          syncBusyForLoop?.();
        }
      },
      boot.usageRows,
      boot.turnSpans,
      boot.debug,
    );
    // EVERY runner gets the loop's in-place queue
    // map, not just the initial one — `/new` and `/resume` rebuild the runner
    // (`rebindSession`), and a rebuilt runner with its own empty map resolves
    // every inbox id to nothing, so the `queued:` row never renders.
    next.setQueuedText(queuedText);
    return next;
  };
  turn = buildTurn();
  // The driver of the turn in flight (a prompt turn or a compaction).
  let activeTurn: TuiTurnDriver | undefined;
  // The busy latch follows PLACED work, and the lane
  // event handler above (registered before the submit path exists) must
  // re-sync it when the harness places a queued submission.
  let syncBusyForLoop: (() => void) | undefined;
  // Alt+M / Alt+T, defined with the lane wiring below (the key
  // router is registered first).
  let pickModelForLoop: (() => void) | undefined;
  let cycleThinkingForLoop: (() => void) | undefined;
  // Ctrl-P's palette, defined with the submit path below.
  let paletteForLoop: (() => void) | undefined;
  // Alt+A's full-access toggle, defined with the submit path.
  let fullAccessForLoop: (() => void) | undefined;
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
  // The header clock repaints only when the shown minute
  // changes; a 30 s tick lands within half a minute of it.
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  const stopClock = (): void => {
    if (clockTimer !== undefined) clearInterval(clockTimer);
    clockTimer = undefined;
  };
  const startClock = (): void => {
    const clock = deps.clock;
    if (clock === undefined) return;
    stopClock();
    let shown = formatClock(clock());
    clockTimer = setInterval(() => {
      if (stopped) {
        stopClock();
        return;
      }
      const now = formatClock(clock());
      if (now === shown) return;
      shown = now;
      screen?.update();
    }, TUI_CLOCK_TICK_MS);
    clockTimer.unref?.();
  };
  // The header's project / branch / dirty count — read once the
  // screen is up and after every settled turn. A failed read keeps the last
  // facts (the reader itself never throws).
  // This project's recent sessions on the first screen, read in
  // the background (the cached read also serves `/resume` and the palette).
  const loadRecentSessions = (): void => {
    const summarize = boot.summarizeSessions;
    if (summarize === undefined) return;
    void summarize(boot.sessionId).then(
      (summaries) => {
        if (stopped) return;
        app.setRecentSessions(
          summaries
            // A session that never ran a prompt is not worth a row here
            // (`/resume` still lists it).
            .filter(
              (summary) =>
                summary.state === 'ready' && (summary.turns ?? 0) > 0,
            )
            .slice(0, 3)
            .map((summary) => {
              const created =
                summary.createdAt === undefined
                  ? Number.NaN
                  : Date.parse(summary.createdAt);
              const turns = summary.turns ?? 0;
              return {
                title: summary.title ?? summary.id,
                age: Number.isNaN(created)
                  ? ''
                  : formatAge(Date.now() - created),
                detail: `${turns} turn${turns === 1 ? '' : 's'}${
                  summary.costUsd === undefined
                    ? ''
                    : ` · ${formatCost(summary.costUsd)}`
                }`,
              };
            }),
        );
        screen?.update();
      },
      () => {},
    );
  };
  const refreshWorkspace = (): void => {
    const read = deps.readWorkspace;
    if (read === undefined) return;
    void read().then(
      (next) => {
        if (stopped) return;
        app.setWorkspace(next);
        screen?.update();
      },
      () => {},
    );
  };
  let exitCode: ExitCode = EXIT_OK;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  // SIGINT, SIGTERM and SIGHUP all run the same
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
  // The last-resort restore. An exception in input or render, or
  // an unhandled rejection, would otherwise kill the process with the alt
  // screen, raw mode, mouse tracking and the Kitty protocol still active.
  // The terminal is restored first (nothing is printed — the layout may be
  // what threw), then the error is reported and the process exits 1.
  let fatalHandled = false;
  const fatal = (error: unknown): void => {
    if (fatalHandled) return;
    fatalHandled = true;
    stopped = true;
    exitCode = EXIT_FAILED;
    stopSpinner();
    stopClock();
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
    (deps.exit ?? ((code: number) => process.exit(code)))(EXIT_FAILED);
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
  // Set while a quit drains a running turn; calling it ends the
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
    stopClock();
    // A quit (SIGINT, stdin EOF, or the loop's own quit path) must
    // settle a pending approval as a deny — the turn that is waiting on it
    // would otherwise sit until the lane's timeout, and the operator gets no
    // second chance to answer a screen they have left.
    surface.cancelPending('the session quit before the approval was answered');
    stdin?.removeListener('end', onStdinEnd);
    stdin?.removeListener('close', onStdinEnd);
    // A turn still running is aborted and
    // drained BEFORE the sweep and the session close — otherwise its detached
    // process group outlives the session, its late writes escape both the
    // journal and the reconciliation, and the operation never records a
    // terminal status. The screen stays up (footer: cancelling…) until the
    // drain ends, bounded by drainTimeoutMs.
    const draining = activeTurn?.isRunning() === true;
    // The drain has its own bound, and the close gets a FRESH one
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
      app.setCancelling(true);
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
      // Pop the Kitty protocol and let late input (the quitting
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
      // An idle quit re-baselines first, so the close's sweep
      // (which still catches a turn the quit interrupted) never journals an
      // edit the operator made after the last turn settled.
      if (!reconcileTurnOpen) rebaseline();
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
    // Focus the editor, not the tree — the loop's primary input
    // target is the prompt. T/t do not toggle (they type); Ctrl-T does.
    booted.tui.setFocus(app.editor);
    app.editor.bind(booted.tui);
    // The overlay seat. The app renders the approval through the
    // live alt-screen from here on; on a terminal too narrow for the overlay
    // (its own visible() gate) the inline body is the surface instead.
    app.attachApprovalOverlay(booted.tui);
    // A pending operation settled at boot (and a model notice)
    // is on the notice row from the first frame. The trust statement is the
    // welcome block's.
    app.setEditorFooter(
      [boot.pendingNotice, boot.modelNotice]
        .filter((line): line is string => line !== undefined)
        .join(' · '),
    );
    attachFatal();

    booted.render();
    startClock();
    refreshWorkspace();
    loadRecentSessions();
    attachSignals();
    stdin?.once('end', onStdinEnd);
    stdin?.once('close', onStdinEnd);
    booted.tui.addInputListener((data: string) => {
      // An exception anywhere in input handling (including the
      // synchronous paints it triggers) restores the terminal first.
      try {
        return routeInput(data);
      } catch (error) {
        fatal(error);
        return { consume: true };
      }
    });
    // The one submit path is defined with the lane wiring below
    // (it needs the drivers and the session mode), while this key router is
    // registered first — so the steer key reaches it through this holder.
    let submitForLoop:
      | ((prompt: string, steer: boolean) => TuiSubmitOutcome)
      | undefined;
    // How many queued prompts the cancel in flight is about to
    // withdraw. pi-durable's abort clears the inbox, so the settlement
    // footer of every cancelled turn names the count — deterministic,
    // whichever of the running/queued turns settles last.
    let droppedOnCancel = 0;
    // The images the next submitted prompt carries.
    // Each one is validated (magic bytes, size) and capability-checked
    // against the live model at ATTACH time, so a submit never spends a turn
    // on bytes the provider would reject.
    let pendingImages: AttachmentImage[] = [];
    // The exec file bridge the `/image` read goes through: the same
    // seam the session store uses, rooted at the workspace, and an absolute
    // path is taken as typed because the operator named it. The theme
    // resolution above uses the same bridge.
    const imageFiles = files;
    // A large inline paste arrives in chunks, so a partial
    // OSC 1337 sequence is held here across listener calls (bounded) instead
    // of being typed into the draft as raw escape + base64. `droppingPaste`
    // is the state after one that was past the cap: its remaining chunks are
    // payload and are discarded up to the terminator.
    let pasteBuffer = '';
    let droppingPaste = false;
    let dropCarry = '';
    let pasteIdle: ReturnType<typeof setTimeout> | undefined;
    // A partial sequence that never completes must not swallow the operator's
    // typing for the rest of the session: after
    // a short idle window the held bytes are dropped and the footer says so.
    // The discard state needs the same valve: a paste whose
    // terminator never arrives — a >5 MB one the pty truncated, the very
    // condition that gets you into that state — would otherwise swallow every
    // later keystroke, Ctrl-C included, until stdin closed. The window is
    // re-armed by each chunk of a live paste, so the state survives a paste
    // that is still arriving and ends once the stream stops.
    const armPasteIdle = (): void => {
      if (pasteIdle !== undefined) clearTimeout(pasteIdle);
      pasteIdle = setTimeout(() => {
        pasteIdle = undefined;
        if (stopped) return;
        const wasDropping = droppingPaste;
        if (pasteBuffer !== '') pasteBuffer = '';
        else if (wasDropping) {
          droppingPaste = false;
          dropCarry = '';
        } else return;
        // The discard state keeps its own, more useful message: the paste
        // really was over the cap, and the operator needs to know input is
        // live again.
        setImagesFooter(
          wasDropping ? tooLargeFooter : 'pasted image incomplete — ignored',
        );
      }, PASTE_IDLE_MS);
      pasteIdle.unref?.();
    };
    const clearPasteIdle = (): void => {
      if (pasteIdle === undefined) return;
      clearTimeout(pasteIdle);
      pasteIdle = undefined;
    };
    const tooLargeFooter = `pasted image is too large (> ${formatImageBytes(IMAGE_MAX_BYTES)})`;
    const setImagesFooter = (text: string): void => {
      app.setEditorFooter(text);
      if (!stopped) screen?.render();
    };
    const attachImage = async (offer: {
      filename: string;
      bytes: Uint8Array;
    }): Promise<void> => {
      const verdict = validateImageAttachment({
        filename: offer.filename,
        bytes: offer.bytes,
      });
      if (!verdict.ok) {
        setImagesFooter(verdict.message);
        return;
      }
      const loop = boot.loop;
      const supported = await loop?.supportsImages?.(loop.context);
      if (supported !== true) {
        setImagesFooter(
          `image refused: ${turn?.modelRef ?? boot.model} does not accept image input`,
        );
        return;
      }
      const image: AttachmentImage = {
        filename: offer.filename,
        mimeType: verdict.mimeType,
        bytes: offer.bytes.byteLength,
        data: Buffer.from(offer.bytes).toString('base64'),
      };
      pendingImages = [...pendingImages, image];
      app.setPendingImages(pendingImages);
      // The armed-but-unsubmitted count the
      // editor's blank-submit rule reads.
      app.setPendingAttachments(pendingImages.length);
      setImagesFooter(
        `image attached: ${image.filename} (${formatImageBytes(image.bytes)}) — Enter sends it`,
      );
    };
    const attachFromPath = async (path: string): Promise<void> => {
      const read = readImageFile(imageFiles, path);
      if (!read.ok) {
        setImagesFooter(read.message);
        return;
      }
      await attachImage({ filename: read.filename, bytes: read.bytes });
    };
    const attachPasted = async (
      base64: string,
      filename: string,
    ): Promise<void> => {
      // Refuse an oversize paste BEFORE decoding it: the
      // base64 text is already in memory (the terminal delivered it), but the
      // decoded payload would be a second, larger allocation. 4/3 is base64's
      // own expansion; the slack covers padding and line breaks.
      if (base64.length > Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 4) {
        setImagesFooter(
          `'${filename}' is too large (> ${formatImageBytes(IMAGE_MAX_BYTES)})`,
        );
        return;
      }
      await attachImage({
        filename,
        bytes: Buffer.from(base64, 'base64'),
      });
    };
    const routeInput = (data: string): { consume: true } | undefined => {
      if (stopped) {
        // While a quit drains, a second Ctrl-C ends the wait.
        // Only a real press counts: a held key's repeats and
        // its release are the same key, and repeats of global keys are
        // ignored everywhere else, so a held Ctrl-C must not cut the drain.
        if (!isKeyRelease(data) && !isKeyRepeat(data) && keyIs(data, 'ctrl+c'))
          shutdown();
        return { consume: true };
      }
      // Defence in depth: TuiApp.handleInput already drops Kitty
      // key releases, but the quit/cancel counting below must never see one
      // even if a future caller routes around it — a Ctrl-C release counted
      // as the second Ctrl-C would quit the session on key-up.
      if (isKeyRelease(data)) return { consume: true };
      // While a paste past the cap is being
      // discarded, its remaining chunks are pure payload — consume them
      // until the sequence's terminator instead of typing base64 into the
      // draft. A chunk that ends mid-terminator keeps its ESC for the next
      // call.
      if (droppingPaste) {
        const text = dropCarry + data;
        const end = inlineImageTerminatorEnd(text);
        if (end === undefined) {
          dropCarry = data.endsWith('\u001b') ? '\u001b' : '';
          armPasteIdle();
          return { consume: true };
        }
        droppingPaste = false;
        dropCarry = '';
        clearPasteIdle();
        const rest = text.slice(end);
        if (rest === '') return { consume: true };
        return routeInput(rest);
      }
      // A terminal that pastes an image inline (iTerm2's OSC
      // 1337 `File=` sequence) hands the bytes to the attach path — the
      // editor would otherwise insert the base64 payload as draft text. The
      // scanner also reassembles a sequence the pty split across calls; the
      // text before an unterminated sequence still routes normally.
      const scan = scanInlineImageChunk(pasteBuffer, data);
      if (scan.kind === 'image') {
        pasteBuffer = '';
        clearPasteIdle();
        void attachPasted(scan.image.base64, scan.image.filename);
        return { consume: true };
      }
      if (scan.kind === 'too-large') {
        pasteBuffer = '';
        droppingPaste = true;
        dropCarry = '';
        armPasteIdle();
        setImagesFooter(tooLargeFooter);
      } else {
        pasteBuffer = scan.kind === 'pending' ? scan.buffer : '';
        if (pasteBuffer !== '') armPasteIdle();
        else clearPasteIdle();
      }
      const routedData =
        scan.kind === 'pending' || scan.kind === 'too-large' ? scan.head : data;
      if (routedData === '') return { consume: true };
      const routed = app.handleInput(routedData);
      // Alt+Enter carried the draft out of the editor. Busy, the
      // text steers the running turn through the harness' steer queue; idle,
      // it submits like Enter (with the same pending echo).
      if (routed.pickModel === true) {
        pickModelForLoop?.();
        return { consume: true };
      }
      if (routed.cycleThinking === true) {
        cycleThinkingForLoop?.();
        return { consume: true };
      }
      if (routed.palette === true) {
        paletteForLoop?.();
        return { consume: true };
      }
      if (routed.fullAccess === true) {
        fullAccessForLoop?.();
        return { consume: true };
      }
      if (routed.steer !== undefined) {
        const steered = routed.steer;
        const outcome = submitForLoop?.(steered, true);
        if (outcome === 'refused') {
          // Only a REFUSAL hands the draft back — the
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
      // The interrupt both keys share: Ctrl-C's first press during a turn
      // and Esc. The footer is set synchronously so the
      // cancellation is visible on the very next frame — the abort itself is
      // async.
      const interruptTurn = (running: TuiTurnDriver): void => {
        // The queue is pi-durable's, and the abort withdraws
        // every queued input with it (`conversation.abort()`). Count what
        // goes so the cancelled turns' footers can say it, instead of the
        // prompts silently vanishing.
        droppedOnCancel = queuedCount();
        app.setEditorFooter('cancelling…');
        app.setCancelling(true);
        screen?.render();
        void running
          .cancel()
          .then((accepted) => {
            if (stopped) return;
            // A refused abort must never be silent: without this the
            // operator presses the key, the lane refuses (requestLaneAbort
            // throws LaneDriveError), and the screen shows nothing — a
            // no-op key with no explanation. The loop keeps running.
            if (!accepted) {
              droppedOnCancel = 0;
              app.setCancelling(false);
              app.setEditorFooter('cancel failed — turn still running');
            }
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setCancelling(false);
            app.setEditorFooter(
              `cancel failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };
      // Esc interrupts a running turn and never quits — a second
      // Esc while the interrupt drains does nothing, and a lane that cannot
      // cancel says so instead of quitting.
      if (routed.interrupt === true) {
        const running = activeTurn;
        if (running?.isRunning() === true) {
          if (!running.canCancel()) {
            app.setEditorFooter(
              `this run cannot be interrupted here — press ${keys.label('app.interrupt')} twice to quit`,
            );
          } else if (!running.isCancelling()) {
            interruptTurn(running);
            return { consume: true };
          }
        }
        screen?.update();
        return { consume: true };
      }
      if (routed.quit) {
        if (routed.cancel && activeTurn?.isRunning()) {
          // A lane that cannot cancel never fakes it — Ctrl-C
          // quits instead (the shutdown drain is bounded).
          if (!activeTurn.canCancel()) {
            shutdown();
            return { consume: true };
          }
          // Ctrl-C during a turn. The first one cancels the operation and
          // keeps the session alive; a second one (while the cancellation is
          // still draining) quits, which is the contract docs/cli/commands.md
          // ships.
          if (!activeTurn.isCancelling()) {
            interruptTurn(activeTurn);
            return { consume: true };
          }
        }
        shutdown();
        return { consume: true };
      }
      // A consuming listener pre-empts pi-tui's own post-input
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
    if (turn !== undefined) {
      // `/model` never reaches the lane as a prompt. The report
      // and the refusal are footer lines (the editor row's always-visible
      // status surface); a successful switch updates the app's model label
      // and leaves a confirmation behind.
      const handleModelCommand = (command: TuiModelCommand): void => {
        if (turn === undefined) {
          app.setEditorFooter('model switch needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        // A bare `/model` opens the picker (the way in where
        // Alt+M types `µ`, as macOS Option does).
        if (command.kind === 'pick') {
          openModelPicker();
          return;
        }
        if (command.kind === 'invalid') {
          app.setEditorFooter(`model switch failed: ${command.message}`);
          if (!stopped) screen?.render();
          return;
        }
        switchModelTo(command.selection);
      };
      // `/escalate <ref> [reason]` — the explicit
      // climb. Same busy guard and switch path as `/model`; the reason
      // travels to the loop so the escalation event names it.
      const handleEscalateCommand = (command: TuiEscalateCommand): void => {
        if (turn === undefined) {
          app.setEditorFooter('model switch needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        if (command.kind === 'invalid') {
          app.setEditorFooter(`escalation failed: ${command.message}`);
          if (!stopped) screen?.render();
          return;
        }
        switchModelTo(command.selection, command.reason);
      };
      // `/new` and `/resume` swap the session under the running
      // TUI. The next lane boots FIRST (a failed boot keeps the session the
      // operator was in), the previous one closes, and every lane-bound
      // object and session-scoped surface is rebuilt — the alt-screen, the
      // terminal and the app itself are never torn down.
      const rebindSession = async (nextSessionId?: string): Promise<void> => {
        const previous = boot;
        const next = await deps.bootLane(nextSessionId, surface.seat, flags);
        await previous.close?.();
        await adoptBoot(next);
      };
      // Every lane-bound object and session-scoped surface follows the boot.
      const adoptBoot = async (next: TuiLaneBoot): Promise<void> => {
        boot = next;
        // Every re-boot (session switch, fork) gets the live
        // counter too — a fresh boot's cell starts unwired.
        next.setCurrentTurnSupplier?.(() => reconcileTurn);
        activeTurn = undefined;
        inFlightTurns = 0;
        droppedOnCancel = 0;
        queuedInbox = [];
        queuedText.clear();
        shellRanThisTurn = false;
        reconcileTurn = 0;
        reconcileTurnOpen = false;
        turn = buildTurn();
        app.resetSession({
          sessionId: next.sessionId,
          model: next.model,
          usage: next.usageRows ?? [],
        });
        syncPosture();
        app.setEditorFooter(
          [next.pendingNotice, next.modelNotice]
            .filter((line): line is string => line !== undefined)
            .join(' · '),
        );
        journalFeed?.now();
        await turn?.refreshTranscript();
        // After the first read: a transcript snapshot replaces the notice
        // cells, so an earlier append would be wiped. The alt-screen is up, so
        // the new lane's boot notices (full access, skipped skills) join its
        // queued warnings here, as transcript rows and never on stderr.
        const rows = [
          ...(next.notices ?? []).map((notice) => `warning: ${notice}`),
          ...(next.loop?.drainNotices?.() ?? []),
        ];
        for (const line of rows) app.appendNotice([line]);
        if (!stopped) screen?.render();
      };

      // The commands this TUI answers itself. Every one of them
      // reports on the footer (and, when there is something to read, in the
      // transcript) and NONE of them reaches the model.
      // The commands this TUI answers itself. Every one of them
      // reports on the footer (and, when there is something to read, in the
      // transcript) and NONE of them reaches the model.
      //
      // The side-effecting entries dispatch on the `command` their
      // registry row names (typed, never a bare string); the local reads
      // carry no presentation command and dispatch by name. The
      // side-effecting commands are refused while a turn runs — they swap or
      // close the session under it (the quit path's drain is the only place
      // that owns that race).
      const busyRefusal = (what: string): TuiSubmitOutcome => {
        app.setEditorFooter(
          `${what}: finish the current turn before switching`,
        );
        if (!stopped) screen?.render();
        return 'refused';
      };
      const openNewSession = (): TuiSubmitOutcome => {
        app.setEditorFooter('session: booting a fresh session…');
        if (!stopped) screen?.render();
        void rebindSession(undefined)
          .then(() => {
            if (stopped) return;
            app.setEditorFooter(`session: ${boot.sessionId} (new)`);
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `session: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
        return 'accepted';
      };
      // `/resume`'s choice, and the palette's SESSIONS rows.
      const resumeSession = (id: string): void => {
        if (activeTurn?.isRunning() === true) {
          busyRefusal('session');
          return;
        }
        app.setEditorFooter(`session: attaching ${id}…`);
        screen?.render();
        void rebindSession(id)
          .then(() => {
            if (stopped) return;
            app.setEditorFooter(`session: ${boot.sessionId} (resumed)`);
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `session: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };
      // One picker row per summarized session — its first
      // prompt, then age · turns · cost; a held one greyed with why.
      const sessionPickerRow = (summary: SessionSummary): TuiPickerRow => {
        const created =
          summary.createdAt === undefined
            ? Number.NaN
            : Date.parse(summary.createdAt);
        const detail = [
          Number.isNaN(created) ? undefined : formatAge(Date.now() - created),
          summary.turns === undefined
            ? undefined
            : `${summary.turns} turn${summary.turns === 1 ? '' : 's'}`,
          summary.costUsd === undefined
            ? undefined
            : formatCost(summary.costUsd),
        ].filter((part): part is string => part !== undefined);
        return {
          value: summary.id,
          label: summary.title ?? summary.id,
          ...(detail.length === 0 ? {} : { description: detail.join(' · ') }),
          ...(summary.state === 'ready'
            ? {}
            : { disabled: true, note: 'in use by another kubic' }),
        };
      };
      const openSessionPicker = (
        summarize: (exclude?: string) => Promise<readonly SessionSummary[]>,
      ): TuiSubmitOutcome => {
        app.setEditorFooter('resume: reading this project’s sessions…');
        if (!stopped) screen?.render();
        void summarize(boot.sessionId)
          .then((summaries) => {
            if (stopped) return;
            if (summaries.length === 0) {
              app.setEditorFooter('resume: no other sessions in this project');
              screen?.render();
              return;
            }
            app.setEditorFooter('');
            const opened = app.openPicker({
              title: 'Session',
              rows: summaries.map(sessionPickerRow),
              onSelect: resumeSession,
              onCancel: () => {
                if (stopped) return;
                app.setEditorFooter('resume: cancelled');
                screen?.render();
              },
            });
            if (!opened) {
              app.setEditorFooter(
                'resume needs a wider terminal — use kubic sessions list',
              );
            }
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `resume: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
        return 'accepted';
      };
      const openResumePicker = (): TuiSubmitOutcome => {
        if (boot.summarizeSessions !== undefined) {
          return openSessionPicker(boot.summarizeSessions);
        }
        const list = boot.listSessions;
        if (list === undefined) {
          app.setEditorFooter(
            'resume: this session cannot list other sessions',
          );
          if (!stopped) screen?.render();
          return 'refused';
        }
        void list()
          .then((rows) => {
            if (stopped) return;
            const others = rows.filter((row) => row.id !== boot.sessionId);
            if (others.length === 0) {
              app.setEditorFooter('resume: no other sessions');
              screen?.render();
              return;
            }
            const opened = app.openPicker({
              rows: others.map((row) => ({
                value: row.id,
                label: row.id,
                description: [row.cwd, row.createdAt]
                  .filter((part): part is string => part !== undefined)
                  .join(' · '),
              })),
              onSelect: resumeSession,
              onCancel: () => {
                if (stopped) return;
                app.setEditorFooter('resume: cancelled');
                screen?.render();
              },
            });
            if (!opened) {
              app.setEditorFooter(
                'resume needs a wider terminal — use kubic sessions list',
              );
            }
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `resume: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
        return 'accepted';
      };
      // Pi-durable branches by forking, so `/fork` and `/tree` fork the live
      // session into a NEW session (the store fork) and switch the TUI to it;
      // the original keeps the abandoned path. The fork needs the session's
      // lock, so this boot closes FIRST; a failed fork re-attaches the session
      // the operator was in.
      const forkInto = async (at: number, prefill?: string): Promise<void> => {
        const previous = boot;
        const fork = previous.forkAt;
        if (fork === undefined) throw new Error('this session cannot fork');
        const sourceId = previous.sessionId;
        await previous.close?.();
        let forkId: string;
        try {
          forkId = await fork(at);
        } catch (error) {
          await adoptBoot(await deps.bootLane(sourceId, surface.seat, flags));
          throw error;
        }
        await adoptBoot(await deps.bootLane(forkId, surface.seat, flags));
        if (prefill !== undefined) app.editor.setText(prefill);
        app.setEditorFooter(
          `fork: ${forkId} — from ${sourceId} at #${at}${prefill === undefined ? '' : ' (edit the prompt and press enter)'}`,
        );
      };
      const runFork = (at: number, prefill?: string): TuiSubmitOutcome => {
        app.setEditorFooter(`fork: forking at #${at}…`);
        if (!stopped) screen?.render();
        void forkInto(at, prefill)
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `fork: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            if (!stopped) screen?.render();
          });
        return 'accepted';
      };
      // `/tree`: the lane's earlier prompts, each forking just BEFORE itself.
      const openTreePicker = (): TuiSubmitOutcome => {
        const loop = boot.loop;
        if (loop === undefined || boot.forkAt === undefined) {
          app.setEditorFooter('tree: this session cannot fork');
          if (!stopped) screen?.render();
          return 'refused';
        }
        void loop
          .entries(loop.context)
          .then((raw) => {
            if (stopped) return;
            const sorted = [...raw].sort((a, b) => Number(a.id) - Number(b.id));
            const points: ForkPoint[] = [];
            for (let i = 1; i < sorted.length; i += 1) {
              const lane = laneEntryFor(sorted[i] as EntryRecord);
              const text =
                lane === undefined ? undefined : userPromptsOf([lane])[0];
              if (text === undefined) continue;
              points.push({
                entryId: Number(sorted[i]?.id),
                at: Number(sorted[i - 1]?.id),
                text,
              });
            }
            if (points.length === 0) {
              app.setEditorFooter('tree: no earlier prompts to fork from');
              screen?.render();
              return;
            }
            const opened = app.openPicker({
              rows: forkPickerRows(points),
              onSelect: (value) => {
                const [at, entryId] = value.split(':').map(Number);
                const point = points.find((p) => p.entryId === entryId);
                if (at === undefined || point === undefined) return;
                runFork(at, point.text);
              },
              onCancel: () => {
                if (stopped) return;
                app.setEditorFooter('tree: cancelled');
                screen?.render();
              },
            });
            if (!opened) {
              app.setEditorFooter(
                'tree needs a wider terminal — use kubic sessions fork',
              );
            }
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `tree: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
        return 'accepted';
      };
      // `/theme [name]` — the built-ins and the configured theme
      // file, previewed live as the selection moves; ⏎ keeps it for this
      // session (the config is never written), esc restores the one before.
      const configuredTheme =
        deps.theme !== undefined &&
        deps.theme !== '' &&
        !isThemeBuiltin(deps.theme)
          ? deps.theme
          : undefined;
      // `default` is the dark brand palette's other name.
      let activeTheme =
        deps.theme === undefined ||
        deps.theme === '' ||
        deps.theme === 'default'
          ? 'dark'
          : deps.theme;
      const themeChoices = (): string[] => [
        'dark',
        'light',
        'terminal',
        ...(configuredTheme === undefined ? [] : [configuredTheme]),
      ];
      const applyTheme = (name: string): boolean => {
        try {
          setTuiTheme(resolveTuiTheme(name, resolvedTheme.level, files));
        } catch (error) {
          app.setEditorFooter(
            `theme: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (!stopped) screen?.render();
          return false;
        }
        if (!stopped) screen?.render();
        return true;
      };
      const keepTheme = (name: string): void => {
        activeTheme = name;
        app.appendNotice([
          `theme: ${name} for this session — to keep it: [ui] theme = "${name}" in ~/.kubic/config.toml`,
        ]);
        app.setEditorFooter(`theme: ${name}`);
        if (!stopped) screen?.render();
      };
      const openThemePicker = (argument: string): TuiSubmitOutcome => {
        if (argument !== '') {
          if (!themeChoices().includes(argument)) {
            app.setEditorFooter(
              `theme: unknown theme '${argument}' — ${themeChoices().join(', ')}`,
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          if (!applyTheme(argument)) return 'refused';
          keepTheme(argument);
          return 'command';
        }
        const before = activeTheme;
        const opened = app.openPicker({
          title: 'Theme',
          rows: themeChoices().map((name) => ({
            value: name,
            label: name === configuredTheme ? basename(name) : name,
            ...(name === activeTheme ? { current: true } : {}),
            ...(name === configuredTheme
              ? { description: 'from [ui] theme' }
              : {}),
          })),
          onMove: (value) => {
            if (value !== undefined) applyTheme(value);
          },
          onSelect: (value) => {
            if (applyTheme(value)) keepTheme(value);
          },
          onCancel: () => {
            if (stopped) return;
            applyTheme(before);
            app.setEditorFooter(`theme: ${before} (kept)`);
            screen?.render();
          },
        });
        if (!opened) {
          app.setEditorFooter(
            'theme picker needs a wider terminal — use /theme <name>',
          );
          if (!stopped) screen?.render();
        }
        return 'command';
      };
      const runLocalCommand = (
        command: ParsedSlashCommand,
      ): TuiSubmitOutcome => {
        const spec = findSlashCommand(command.name);
        switch (spec?.command) {
          case 'session.attach': {
            if (activeTurn?.isRunning() === true) return busyRefusal('session');
            return command.name === 'resume'
              ? openResumePicker()
              : openNewSession();
          }
          case 'session.fork': {
            if (activeTurn?.isRunning() === true) return busyRefusal('fork');
            if (command.name === 'tree') return openTreePicker();
            const at = /^\d+$/.test(command.argument)
              ? Number(command.argument)
              : undefined;
            if (at === undefined) {
              app.setEditorFooter(
                'usage: /fork <entry> — /tree picks an earlier prompt',
              );
              if (!stopped) screen?.render();
              return 'refused';
            }
            return runFork(at);
          }
          default: {
            break;
          }
        }
        switch (command.name) {
          case 'help': {
            const wanted =
              command.argument === ''
                ? undefined
                : findSlashCommand(command.argument.replace(/^\//, ''));
            if (command.argument !== '' && wanted === undefined) {
              app.setEditorFooter(
                `help: unknown command '${command.argument}' — /help lists the commands`,
              );
              if (!stopped) screen?.render();
              return 'refused';
            }
            const lines =
              wanted === undefined
                ? helpLines()
                : [
                    `${wanted.usage} — ${wanted.summary}${
                      wanted.keys === undefined ? '' : ` (${wanted.keys})`
                    }`,
                  ];
            app.appendNotice(lines);
            app.setEditorFooter(
              wanted === undefined
                ? `help: ${SLASH_COMMANDS.length} commands — the list is in the transcript`
                : `help: ${wanted.usage}`,
            );
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'theme':
            return openThemePicker(command.argument);
          case 'safety': {
            // The honest limits, in full. The wording is the
            // limits module's (never re-worded here), and an explicit ask is
            // answered even where the startup notice is suppressed.
            app.appendNotice(
              noIsolationNoticeLines().map((line) => line.replace(/^warning: /, '')),
            );
            app.setEditorFooter('safety: the limits are in the transcript');
            if (!stopped) screen?.render();
            // A local read with its own output: no prompt echo under it.
            return 'command';
          }
          case 'session': {
            const report = app.sessionReport(boot.cwd);
            app.appendNotice([report]);
            app.setEditorFooter(report);
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'scoped-models': {
            // The role's resolved allowed set: a
            // local read like `/session` — the loop reports, nothing is
            // sent, and a bare inspection never mutates the transcript
            // beyond the report row.
            const report = formatScopedModels(
              boot.scopedModels?.role,
              boot.scopedModels?.models,
            );
            app.appendNotice([report]);
            app.setEditorFooter(report);
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'approvals': {
            const argument = command.argument.trim().toLowerCase();
            if (argument === '') {
              app.setEditorFooter(
                fullAccessLive()
                  ? 'approvals: full access ON for this session'
                  : 'approvals: enforced — challenged calls ask',
              );
              if (!stopped) screen?.render();
              return 'accepted';
            }
            // The argument names a DIRECTION,
            // so it never flips the other way. `on` in a session that is
            // already on is a report (it must not toggle off, and it must
            // not open a dialog that would); `off` in a session that is
            // already off is a report too — never a second no-op row for a
            // change that did not happen. Only `Alt+A` toggles.
            if (argument === 'on') {
              if (fullAccessLive()) {
                app.setEditorFooter(
                  'approvals: full access already ON for this session',
                );
                if (!stopped) screen?.render();
                return 'accepted';
              }
              return openFullAccessConfirm();
            }
            if (argument === 'off') {
              if (!fullAccessLive()) {
                app.setEditorFooter('approvals: enforced — nothing to change');
                if (!stopped) screen?.render();
                return 'accepted';
              }
              return applyFullAccess(false);
            }
            app.setEditorFooter(
              `approvals: expected 'on' or 'off' (got '${command.argument}')`,
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          case 'diff': {
            app.openPanel('diff');
            app.setEditorFooter('diff: panel open (Ctrl-O closes)');
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'undo': {
            if (activeTurn?.isRunning() === true) return busyRefusal('undo');
            const store = boot.journal;
            const root = boot.cwd;
            if (store === undefined || root === undefined) {
              app.setEditorFooter('undo: this session has no journal to undo');
              if (!stopped) screen?.render();
              return 'refused';
            }
            const plan = planUndo(store, {}, root);
            if (plan.steps.length === 0) {
              app.setEditorFooter('undo: nothing to undo');
              if (!stopped) screen?.render();
              return 'accepted';
            }
            const result = applyUndo(store, plan, root, {});
            const summary = `undo: ${result.restored.length} restored, ${result.skipped.length} skipped`;
            app.appendNotice([
              summary,
              ...result.warnings.map((warning) => `warn: ${warning}`),
            ]);
            app.setEditorFooter(summary);
            journalFeed?.now();
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'quit': {
            shutdown();
            return 'accepted';
          }
          case 'image': {
            // `/image <path>` attaches one image to the
            // next prompt. The registry owns discovery (palette,
            // autocomplete, `/help`); the read and the validation are the
            // composition root's, and a bare `/image` is the usage error.
            const parsed = parseImageCommand(
              command.argument === '' ? '/image' : `/image ${command.argument}`,
            );
            if (parsed === undefined || parsed.kind === 'invalid') {
              app.setEditorFooter(
                parsed === undefined ? IMAGE_COMMAND_USAGE : parsed.message,
              );
              if (!stopped) screen?.render();
              return 'refused';
            }
            void attachFromPath(parsed.path);
            return 'command';
          }
          default: {
            app.setEditorFooter(
              `'/${command.name}': not implemented in this session`,
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
        }
      };

      // One switch path for `/model <id>` and the picker's
      // Enter — the same footer wording and the same refusal text.
      // Adds the reason: `/escalate <id> [reason]` records it
      // in the escalation event; `/model` passes none (a silent climb).
      // `thinking` is the level the model picker chose with the
      // model; it is set once the switch (which re-clamps the old one) lands.
      const switchModelTo = (
        selection: ModelSelection,
        reason?: string,
        thinking?: ModelThinkingLevel,
      ): void => {
        if (turn === undefined) {
          app.setEditorFooter('model switch needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        app.setEditorFooter(
          `switching model to ${selection.provider}/${selection.id}…`,
        );
        if (!stopped) screen?.render();
        void turn
          .switchModel(selection, reason)
          .then(async (label) => {
            if (stopped) return;
            // The climb just recorded reports its
            // transcript row now — not on the next settled turn. The
            // drain is idempotent, so the turn drain later finds nothing.
            for (const row of boot.loop?.drainEscalationRows?.() ?? []) {
              app.appendNotice([row]);
            }
            // The new model may not accept images. The
            // attachments were validated against the OLD model, so they are
            // dropped rather than sent to a model that cannot take them.
            if (pendingImages.length > 0) {
              const loop = boot.loop;
              const supported = await loop?.supportsImages?.(loop.context);
              if (stopped) return;
              if (supported !== true) {
                const dropped = pendingImages.length;
                pendingImages = [];
                app.setPendingImages([]);
                app.setPendingAttachments(0);
                app.setEditorFooter(
                  `model: ${label} (switched) · dropped ${dropped} attached image${dropped === 1 ? '' : 's'} — ${label} does not accept image input`,
                );
                screen?.render();
                return;
              }
            }
            app.setEditorFooter(`model: ${label} (switched)`);
            screen?.render();
            if (thinking !== undefined) {
              handleThinkingCommand({ kind: 'switch', level: thinking });
            }
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `model switch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };

      // `/thinking <level>` — report, switch (clamped by the lane
      // to what the live model supports) or refuse an unknown level by name.
      const handleThinkingCommand = (command: TuiThinkingCommand): void => {
        if (turn === undefined) {
          app.setEditorFooter('thinking needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        // A bare `/thinking` picks from the levels the live
        // model supports (Alt+T keeps cycling them).
        if (command.kind === 'pick') {
          const runner = turn;
          void Promise.all([runner.supportedThinking(), runner.liveThinking()])
            .then(([levels, live]) => {
              if (stopped) return;
              const opened = app.openPicker({
                title: 'Thinking',
                rows: levels.map((level) => ({
                  value: level,
                  label: level,
                  ...(level === live ? { current: true } : {}),
                })),
                onSelect: (value) => {
                  if (value !== live && isThinkingLevel(value)) {
                    handleThinkingCommand({ kind: 'switch', level: value });
                  } else {
                    app.setEditorFooter(`thinking: ${live}`);
                    screen?.render();
                  }
                },
                onCancel: () => {
                  if (stopped) return;
                  app.setEditorFooter(`thinking: ${live} (picker cancelled)`);
                  screen?.render();
                },
              });
              if (!opened) app.setEditorFooter(`thinking: ${live}`);
              screen?.render();
            })
            .catch((error: unknown) => {
              if (stopped) return;
              app.setEditorFooter(
                `thinking: ${error instanceof Error ? error.message : String(error)}`,
              );
              screen?.render();
            });
          return;
        }
        if (command.kind === 'invalid') {
          app.setEditorFooter(`thinking: ${command.message}`);
          if (!stopped) screen?.render();
          return;
        }
        const requested = command.level;
        void turn
          .switchThinking(requested)
          .then((effective) => {
            if (stopped) return;
            app.setEditorFooter(
              effective === requested
                ? `thinking: ${effective}`
                : `thinking: ${effective} (clamped from ${requested})`,
            );
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `thinking switch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };

      // Alt+T cycles the level over what the live model supports
      // (thinking.cycle), committing each step through the same path.
      const cycleThinking = (): void => {
        if (stopped) return;
        if (activeTurn?.isRunning() === true) {
          app.setEditorFooter(
            'thinking: finish the current turn before switching',
          );
          screen?.render();
          return;
        }
        if (turn === undefined) {
          app.setEditorFooter('thinking needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        void (async () => {
          const [current, levels] = await Promise.all([
            turn.liveThinking(),
            turn.supportedThinking(),
          ]);
          if (levels.length === 0) {
            app.setEditorFooter('thinking: this model has no thinking levels');
            if (!stopped) screen?.render();
            return;
          }
          const at = levels.indexOf(current);
          const next = levels[(at + 1) % levels.length] ?? levels[0];
          const effective = await turn.switchThinking(next);
          if (stopped) return;
          app.setEditorFooter(`thinking: ${effective}`);
          screen?.render();
        })().catch((error: unknown) => {
          if (stopped) return;
          app.setEditorFooter(
            `thinking switch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          screen?.render();
        });
      };

      // Alt+M opens the picker over the usable catalog rows. The
      // overlay owns the modal input; a pick goes through `switchModelTo`.
      const openModelPicker = (): void => {
        if (stopped) return;
        if (activeTurn?.isRunning() === true) {
          app.setEditorFooter(
            'model: finish the current turn before switching',
          );
          screen?.render();
          return;
        }
        if (turn === undefined) {
          app.setEditorFooter('model switch needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        // Captured: the callbacks below run after a `/new` may have replaced
        // the runner, and they must report the one this picker came from.
        const runner = turn;
        void Promise.all([
          runner.listModels(),
          runner.listProviders(),
          runner.liveThinking().catch(() => undefined),
        ])
          .then(([rows, providers, thinking]) => {
            if (stopped) return;
            const opened = app.openModelPicker({
              rows: rows.map((row) => ({
                provider: row.provider,
                id: row.id,
                label: `${row.provider}/${row.id}`,
                current: row.current,
                ...(row.note === undefined ? {} : { note: row.note }),
                ...(row.contextWindow === undefined
                  ? {}
                  : { contextWindow: row.contextWindow }),
                ...(row.reasoning === undefined
                  ? {}
                  : { reasoning: row.reasoning }),
                ...(row.thinking === undefined
                  ? {}
                  : { thinking: row.thinking }),
              })),
              providers,
              ...(thinking === undefined ? {} : { thinking }),
              // Model and thinking level are one decision —
              // the level follows the switch (which re-clamps it), and is
              // set only when the operator moved it.
              onSelect: (row, level) => {
                const moved =
                  level !== undefined &&
                  level !== thinking &&
                  isThinkingLevel(level);
                if (row.current === true) {
                  if (moved) handleThinkingCommand({ kind: 'switch', level });
                  else app.setEditorFooter(`model: ${runner.modelRef}`);
                  if (!stopped) screen?.render();
                  return;
                }
                switchModelTo(
                  { provider: row.provider, id: row.id },
                  undefined,
                  moved ? level : undefined,
                );
              },
              onCancel: () => {
                if (stopped) return;
                app.setEditorFooter(
                  `model: ${runner.modelRef} (picker cancelled)`,
                );
                screen?.render();
              },
            });
            if (!opened) {
              app.setEditorFooter(
                'model picker unavailable on this terminal — use /model <provider/id>',
              );
            }
            if (!stopped) screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `model picker failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };
      pickModelForLoop = openModelPicker;
      cycleThinkingForLoop = cycleThinking;

      // Ctrl-P's grouped palette. The app owns the
      // command and file rows; this boot supplies the model catalog and this
      // project's other sessions, and the actions behind them: a command row
      // is submitted exactly as if typed (the dispatcher above owns the
      // rest), a model row switches like the picker, a session row resumes
      // like `/resume`.
      const openPalette = (): void => {
        if (stopped) return;
        const runner = turn;
        const list = boot.listSessions;
        const opened = app.openPalette({
          runCommand: (command) => {
            submitForLoop?.(command, false);
          },
          ...(runner === undefined
            ? {}
            : {
                models: async () => runner.listModels(),
                switchModel: (provider: string, id: string) => {
                  if (activeTurn?.isRunning() === true) {
                    app.setEditorFooter(
                      'model: finish the current turn before switching',
                    );
                    if (!stopped) screen?.render();
                    return;
                  }
                  switchModelTo({ provider, id });
                },
              }),
          ...(boot.summarizeSessions !== undefined
            ? {
                // The summaries `/resume` lists (titled, this
                // project only); a held session cannot resume.
                sessions: async () =>
                  ((await boot.summarizeSessions?.(boot.sessionId)) ?? [])
                    .filter((summary) => summary.state === 'ready')
                    .map((summary) => ({
                      id: summary.id,
                      ...(summary.title === undefined
                        ? {}
                        : { title: summary.title }),
                      ...(summary.createdAt === undefined
                        ? {}
                        : { createdAt: summary.createdAt }),
                      ...(summary.turns === undefined
                        ? {}
                        : { turns: summary.turns }),
                    })),
                resumeSession,
              }
            : list === undefined
              ? {}
              : {
                  sessions: async () =>
                    (await list()).filter(
                      (row) =>
                        row.id !== boot.sessionId &&
                        (boot.cwd === undefined ||
                          row.cwd === undefined ||
                          row.cwd === boot.cwd),
                    ),
                  resumeSession,
                }),
          onCancel: () => {
            if (stopped) return;
            app.setEditorFooter('palette: cancelled');
            screen?.render();
          },
        });
        if (!opened) {
          app.setEditorFooter('palette needs a wider terminal — type /help');
        }
        if (!stopped) screen?.render();
      };
      paletteForLoop = openPalette;

      // The in-session full-access toggle. The host
      // path writes posture.json + one audit row and flips the INSTALLED
      // policy's live posture, so the next challenged call follows; the
      // indicator is re-read from the same predicate in this frame.
      const applyFullAccess = (enabled: boolean): TuiSubmitOutcome => {
        const setFullAccess = boot.setFullAccess;
        if (setFullAccess === undefined) {
          app.setEditorFooter(
            'approvals: this session cannot change its posture',
          );
          if (!stopped) screen?.render();
          return 'refused';
        }
        try {
          const grant = setFullAccess(enabled);
          syncPosture();
          app.appendNotice([grant.warning]);
          app.setEditorFooter(
            enabled
              ? 'approvals: full access ON for this session — every challenged call runs without asking'
              : 'approvals: enforced again — the next challenged call asks',
          );
        } catch (error) {
          app.setEditorFooter(
            `approvals: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!stopped) screen?.render();
        return 'accepted';
      };
      // Enabling asks first (the dialog names the consequence); disabling is
      // immediate. The dialog accepts only its deliberate key.
      //
      // The confirmation is a modal of its
      // own and `Alt+A` is a GLOBAL key, so it would otherwise open OVER a
      // pending approval — where its advertised Ctrl-S is swallowed by the
      // approval surface and Esc/Ctrl-C DENY the challenged call instead of
      // cancelling the dialog. One modal at a time: while an approval owns
      // the keys the confirmation refuses by name.
      const openFullAccessConfirm = (): TuiSubmitOutcome => {
        if (stopped) return 'refused';
        if (app.hasPendingApproval()) {
          app.setEditorFooter('approvals: answer the pending request first');
          if (!stopped) screen?.render();
          return 'refused';
        }
        const opened = app.openConfirm({
          title: 'enable full access for this session?',
          body: [
            'every challenged call in this session will run without asking',
            'the change is written to posture.json and one audit row',
          ],
          confirmKey: 'ctrl+s',
          confirmLabel: 'Ctrl-S',
          onConfirm: () => {
            applyFullAccess(true);
          },
          onCancel: () => {
            if (stopped) return;
            app.setEditorFooter('approvals: unchanged');
            screen?.render();
          },
        });
        if (!opened) {
          app.setEditorFooter(
            'approvals: the confirmation needs the overlay — this terminal is too narrow',
          );
          if (!stopped) screen?.render();
          return 'refused';
        }
        if (!stopped) screen?.render();
        return 'accepted';
      };
      // The LIVE posture, read from the same
      // predicate the status bar uses, so a direction can be checked against
      // what is actually in force.
      const fullAccessLive = (): boolean =>
        boot.approvalsSkipped?.() ?? boot.fullAccess === true;
      // `Alt+A` is the TOGGLE: an already-on session flips off through it.
      const toggleFullAccess = (): TuiSubmitOutcome =>
        fullAccessLive() ? applyFullAccess(false) : openFullAccessConfirm();
      fullAccessForLoop = () => {
        toggleFullAccess();
      };

      // One accepted prompt → one turn on its driver. A busy
      // Enter starts a SECOND run while the first is still in flight (the
      // harness queues it), so the busy latch counts turns instead of
      // holding one: the spinner and the editor stay in flight until the
      // last settles.
      let inFlightTurns = 0;
      // The busy latch follows PLACED work, not
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
        // The receipt counts this turn from its submission.
        const startedAt = Date.now();
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
            // spinner, a queued item releases it.
            onSubmitted: (submissionId, admitted) => {
              options?.onSubmitted?.(submissionId, admitted);
              syncBusy();
            },
          })
          .then((outcome) => {
            syncPosture();
            // A bash-made change is journaled only by the sweep;
            // run it BEFORE the panel read so this turn's shell effects are
            // on screen at settlement, not just at quit. A quit in progress
            // owns its own final sweep (close), and a failed sweep leaves
            // the panels on the rows they have.
            if (!stopped) {
              sweepPendingShell();
              // Between turns the workspace is the operator's —
              // unless a queued follow-up is already running, whose changes
              // the next sweep still owes.
              if (turn?.isRunning() !== true) {
                reconcileTurnOpen = false;
                rebaseline();
              }
            }
            journalFeed?.now();
            // The state word follows the outcome; a completed
            // turn clears the notice row (the trust statement lives in the
            // welcome block and behind `/safety`), a cancelled or failed one
            // keeps its own report there.
            app.setTurnOutcome(outcome.status, {
              startedAt,
              ...(outcome.detail === undefined
                ? {}
                : { detail: outcome.detail }),
            });
            footer = footerForOutcome(outcome);
            if (outcome.status === 'cancelled' && droppedOnCancel > 0) {
              footer = `${footer} · dropped ${droppedOnCancel} queued prompt${droppedOnCancel === 1 ? '' : 's'}`;
            }
            // A driver with its own settlement line (the compaction's
            // `compacted: …`) reports it instead of a turn outcome.
            footer = driver.settlementFooter?.() ?? footer;
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            app.setTurnOutcome('failed', { startedAt, detail: message });
            footer = `error: ${message}`;
          })
          .finally(() => {
            inFlightTurns -= 1;
            if (inFlightTurns === 0) {
              droppedOnCancel = 0;
              if (activeTurn === driver) activeTurn = undefined;
              // The turn is over — so is its edit batch.
              boot.endApprovalTurn?.();
            }
            // Sync BEFORE the footer: `setBusy(false)` clears the footer row.
            syncBusy();
            if (footer !== undefined && !stopped) app.setEditorFooter(footer);
            // The turn may have changed files or the branch.
            if (inFlightTurns === 0) refreshWorkspace();
            if (!stopped) screen?.render();
          });
      };

      // The one submit path — Enter, and Alt+Enter when idle.
      // `steer` marks the Alt+Enter form, which becomes a harness steer
      // while a turn runs instead of a queued follow-up.
      const submitPrompt = (
        prompt: string,
        steer: boolean,
      ): TuiSubmitOutcome => {
        if (stopped) return 'refused';
        const busy = activeTurn?.isRunning() === true;
        // The command attaches one image to
        // the next prompt. Nothing is echoed and nothing is restored on
        // success — the draft was a command, and the footer names the
        // attachment; a usage error hands the draft back.
        // `/compact [instructions]` is a lane operation, never a
        // prompt. It runs through the same busy/cancel wrapper as a turn, so
        // the spinner shows and Ctrl-C aborts it; the command text itself
        // never reaches the model or the transcript.
        // `/skill:<name> [instructions]` expands to
        // the skill content plus instructions and submits AS the prompt —
        // the mode, busy and attachment rules below apply unchanged. An
        // unknown name refuses locally by name (withheld skills resolve
        // unknown too, so the refusal never leaks their existence) and
        // never reaches the model.
        const skillCommand = parseSkillInvokeCommand(prompt);
        if (skillCommand !== undefined) {
          if (skillCommand.kind === 'invalid') {
            app.setEditorFooter(SKILL_COMMAND_USAGE);
            if (!stopped) screen?.render();
            return 'refused';
          }
          const invocation = boot.skillInvocation;
          if (invocation === undefined) {
            app.setEditorFooter(
              'skill: explicit invocation is unavailable in this session',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          try {
            prompt = invocation.invoke(
              skillCommand.name,
              skillCommand.instructions,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            app.setEditorFooter(`skill: ${message}`);
            if (!stopped) screen?.render();
            return 'refused';
          }
        }
        // A slash command is never a prompt. An unknown one is
        // refused locally — it must not reach the model — and the registry's
        // own commands dispatch below. An expanded skill is
        // already a prompt, never a command — parsing it again would let a
        // skill body starting with `/` hijack the submit.
        const slashCommand =
          skillCommand !== undefined ? undefined : parseSlashCommand(prompt);
        if (
          slashCommand !== undefined &&
          !SLASH_COMMAND_NAMES.has(slashCommand.name)
        ) {
          app.setEditorFooter(
            `unknown command '/${slashCommand.name}' — /help lists the commands`,
          );
          if (!stopped) screen?.render();
          return 'refused';
        }
        const compactCommand =
          skillCommand !== undefined
            ? undefined
            : parseTuiCompactCommand(prompt);
        if (compactCommand !== undefined) {
          const lane = boot.loop;
          if (busy) {
            app.setEditorFooter(
              'compact: finish the current turn before compacting',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          if (lane?.compact === undefined) {
            app.setEditorFooter('compaction needs a live lane');
            if (!stopped) screen?.render();
            return 'refused';
          }
          startTurn(
            new TuiCompactionTurn(lane, compactCommand.focus, async () => {
              // The compaction entry is committed by the task, not
              // by a turn's event stream, so the transcript is re-read once
              // the task settles — the compaction cell then appears in the
              // same session (and in the quit's printed document).
              await turn?.refreshTranscript();
            }),
            prompt,
          );
          return 'accepted';
        }
        // `/thinking <level>` — same busy rule as `/model`: a
        // live switch never races a run. Skipped for an expanded
        // skill (a prompt, never a command).
        const thinkingCommand =
          skillCommand !== undefined ? undefined : parseThinkingCommand(prompt);
        if (thinkingCommand !== undefined) {
          if (busy) {
            app.setEditorFooter(
              'thinking: finish the current turn before switching',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          handleThinkingCommand(thinkingCommand);
          return 'accepted';
        }
        // Skipped for an expanded skill (a prompt, never a
        // command).
        const modelCommand =
          skillCommand !== undefined ? undefined : parseModelCommand(prompt);
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
        // `/escalate <ref> [reason]` climbs the same
        // ladder as `/model` — the busy guard matches, since the climb is
        // a conversation.configure too.
        const escalateCommand = parseEscalateCommand(prompt);
        if (escalateCommand !== undefined) {
          if (busy) {
            app.setEditorFooter(
              'escalation: finish the current turn before climbing',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          handleEscalateCommand(escalateCommand);
          return 'accepted';
        }
        // A session booted without a lane refuses by name instead of
        // pretending the prompt ran.
        const driver = turn;
        if (driver === undefined) {
          app.setEditorFooter('error: the lane is unavailable in this session');
          if (!stopped) screen?.render();
          return 'refused';
        }
        // The remaining registry commands answer locally.
        if (slashCommand !== undefined) {
          return runLocalCommand(slashCommand);
        }
        const sentImages = pendingImages;
        const imageOptions: TuiTurnOptions =
          sentImages.length === 0 ? {} : { images: sentImages };
        const imagesSent = (): void => {
          pendingImages = [];
          // The app keeps the sent images on the echo until the lane's own
          // prompt cell replaces it; the composer itself is empty again.
          app.setPendingImages(sentImages);
          // ... but nothing is armed any more: a blank Enter between this
          // submit and the echo's replacement is a no-op again.
          app.setPendingAttachments(0);
        };
        if (busy) {
          // The lane queues the prompt in the conversation's OWN
          // inbox — a follow-up (placed when the run answers) for Enter, a
          // steer (placed after the current tool round, joining the running
          // work) for Alt+Enter.
          startTurn(
            driver,
            prompt,
            steer
              ? { whenBusy: 'steer', ...imageOptions }
              : {
                  whenBusy: 'followUp',
                  onSubmitted: (id) => {
                    // The rows follow from the state: the id's text is what
                    // the projector resolves against this map.
                    queuedText.set(id, prompt);
                    // The images of a queued draft are remembered
                    // per submission id, so the echo that replaces the row
                    // carries them too.
                    if (sentImages.length > 0) queuedImages.set(id, sentImages);
                    turn?.refreshPresentation();
                  },
                  ...imageOptions,
                },
          );
          imagesSent();
          return 'queued';
        }
        startTurn(driver, prompt, imageOptions);
        imagesSent();
        return 'accepted';
      };

      app.onSubmit((prompt: string) => submitPrompt(prompt, false));
      // The steer key's own entry point (the key router is defined above).
      submitForLoop = submitPrompt;
      await turn?.refreshTranscript();
      // The boot's warnings (an unresolvable --skill) land after the first
      // read: a transcript snapshot replaces the notice cells.
      for (const line of boot.loop?.drainNotices?.() ?? []) {
        app.appendNotice([line]);
      }
      if (!stopped) screen?.render();
    }
  } catch (error) {
    // Post-start setup (boot/setFocus/render/input routing) can throw
    // after the alt-screen went active — restore the main screen and
    // close the lane so the reject never strands either. The setup
    // error stands.
    stopClock();
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
  return { exitCode };
}

// A path under the home directory, written `~/…`.
function tildePath(path: string, home: string = homedir()): string {
  if (home === '' || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
