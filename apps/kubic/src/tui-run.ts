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
// Cancellation (§18, issue #88): Ctrl-C during a turn aborts the in-flight
// operation through the lane's own requestAbort (the durable, kill-draining
// path) and keeps the session alive; a second Ctrl-C quits. While idle the
// first Ctrl-C quits. Esc and Ctrl-D-on-an-empty-draft quit too, so no
// honoured key is a silent no-op.

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
  buildOrchestratorRefusal,
  resolveOrchestratorMode,
} from '../../../packages/host/src/orchestrator/manager.js';
import type { ApprovalSnapshot } from '../../../packages/host/src/orchestrator/merge/conflicts.js';
import type { RoleLayerInput } from '../../../packages/host/src/roles/resolver.js';
import {
  roleDocPath,
  rolePromptFor,
  selectRole,
} from '../../../packages/host/src/roles/roles-boot.js';
import {
  mapCaughtErrorToTerminus,
  mapLaneOutcomeToTerminus,
  RUN_EXIT_FAILED,
  RUN_EXIT_OK,
  RUN_EXIT_PROVIDER_PROBE_FAILED,
  RUN_EXIT_USAGE,
  RUN_EXIT_WORKSPACE_UNAVAILABLE,
  SESSION_ID_PATTERN,
} from '../../../packages/host/src/run-cli.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import { bootSkills } from '../../../packages/host/src/skills-boot.js';
import type { RunOutcome } from '../../../packages/host/src/trajectory/run-trajectory.js';
import { createApprovalSurface } from '../../../packages/tui/src/approval-surface.js';
import type { LaneEntryLike } from '../../../packages/tui/src/lane-cells.js';
import type { Screen } from '../../../packages/tui/src/screen.js';
import { bootScreen } from '../../../packages/tui/src/screen.js';
import type { StatusMode } from '../../../packages/tui/src/status-bar.js';
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
} from '../../../packages/tui/src/tui-app.js';
import type { Terminal } from '../../../packages/tui/src/tui-boundary.js';
import {
  isKeyRelease,
  ProcessTerminal,
  parseKey,
} from '../../../packages/tui/src/tui-boundary.js';
import {
  drainOperation,
  type LaneAborter,
  type OperationKillRegistry,
  requestLaneAbort,
} from '../../../packages/worker/src/lane/abort.js';
import type {
  EventSource,
  KubicLaneEvent,
  LaneEventSink,
} from '../../../packages/worker/src/lane/events.js';
import { attachLaneEvents } from '../../../packages/worker/src/lane/events.js';
import {
  describeSettlement,
  settlePendingOperation,
} from '../../../packages/worker/src/lane/pending.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import type { OperationErrorLike } from '../../../packages/worker/src/lane/settle.js';
import {
  bootSoloLane,
  driveToSettled,
  type LaneDriver,
} from '../../../packages/worker/src/lane/solo.js';
import {
  ModelSelectError,
  type ModelSelection,
  selectModel,
} from '../../../packages/worker/src/model-select.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  type MutableModels,
  type OperationAdmissionResult,
  type TerminalStatus,
} from '../../../packages/worker/src/pi-boundary.js';
import type { runtimeLaneDeps } from './config-runtime.js';
import {
  assistantSummary,
  NO_ASSISTANT_TEXT_SUMMARY,
  roleModelSelection,
} from './headless-run.js';
import { persistRunTrajectory } from './run-trajectory.js';
import {
  createProdTuiOrchestrator,
  workerAskSeatFromAnswer,
} from './tui-orchestrator.js';

// The interaction surface the root shares with the app (issue #96): the seat
// the installed policy consults and the surface the loop renders are the SAME
// object, so a verdict collected on screen is the verdict the lane receives.
export type TuiApprovalSeat = (
  request: ApprovalRequest,
) => Promise<ApprovalVerdict | undefined>;
// The lane surface the loop drives. Narrow on purpose: the loop accepts a
// prompt, drives to settlement, can abort, and reads committed entries to
// refresh the transcript — nothing else. Every member is a real lane
// method (or the lane itself), so the prod wiring is a straight passthrough.
export interface TuiLaneLoop {
  accept(prompt: string, context: Context): Promise<OperationAdmissionResult>;
  lane: LaneDriver;
  requestAbort: LaneAborter['requestAbort'];
  findEntries(
    query: undefined,
    context: Context,
  ): Promise<ReadonlyArray<LaneEntryLike>>;
  events: EventSource['events'];
  kills: OperationKillRegistry;
  context: Context;
  // §46 trajectory per settled turn (issue #383): the prod boot persists
  // <sessions-root>/<id>/trajectory.json here. Absent (injected test loops)
  // means no trajectory; a failure never changes the turn's outcome.
  recordTurn?: (turn: TuiTurnRecord) => Promise<void> | void;
}

