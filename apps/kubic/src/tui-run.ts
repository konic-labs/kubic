// `kubic tui` (issue #75, prompt loop #88): interactive alt-screen over the
// solo lane. The composition root owns every side effect: it boots the real
// solo lane (same session/model setup as the headless runner), opens the
// alt-screen on the replicated presentation, routes keyboard input through
// the tui controller, drives the lane for whatever the user submits, feeds
// lane events into the tree and usage rows into the status bar, and restores
// the main screen with the final document printed — on quit, on SIGINT,
// and exactly once. `kubic run` is untouched (headless regression:
// tui-command.test.ts + binary exit codes).
//
// Cancellation (§18, issue #88): Ctrl-C during a turn aborts the in-flight
// operation through the lane's own requestAbort (the durable, kill-draining
// path) and keeps the session alive; a second Ctrl-C quits. While idle the
// first Ctrl-C quits. Esc and Ctrl-D-on-an-empty-draft quit too, so no
// honoured key is a silent no-op.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PermissionClasses } from '../../../packages/agents/src/policy.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import {
  FileJournalStore,
  type JournalRetention,
} from '../../../packages/exec/src/journal.js';
import {
  beginReconciliation,
  type RunReconciliation,
} from '../../../packages/exec/src/journal-reconcile.js';
import {
  type ApprovalRequest,
  type ApprovalVerdict,
  type InstalledSoloPolicy,
  installSoloPolicy,
} from '../../../packages/host/src/approvals.js';
import {
  FAUX_FOOTER,
  FAUX_MODEL_ID,
  FAUX_PROVIDER_ID,
  fauxProviderActive,
} from '../../../packages/host/src/faux-provider.js';
import {
  shouldEmitSoloNotice,
  soloTuiLine,
} from '../../../packages/host/src/limits/solo-warning.js';
import { assembleModels } from '../../../packages/host/src/models-cli.js';
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
  SESSION_ID_PATTERN,
} from '../../../packages/host/src/run-cli.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import { bootSkills } from '../../../packages/host/src/skills-boot.js';
import { createApprovalSurface } from '../../../packages/tui/src/approval-surface.js';
import type { LaneEntryLike } from '../../../packages/tui/src/lane-cells.js';
import type { Screen } from '../../../packages/tui/src/screen.js';
import { bootScreen } from '../../../packages/tui/src/screen.js';
import {
  createTuiTheme,
  detectColorLevel,
  setTuiTheme,
} from '../../../packages/tui/src/theme.js';
import {
  createTuiApp,
  type TuiApp,
} from '../../../packages/tui/src/tui-app.js';
import type { Terminal } from '../../../packages/tui/src/tui-boundary.js';
import {
  isKeyRelease,
  ProcessTerminal,
} from '../../../packages/tui/src/tui-boundary.js';
import {
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
  attachSession,
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
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
} from '../../../packages/worker/src/pi-boundary.js';
import type { runtimeLaneDeps } from './config-runtime.js';
import { roleModelSelection } from './headless-run.js';

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
}

