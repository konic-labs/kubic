// The contracts of `kubic tui`: the boot the loop drives, the lane surface,
// the command deps and options, and the turn driver shape.
import type {
  ManualCompactionOptions,
  ManualCompactionOutcome,
} from '@kubic/agent/compaction';
import type { OperationKillRegistry } from '@kubic/agent/lane/abort';
import type { LaneCompactionOptions } from '@kubic/agent/lane/boot';
import type { LaneEventSink } from '@kubic/agent/lane/events';
import type { TurnOutcome } from '@kubic/agent/lane/turn';
import type { ModelSelection } from '@kubic/agent/model-select';
import type { PermissionClasses } from '@kubic/agent/permissions';
import type {
  Context,
  EntryRecord,
  ModelThinkingLevel,
  MutableModels,
} from '@kubic/agent/pi-boundary';
import type { StreamTuningTables } from '@kubic/agent/stream-options';
import type { LaneImagePart } from '@kubic/core/presentation';
import type { NodeExecutionEnv } from '@kubic/exec/env';
import type { FileJournalStore, JournalRetention } from '@kubic/exec/journal';
import type {
  ApprovalConfig,
  ApprovalRequest,
  ApprovalVerdict,
  InstalledPolicy,
  SessionFullAccessGrant,
} from '@kubic/host/approvals';
import type {
  RoleModelEntry,
  RuntimeEscalation,
  RuntimeThinking,
} from '@kubic/host/config';
import type { EffectivePolicy } from '@kubic/host/policy';
import type { RoleLayerInput } from '@kubic/host/roles';
import type { DebugSink, TurnSpansSink } from '@kubic/host/run';
import type { SessionSummary } from '@kubic/host/sessions';
import type { StatusUsageRow } from '@kubic/tui/status-bar';
import type { ColorLevel } from '@kubic/tui/theme';
import type { TuiWorkspace } from '@kubic/tui/tui-app';
import type { Terminal } from '@kubic/tui/tui-boundary';

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
export interface TuiTurnRecord {
  prompt: string;
  startedAt: number;
  outcome: TuiTurnOutcome;
  turn?: TurnOutcome;
}

// A turn's own options. The lane queues a busy follow-up
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
export interface TuiTurnDriver {
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

// A model's context window and the token level at which the
// lane compacts (window − reserve, the same policy the harness reads).
// `undefined` means the catalog does not know the window: the gauge then
// stays off rather than showing a made-up percentage. will make the
// reserve configurable; until then this is Kubic's default.
export interface ContextLimits {
  contextWindow?: number;
  compactionThreshold?: number;
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
  // NO_ANSWER_SURFACE_REASON). The prod boot forwards it to installPolicy;
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

export type TuiSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
type TuiProcessEvent = TuiSignal | 'uncaughtException' | 'unhandledRejection';

export interface TuiProcessEvents {
  on(event: TuiProcessEvent, listener: (value: unknown) => void): unknown;
  off(event: TuiProcessEvent, listener: (value: unknown) => void): unknown;
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
  // does. Absent means the documented DEFAULT_PERMISSIONS.
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

export interface TuiTurnOutcome {
  readonly status: 'completed' | 'cancelled' | 'failed';
  readonly detail?: string;
}

// The parsed `kubic tui` invocation (commander owns the argv:
// ./commands/session.ts). The parity flags carry the same names
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