// One settled turn as the runner saw it: the prompt, when it started, the
// footer outcome, and the lane's own terminal record when it settled (or
// 'deferred' when the lane suspended the operation).
export interface TuiTurnRecord {
  prompt: string;
  startedAt: number;
  outcome: TuiTurnOutcome;
  lane?: { status: TerminalStatus; error?: OperationErrorLike } | 'deferred';
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
  run(prompt: string): Promise<TuiTurnOutcome>;
  cancel(): Promise<boolean>;
  drainForQuit(bound: Promise<void>): Promise<void>;
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

  run(prompt: string): Promise<TuiTurnOutcome> {
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
    await this.drive.abort?.();
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
    answer?: (request: ApprovalRequest) => Promise<ApprovalVerdict | undefined>,
    // Issue #113: the parsed parity flags travel with the boot call —
    // the command shell owns parsing, the boot owner owns the defaults.
    options?: TuiBootFlags,
  ) => Promise<TuiLaneBoot>;
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
  // Issue #295: `--model <provider/id>` — the explicit pin, above config.
  model?: ModelSelection;
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
  answer?: (request: ApprovalRequest) => Promise<ApprovalVerdict | undefined>;
  // Issue #113 (TUI parity with `kubic run`): skills discovery, `--role`
  // documents, and journal retention reach the interactive lane exactly
  // as they reach the headless one — same options, same semantics.
  skills?: { homeDir?: string; cwd?: string; trusted?: boolean };
  noSkills?: boolean;
  skillsList?: string[];
  role?: string;
  roles?: { cwd?: string; layers?: RoleLayerInput[] };
  journalRetention?: JournalRetention;
  // §35 out-of-scope paths (issue #115): the same projection `kubic run`
  // threads, so a declared directory is excluded from this lane's §42.5
  // baseline and sweep too. Absent means the mechanism's own skips only.
  reconcileOutOfScope?: string[];
  // The lane's agent id (issue #133): the configured `[agent].name`, from
  // the SAME runtimeLaneDeps projection `kubic run` consumes. Absent means
  // 'root' — the shipped attribution, unchanged.
  agentId?: string;
  // §41.4 (issue #308): enable full access for the booted session through
  // the one host enable path before the policy is installed.
  dangerouslySkipApprovals?: boolean;
  // Issue #295 (§38.1): the explicit model pin — `--model`, else the
  // `[model]`/KUBIC_MODEL projection runtimeModelPin makes for `kubic run`.
  // It beats the role layer's model, which beats first-available.
  model?: ModelSelection;
  // Issue #327: the config `[orchestrator]` projection (worktree parent and
  // worker cap) the interactive drive hands the manager lane, and the
  // approval snapshot a delegated conflict resolver runs under.
  orchestratorRuntime?: RuntimeOrchestrator;
  approvalPolicy?: ApprovalSnapshot;
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
      ? await createSession(store, process.cwd(), context)
      : await attachSession(store, sessionId, context);
  const id = session.metadata.id;
  // §42.5 baseline + end-of-run sweep (issue #87): the TUI's run end is its
  // close — quit, SIGINT, EOF — so the sweep rides that `close`. There is no
  // closed-latch: idempotence comes from `reconcile`'s per-path after-hash
  // comparison, so a second close on an unchanged tree appends nothing, while
  // a mutation landing between two closes IS appended (pinned by the exec
  // suite). Assigned inside the try below.
  let reconciliation: RunReconciliation | undefined;
  // Issue #325: the installed policy's end-of-session posture check.
  let settlePolicy: (() => void) | undefined;
  const close = async (): Promise<void> => {
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
      await session.close(context);
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
    // Issue #295 (§38.1): the same precedence as `kubic run` — the explicit
    // pin (`--model`, `[model]`, KUBIC_MODEL), then the role layer's model,
    // then first-available. The faux testing provider (`KUBIC_PROVIDER=faux`)
    // is pinned, never picked implicitly; the footer names it
    // (runTuiCommand). A ModelSelectError propagates to runTuiCommand, which
    // reports it as exit 6 before the alt-screen opens.

    const model = selectModel(
      models,
      fauxPinned
        ? { provider: FAUX_PROVIDER_ID, id: FAUX_MODEL_ID }
        : options.model,
      roleModelSelection(selectedRole?.resolved.model),
      assembled?.fallbackProviders,
    );
    const modelRef = `${model.provider}/${model.id}`;
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
        model: modelRef,

        // The answer seat (issue #96): with the overlay's surface attached,
        // `kubic tui` is the command that can actually collect a verdict on a
        // challenged call instead of refusing it unseen. Injected policies
        // (tests, and any caller that supplies its own) keep their own seat.
        ...(options.answer === undefined ? {} : { answer: options.answer }),
      });
    // Issue #148 (§26.1): the same rule as `kubic run` — a pin (the faux
    // pin is the TUI's only one) switches a resumed session whose stored
    // model differs; the default pick keeps the session's own model.
    const modelNotices: string[] = [];
    const solo = await bootSoloLane({
      session,
      models,
      model,
      modelPolicy: fauxPinned ? 'selected' : 'stored',
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
        const skills = bootSkills({
          bridge: createNodeFileBridge(options.skills?.cwd ?? process.cwd()),
          cwd: options.skills?.cwd ?? process.cwd(),
          homeDir: options.skills?.homeDir ?? homedir(),
          trusted:
            options.skills?.trusted ??
            (process.env.KUBIC_TRUST_PROJECT === '1' ||
              process.env.KUBIC_TRUST_PROJECT === 'true'),
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
      ...roleBoot,
      // The same installed policy `kubic run` boots with (issue #86): one
      // derivation, so the interactive path is not the unprotected one.
      policy: {
        classes: installed.classes,
        interceptors: installed.interceptors,
        ...(installed.contributions.length === 0
          ? {}
          : { contributions: installed.contributions }),
      },
    });
    // Issue #147 (§21): a turn a dead process left open would refuse every
    // prompt with LaneBusy. The interactive policy is the durable abort: its
    // approvals would need the overlay, which is not on screen yet, and the
    // operator is present to re-send. The outcome is named in the footer.
    const pendingNotices: string[] = [];
    for (const op of solo.open ?? []) {
      pendingNotices.push(
        describeSettlement(
          await settlePendingOperation(solo, op, 'abort', context),
        ),
      );
    }
    const fullAccess = installed.posture.fullAccess;
    settlePolicy = installed.settle;
    return {
      sessionId: id,
      // The model the lane actually runs (issue #148): the status bar and
      // the usage rows the turn runner records both read this.
      model: await (async () => {
        const live = await solo.lane.getModel(context);
        const running = live ?? solo.model;
        return `${running.provider}/${running.id}`;
      })(),
      journal,
      ...(modelNotices.length === 0
        ? {}
        : { modelNotice: modelNotices.join('; ') }),
      ...(pendingNotices.length === 0
        ? {}
        : { pendingNotice: pendingNotices.join('; ') }),
      fullAccess,
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
          : { seat: workerAskSeatFromAnswer(options.answer) }),
        ...(options.orchestratorRuntime === undefined
          ? {}
          : { orchestrator: options.orchestratorRuntime }),
        ...(options.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: options.approvalPolicy }),
      }),

      loop: {
        accept: (prompt, loopContext) =>
          solo.lane.accept({ kind: 'prompt', prompt }, loopContext),
        lane: solo.lane,
        requestAbort: (operationId, loopContext) =>
          solo.lane.requestAbort(operationId, loopContext),
        findEntries: (query, loopContext) =>
          solo.lane.findEntries(query, loopContext),
        events: solo.harness.events,
        kills: solo.kills,
        context,
        // §46 trajectory per settled turn (issue #383): the same record
        // `kubic run` writes, holding the session's latest settled turn.
        recordTurn: async (turn) => {
          const entries = await solo.lane.findEntries(undefined, context);
          persistRunTrajectory({
            sessionsRoot: root,
            sessionId: id,
            agentId: options.agentId ?? 'root',
            role: options.role ?? 'solo',
            prompt: turn.prompt,
            entries,
            model: { provider: model.provider, id: model.id },
            cwd: env.cwd,
            skills: skillNames,
            startedAt: turn.startedAt,
            endedAt: Date.now(),
            outcome: tuiTurnOutcome(turn, entries),
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
// lane's own terminal record decides, exactly as it does for `kubic run`; a
// deferred operation is an approval that could not be answered; a refused
// admission is a plain failure.
export function tuiTurnOutcome(
  turn: TuiTurnRecord,
  entries: readonly unknown[],
): RunOutcome {
  const lane = turn.lane;
  if (lane === 'deferred') {
    return {
      terminus: 'approval_timed_out',
      summary: turn.outcome.detail ?? 'turn deferred',
    };
  }
  if (lane === undefined) {
    return {
      terminus: 'failed',
      summary: turn.outcome.detail ?? 'the turn failed',
    };
  }
  const terminus = mapLaneOutcomeToTerminus(lane.status, lane.error);
  const summary =
    terminus === 'completed'
      ? (assistantSummary(entries) ?? NO_ASSISTANT_TEXT_SUMMARY)
      : (turn.outcome.detail ?? footerForOutcome(turn.outcome));
  return { terminus, summary, lane };
}

// The config projections `kubic tui` consumes (issues #86, #90, #113, #115,
// #133). The lane half is `runtimeLaneDeps`' own return type BY NAME
// (issue #294): a key that projection gains can never be silently dropped
// here, because the forwarding table in tuiDepsWithDefaults must name
// every key of this type.
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
  // Issue #327: the manager lane's projections for the interactive
  // orchestrator drive — the `[orchestrator]` worktree/cap values and the
  // approval snapshot the resolver path carries. Absent means the shipped
  // defaults (and, for the snapshot, no delegation of conflicts).
  orchestratorRuntime?: RuntimeOrchestrator;
  approvalPolicy?: ApprovalSnapshot;
  // Issue #295: the `[model]`/KUBIC_MODEL pin (runtimeModelPin).
  model?: ModelSelection;
  // Issue #327: the config `[modes]` projection (issue #90's runtime load).
  // Consumed by runTuiCommand: `orchestrator = true` starts the session in
  // orchestrator mode; the flag still beats it.
  modes?: { readonly orchestrator: boolean };
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

export function tuiDepsWithDefaults(
  provided: {
    out: (line: string) => void;
    err?: (line: string) => void;
  } & TuiConfigProjection,
  // The boot the deps drive. Absent means the prod bootTuiLane; tests pass a
  // wrapper to observe (or re-root) exactly what the projection forwards.
  boot: typeof bootTuiLane = bootTuiLane,
): TuiRunDeps {
  // Every projection key must appear (possibly undefined): the `satisfies`
  // makes omitting one a compile error (issue #294).
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
    // Issue #327: the `[modes]` session default and the manager-lane
    // projections the interactive orchestrator drive consumes.
    modes: provided.modes,
    orchestratorRuntime: provided.orchestratorRuntime,
    approvalPolicy: provided.approvalPolicy,
  } satisfies Record<keyof TuiConfigProjection, unknown>;
  const projection = definedOnly(forwarded);

  return {
    out: provided.out,
    ...(provided.err === undefined ? {} : { err: provided.err }),
    createTerminal: () => new ProcessTerminal(),
    ...(projection.modes === undefined ? {} : { modes: projection.modes }),
    // Issue #327: the non-git orchestrator refusal needs a real probe before
    // the alt-screen opens. Lazy: solo sessions never call it.
    isGitRepo: () => defaultIsGitRepo(),
    // The seat arrives as an argument from runTuiCommand — see TuiRunDeps.
    bootLane: (
      sessionId?: string,
      answer?: TuiApprovalSeat,
      flags?: TuiBootFlags,
    ) =>
      boot(sessionId, {
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
        // `--model` beats the config pin (§38.1: CLI over config).
        ...(flags?.model === undefined ? {} : { model: flags.model }),
      }),
  };
}

// Issue #311: the §17 inspectable pair reads the session journal through
// the SAME projection `kubic diff` uses (diffEntries: one change per path,
// latest attribution). Reads are throttled like the transcript refresh: a
// burst of tool-end events collapses into one read per window, and a
// settlement (or the boot) reads at once. A read failure never reaches the
// loop — the panels keep their last rows.
export const JOURNAL_REFRESH_MS = 100;

export class JournalPanelFeed {
  private readonly read: () => ReadonlyArray<JournalChangeLike>;
  private readonly apply: (rows: ReadonlyArray<JournalChangeLike>) => void;
  private readonly schedule: (fn: () => void) => void;
  private pending = false;
  private token = 0;

  constructor(options: {
    read: () => ReadonlyArray<JournalChangeLike>;
    apply: (rows: ReadonlyArray<JournalChangeLike>) => void;
    // Injectable window (tests); absent means a JOURNAL_REFRESH_MS timer.
    schedule?: (fn: () => void) => void;
  }) {
    this.read = options.read;
    this.apply = options.apply;
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
    } catch {
      // The journal is observed, never a gate: a failed read keeps the
      // panels on their last rows.
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

// Drives one accepted prompt to settlement and folds the lane's own events
// into the views as they arrive. `cancel` aborts the in-flight operation by
// id (the same id the admission handed back), so the abort can never target
// a different turn — and a Ctrl-C that lands between submit and admission is
// honoured once the id exists rather than being lost (or worse, treated as a
// quit, which would kill the process mid-turn).
export class TuiTurnRunner {
  private readonly app: TuiApp;
  private readonly loop: TuiLaneLoop;
  private readonly model: string;
  private activeOperationId: string | undefined;
  private detach: (() => void) | undefined;
  private starting = false;
  private aborted = false;

  // Called after a mid-turn transcript refresh lands (the root repaints).
  private readonly onUpdate: (() => void) | undefined;
  private refreshing = false;
  private refreshAgain = false;

  // Issue #311: every lane event, after the app folded it in (the root
  // requests a journal read on tool-end).
  private readonly onLaneEvent: ((event: KubicLaneEvent) => void) | undefined;

  constructor(
    app: TuiApp,
    loop: TuiLaneLoop,
    model: string,
    onUpdate?: () => void,
    onLaneEvent?: (event: KubicLaneEvent) => void,
  ) {
    this.app = app;
    this.loop = loop;
    this.model = model;
    this.onUpdate = onUpdate;
    this.onLaneEvent = onLaneEvent;
  }

  // TUI polish: the transcript follows the turn instead of appearing only
  // at settlement. Every lane event (tool start/end, usage = one model
  // step) re-reads the committed entries; refreshes never overlap, and a
  // burst of events collapses into one trailing refresh.
  private scheduleRefresh(): void {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    void this.refreshTranscript()
      .catch(() => {
        // A mid-turn read failure is not fatal: settlement refreshes again.
      })
      .finally(() => {
        this.refreshing = false;
        this.onUpdate?.();
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.scheduleRefresh();
        }
      });
  }

  get operationId(): string | undefined {
    return this.activeOperationId;
  }

  // Busy from the moment a submit is accepted by the loop — not from the
  // moment the lane admits it — so the Ctrl-C that follows Enter by a
  // keystroke still cancels instead of quitting.
  isRunning(): boolean {
    return this.starting || this.activeOperationId !== undefined;
  }

  // The single lane-event consumer for this lane (§15.3: exactly one).
  // Tool status drives the tree, usage rows drive the status bar. The row
  // carries the boot model (the lane's usage rows are per-request records
  // with no model field of their own) so the bar can group them.
  private readonly sink: LaneEventSink = (event: KubicLaneEvent): void => {
    this.app.applyLaneEvent(event);
    this.onLaneEvent?.(event);
    if (event.type !== 'run-start') this.scheduleRefresh();
    if (event.type === 'usage') {
      this.usageRows.push({
        model: this.model,
        provider: event.lane,
        usage: event.row.usage,
        entryId: event.row.entryId,
        // Pi stamps the row with its own id/seq; the status bar reads
        // tokens + cost only, so the request id is the closest honest
        // trace handle available here.
        toolCallId: event.row.id,
      });
      this.app.setUsage([...this.usageRows]);
    }
  };

  private readonly usageRows: Array<Parameters<TuiApp['setUsage']>[0][number]> =
    [];

  // The in-flight run (issue #312): a quit waits on it, bounded.
  private running: Promise<TuiTurnOutcome> | undefined;
  // The lane's terminal record of the turn in flight (issue #383).
  private settledLane: TuiTurnRecord['lane'];

  run(prompt: string): Promise<TuiTurnOutcome> {
    const running = this.runTurn(prompt);
    this.running = running;
    return running;
  }

  // Issue #312 (§18, #109): quitting mid-turn aborts and drains the
  // operation — the durable abort request, then every registered kill — and
  // waits for the run to settle, at most until `bound` resolves. A quit that
  // lands before admission is latched: `drive` aborts on the real id.
  async drainForQuit(bound: Promise<void>): Promise<void> {
    if (!this.isRunning()) return;
    this.aborted = true;
    const operationId = this.activeOperationId;
    if (operationId !== undefined) {
      await drainOperation(
        this.loop,
        this.loop.kills,
        operationId,
        this.loop.context,
      );
    }
    const settled = (this.running ?? Promise.resolve()).then(
      () => undefined,
      () => undefined,
    );
    await Promise.race([settled, bound]);
  }

  // One turn: drive it, then hand the lane's own terminal record to the
  // run's §46 trajectory (issue #383) — the recording never changes the
  // turn's outcome.
  private async runTurn(prompt: string): Promise<TuiTurnOutcome> {
    const startedAt = Date.now();
    this.settledLane = undefined;
    const outcome = await this.drive(prompt);
    try {
      await this.loop.recordTurn?.({
        prompt,
        startedAt,
        outcome,
        ...(this.settledLane === undefined ? {} : { lane: this.settledLane }),
      });
    } catch {
      // The trajectory observes the turn; it never changes its outcome.
    }
    return outcome;
  }

  private async drive(prompt: string): Promise<TuiTurnOutcome> {
    this.starting = true;
    this.aborted = false;
    this.detach = attachLaneEvents(
      { events: this.loop.events },
      'main',
      this.sink,
    );
    try {
      const admission = await this.loop.accept(prompt, this.loop.context);
      if (!admission.ok) {
        return {
          status: 'failed',
          detail: `lane refused the prompt: ${JSON.stringify(admission.error)}`,
        };
      }
      this.activeOperationId = admission.value.operationId;
      // A Ctrl-C that arrived while the admission was in flight is honoured
      // here, on the real id — never dropped, never escalated to a quit.
      if (this.aborted) await this.abort();
      const driven = await driveToSettled(
        this.loop.lane,
        admission.value.operationId,
        this.loop.context,
      );
      await this.refreshTranscript();
      // The lane's own terminal status is authoritative: an abort that raced
      // a completing turn must not be relabelled as cancelled (the work
      // really did land), and a turn that the abort did stop settles as
      // 'aborted'. `this.aborted` only decides the footer when the record is
      // silent, which cannot happen on a settled drive.
      if (driven.kind === 'waiting-deferred') {
        this.settledLane = 'deferred';
        return {
          status: 'failed',
          // Issue #113: the TUI HAS a TTY — the old message blamed a
          // missing one. The deferral is the fact: the lane suspended this
          // operation (an unanswerable approval or a background wait) and
          // the operator can try again.
          detail:
            'turn suspended: the lane deferred this operation (an unanswerable approval or background wait) — try re-submitting',
        };
      }
      const record = driven.outcome as { status?: unknown; error?: unknown };
      if (
        record.status === 'completed' ||
        record.status === 'aborted' ||
        record.status === 'declined' ||
        record.status === 'failed'
      ) {
        const laneError = record.error as OperationErrorLike | undefined;
        this.settledLane = {
          status: record.status,
          ...(laneError === undefined ? {} : { error: laneError }),
        };
      }
      if (record.status === 'completed') return { status: 'completed' };
      if (record.status === 'aborted' || record.status === 'declined') {
        return { status: 'cancelled' };
      }
      const error = record.error as { message?: unknown } | undefined;
      return {
        status: 'failed',
        detail:
          typeof error?.message === 'string'
            ? error.message
            : `lane ${String(record.status)}`,
      };
    } finally {
      this.starting = false;
      this.activeOperationId = undefined;
      this.detach?.();
      this.detach = undefined;
    }
  }

  private async abort(): Promise<void> {
    if (this.activeOperationId === undefined) return;
    await requestLaneAbort(
      this.loop,
      this.loop.kills,
      this.activeOperationId,
      this.loop.context,
    );
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

  // Cancels the in-flight operation. Returns false when nothing is running,
  // so the caller can fall through to quit. Before the admission lands the
  // request is latched and replayed by `run`, so the key is never lost.
  // It THROWS when the lane refuses the abort (requestLaneAbort wraps the
  // refusal in LaneDriveError); the key handler catches it and reports it,
  // so a refusal is never a silent no-op and never an unhandled rejection.
  async cancel(): Promise<boolean> {
    if (!this.isRunning()) return false;
    this.aborted = true;
    await this.abort();
    return true;
  }

  // Reads are tagged in issue order: a background refresh that resolves
  // after a newer one (e.g. the settlement refresh) is dropped instead of
  // overwriting the fresher transcript.
  private readSeq = 0;
  private appliedSeq = 0;

  async refreshTranscript(): Promise<void> {
    this.readSeq += 1;
    const seq = this.readSeq;
    const entries = await this.loop.findEntries(undefined, this.loop.context);
    if (seq < this.appliedSeq) return;
    this.appliedSeq = seq;
    this.app.applyLaneEntries(entries);
  }
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
  // Issue #295: `--model <provider/id>`, parsed by the registrar.
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
  if (options.model !== undefined) flags.model = options.model;
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
  });
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
        });
  journalFeed?.now();
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
            if (event.type === 'tool-end') journalFeed?.request();
          },
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
  let screen: Screen | undefined;
  let stopped = false;
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
    if (draining) {
      app.setEditorFooter('cancelling…');
      screen?.render();
    }
    void (async () => {
      if (draining && activeTurn !== undefined) {
        let cancelTimer: () => void = () => {};
        const bound = new Promise<void>((resolve) => {
          endDrain = resolve;
          cancelTimer = (deps.setDrainTimer ?? defaultDrainTimer)(
            deps.drainTimeoutMs ?? TUI_DRAIN_TIMEOUT_MS,
            resolve,
          );
        });
        try {
          await activeTurn.drainForQuit(bound);
        } catch {
          // The drain is best-effort; the sweep and close still run.
        }
        cancelTimer();
        endDrain = undefined;
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
      try {
        await boot.close?.();
      } catch {
        // Close failures never mask the clean quit.
      }
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
    const routeInput = (data: string): { consume: true } | undefined => {
      if (stopped) {
        // Issue #312: while a quit drains, a second Ctrl-C ends the wait.
        if (!isKeyRelease(data) && keyIs(data, 'ctrl+c')) shutdown();
        return { consume: true };
      }
      // Issue #306, defence in depth: TuiApp.handleInput already drops Kitty
      // key releases, but the quit/cancel counting below must never see one
      // even if a future caller routes around it — a Ctrl-C release counted
      // as the second Ctrl-C would quit the session on key-up.
      if (isKeyRelease(data)) return { consume: true };
      const routed = app.handleInput(data);
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
                if (!accepted)
                  app.setEditorFooter('cancel failed — turn still running');
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
      app.onSubmit((prompt: string) => {
        if (stopped || activeTurn?.isRunning() === true) return;
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
          return;
        }
        activeTurn = driver;
        app.setBusy(true);
        startSpinner();
        screen?.render();
        void driver
          .run(prompt)
          .then((outcome) => {
            app.setBusy(false);
            stopSpinner();
            syncPosture();
            journalFeed?.now();
            // A completed turn has no outcome line of its own, so the footer
            // falls back to the lane's trust statement instead of going
            // blank (issue #89) — a cancelled/failed turn keeps its own
            // report.
            app.setEditorFooter(
              footerForOutcome(outcome) || noticeFor(app.mode()),
            );
            if (!stopped) screen?.render();
          })
          .catch((error: unknown) => {
            app.setBusy(false);
            stopSpinner();
            const message =
              error instanceof Error ? error.message : String(error);
            app.setEditorFooter(`error: ${message}`);
            if (!stopped) screen?.render();
          })
          .finally(() => {
            if (activeTurn === driver) activeTurn = undefined;
          });
      });
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