// The `kubic tui` parity flags (issue #113): same names and semantics as
// the `kubic run` counterparts.
export interface TuiBootFlags {
  role?: string;
  noSkills?: boolean;
  skillsList?: string[];
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
  // Issue #295 (§38.1): the explicit model pin — `--model`, else the
  // `[model]`/KUBIC_MODEL projection runtimeModelPin makes for `kubic run`.
  // It beats the role layer's model, which beats first-available.
  model?: ModelSelection;
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
  const close = async (): Promise<void> => {
    try {
      reconciliation?.sweep();
    } catch {
      // A sweep failure never masks the clean quit (same posture as the
      // headless runner: reconciliation observes, it does not gate).
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
    const assembled = assembleModels(process.cwd());
    const models = options.models ?? assembled.models;
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
      options.models === undefined && fauxProviderActive(process.env)
        ? { provider: FAUX_PROVIDER_ID, id: FAUX_MODEL_ID }
        : options.model,
      roleModelSelection(selectedRole?.resolved.model),
    );
    const modelRef = `${model.provider}/${model.id}`;
    const env = options.env ?? new NodeExecutionEnv(process.cwd());
    // Installed policy (issue #86): `kubic tui` drives the same solo lane as
    // `kubic run`, so it installs the same policy — one derivation
    // (host/approvals.installSoloPolicy), which is also what `doctor`
    // reports. Without this the interactive path would be the unprotected
    // one, which is the defect this issue exists to close.
    const installed =
      options.policy ??
      installSoloPolicy({
        workspace: env.cwd,
        ...(options.classes === undefined ? {} : { classes: options.classes }),
        source: options.policySource ?? 'default',
        sessionDir: join(root, id),
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
    const solo = await bootSoloLane({
      session,
      models,
      model,
      env,
      sessionId: id,
      agentId: options.agentId ?? 'root',
      journal,
      // Issue #113 (§29.3): skills discovery at boot, same as the headless
      // runner — the <skills> block lands on the interactive lane too. A
      // loader refusal is never fatal (skills are context, never a gate);
      // it is logged to the boot's debug channel.
      ...((): { promptSections?: string[] } => {
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
        return skills.block === undefined
          ? {}
          : { promptSections: [skills.block] };
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
    return {
      sessionId: id,
      model: modelRef,
      journal,
      approvalsSkipped: installed.approvalsSkipped,
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
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
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
  policy?: InstalledSoloPolicy;
  // Issue #113 (§42.4): config journal retention, threaded from the same
  // runtimeRunDeps projection `kubic run` uses.
  journalRetention?: JournalRetention;
  // Issue #115 (§35/§42.5): config out-of-scope paths, from that same
  // projection — the interactive lane's baseline and sweep honour them too.
  reconcileOutOfScope?: string[];
  // Issue #295: the `[model]`/KUBIC_MODEL pin (runtimeModelPin).
  model?: ModelSelection;
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
    policySource: provided.policySource,
    policy: provided.policy,
    journalRetention: provided.journalRetention,
    reconcileOutOfScope: provided.reconcileOutOfScope,
    // Issue #294: `[agent].name` (journal and reconciliation attribution)
    // and the `[roles.<name>]` layers `--role` merges under the document.
    agentId: provided.agentId,
    roles: provided.roles,
    model: provided.model,
  } satisfies Record<keyof TuiConfigProjection, unknown>;
  const projection = definedOnly(forwarded);
  return {
    out: provided.out,
    ...(provided.err === undefined ? {} : { err: provided.err }),
    createTerminal: () => new ProcessTerminal(),
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
        // `--model` beats the config pin (§38.1: CLI over config).
        ...(flags?.model === undefined ? {} : { model: flags.model }),
      }),
  };
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

  constructor(
    app: TuiApp,
    loop: TuiLaneLoop,
    model: string,
    onUpdate?: () => void,
  ) {
    this.app = app;
    this.loop = loop;
    this.model = model;
    this.onUpdate = onUpdate;
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

  async run(prompt: string): Promise<TuiTurnOutcome> {
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
  // Issue #295: `--model <provider/id>`, parsed by the registrar.
  readonly model?: ModelSelection;
}

export async function runTuiCommand(
  options: TuiCommandOptions,
  deps: TuiRunDeps,
): Promise<number> {
  const sessionId = options.session;
  const flags: TuiBootFlags = {};
  if (options.role !== undefined) flags.role = options.role;
  if (options.noSkills === true) flags.noSkills = true;
  if (options.model !== undefined) flags.model = options.model;
  const skillsList = options.skills ?? [];
  if (skillsList.length > 0) flags.skillsList = [...skillsList];
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
  const surface = createApprovalSurface();
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
  setTuiTheme(
    createTuiTheme(
      detectColorLevel(process.env, process.stdout.isTTY === true),
    ),
  );
  const app = createTuiApp({
    sessionId: boot.sessionId,
    model: boot.model,
    approvalSurface: surface,
    // Issue #307: `kubic tui` is the solo lane; the approvals half of the
    // indicator comes from the installed policy, never a literal.
    mode: 'solo',
    approvalsSkipped: boot.approvalsSkipped?.() === true,
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
  // The faux testing provider is never silent: while it answers, the
  // footer says so next to (or instead of) the solo notice.
  const notice =
    boot.model === `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`
      ? [FAUX_FOOTER, soloNotice].filter((part) => part !== '').join(' · ')
      : soloNotice;
  const turn =
    boot.loop === undefined
      ? undefined
      : new TuiTurnRunner(app, boot.loop, boot.model, () => {
          syncPosture();
          if (!stopped) screen?.update();
        });
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
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const onSigint = (): void => {
    shutdown();
  };
  // Stdin EOF (a closed pty, `kubic tui < /dev/null`, or a shell that
  // detached the tty) is a quit: Pi's terminal never reports it, so a
  // missing handler would leave the alt-screen hung on a dead input stream
  // forever. Registered only when the stream exists, and always removed.
  const stdin = process.stdin;
  const onStdinEnd = (): void => {
    shutdown();
  };
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    stopSpinner();
    // Issue #96: a quit (SIGINT, stdin EOF, or the loop's own quit path) must
    // settle a pending approval as a deny — the turn that is waiting on it
    // would otherwise sit until the lane's timeout, and the operator gets no
    // second chance to answer a screen they have left.
    surface.cancelPending('the session quit before the approval was answered');
    process.removeListener('SIGINT', onSigint);
    stdin?.removeListener('end', onStdinEnd);
    stdin?.removeListener('close', onStdinEnd);
    screen?.stop((line: string) => deps.out(line));
    void (async () => {
      try {
        await boot.close?.();
      } catch {
        // Close failures never mask the clean quit.
      }
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
    app.setEditorFooter(notice);
    booted.render();
    process.once('SIGINT', onSigint);
    stdin?.once('end', onStdinEnd);
    stdin?.once('close', onStdinEnd);
    booted.tui.addInputListener((data: string) => {
      if (stopped) return { consume: true };
      // Issue #306, defence in depth: TuiApp.handleInput already drops Kitty
      // key releases, but the quit/cancel counting below must never see one
      // even if a future caller routes around it — a Ctrl-C release counted
      // as the second Ctrl-C would quit the session on key-up.
      if (isKeyRelease(data)) return { consume: true };
      const routed = app.handleInput(data);
      if (routed.quit) {
        if (routed.cancel && turn?.isRunning()) {
          // Ctrl-C during a turn. The first one cancels the operation and
          // keeps the session alive; a second one (while the cancellation is
          // still draining) quits, which is the contract docs/cli/commands.md
          // ships. The footer is set synchronously so the cancellation is
          // visible on the very next frame — the abort itself is async.
          if (!turn.isCancelling()) {
            app.setEditorFooter('cancelling…');
            screen?.render();
            void turn
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
    });
    if (turn !== undefined) {
      app.onSubmit((prompt: string) => {
        if (stopped || turn.isRunning()) return;
        app.setBusy(true);
        startSpinner();
        screen?.render();
        void turn
          .run(prompt)
          .then((outcome) => {
            app.setBusy(false);
            stopSpinner();
            syncPosture();
            // A completed turn has no outcome line of its own, so the footer
            // falls back to the trust statement instead of going blank
            // (issue #89) — a cancelled/failed turn keeps its own report.
            app.setEditorFooter(footerForOutcome(outcome) || notice);
            if (!stopped) screen?.render();
          })
          .catch((error: unknown) => {
            app.setBusy(false);
            stopSpinner();
            const message =
              error instanceof Error ? error.message : String(error);
            app.setEditorFooter(`error: ${message}`);
            if (!stopped) screen?.render();
          });
      });
      await turn.refreshTranscript();
    }
  } catch (error) {
    // Post-start setup (boot/setFocus/render/input routing) can throw
    // after the alt-screen went active — restore the main screen and
    // close the lane so the reject never strands either. The setup
    // error stands.
    process.removeListener('SIGINT', onSigint);
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
    throw error;
  }
  await exited;
  return RUN_EXIT_OK;
}
