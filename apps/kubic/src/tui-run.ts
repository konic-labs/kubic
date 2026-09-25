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

import { join } from 'node:path';
import type { PermissionClasses } from '../../../packages/agents/src/policy.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import {
  type InstalledSoloPolicy,
  installSoloPolicy,
} from '../../../packages/host/src/approvals.js';
import { assembleModels } from '../../../packages/host/src/models-cli.js';
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
import type { LaneEntryLike } from '../../../packages/tui/src/lane-cells.js';
import type { Screen } from '../../../packages/tui/src/screen.js';
import { bootScreen } from '../../../packages/tui/src/screen.js';
import {
  createTuiApp,
  type TuiApp,
} from '../../../packages/tui/src/tui-app.js';
import type { Terminal } from '../../../packages/tui/src/tui-boundary.js';
import { ProcessTerminal } from '../../../packages/tui/src/tui-boundary.js';
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
  selectModel,
} from '../../../packages/worker/src/model-select.js';
import {
  BACKGROUND_CONTEXT,
  type Context,
  type OperationAdmissionResult,
} from '../../../packages/worker/src/pi-boundary.js';

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
  // Issue #88: the boot hands the loop its drive surface. Injected boots in
  // the existing #75 tests omit it — the loop then runs as the viewer shell,
  // which keeps the screen/restore contract testable on its own.
  loop?: TuiLaneLoop;
}

export interface TuiRunDeps {
  out: (line: string) => void;
  createTerminal: () => Terminal;
  bootLane: (sessionId?: string) => Promise<TuiLaneBoot>;
}

export interface TuiRunOptions {
  sessionsRoot?: string;
  env?: NodeExecutionEnv;
  // Config-sourced permission classes (issue #90): the TUI is a
  // config-consuming command, so it takes the same projection `kubic run`
  // does. Absent means the documented SOLO_DEFAULTS.
  classes?: PermissionClasses;
  // The installed-policy seat (issue #86): the same derivation the headless
  // runner installs. Absent means the shipped default (classes above +
  // destructive/network/confine guards + the approval ask); tests inject a
  // variant. `kubic tui` drives the same lane, so it takes the same policy.
  policy?: InstalledSoloPolicy;
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
  const close = async (): Promise<void> => {
    try {
      await session.close(context);
    } catch {
      // The mapped result stands — close failures never escape.
    }
  };
  try {
    bridge.createDir(join(id, 'journal'));
    const assembled = assembleModels(process.cwd());
    const model = selectModel(assembled.models);
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
        sessionDir: join(root, id),
      });
    const solo = await bootSoloLane({
      session,
      models: assembled.models,
      model,
      env,
      sessionId: id,
      agentId: 'root',
      journal: new FileJournalStore(join(root, id, 'journal')),
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
      model: `${model.provider}/${model.id}`,
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

export function tuiDepsWithDefaults(provided: {
  out: (line: string) => void;
  // Config projections (issues #86, #90): the TUI installs the same policy
  // the headless runner does. Absent means the documented safe default.
  classes?: PermissionClasses;
  policy?: InstalledSoloPolicy;
}): TuiRunDeps {
  const { classes, policy } = provided;
  return {
    ...provided,
    createTerminal: () => new ProcessTerminal(),
    bootLane: (sessionId?: string) =>
      bootTuiLane(sessionId, {
        ...(classes === undefined ? {} : { classes }),
        ...(policy === undefined ? {} : { policy }),
      }),
  };
}

export interface TuiTurnOutcome {
  readonly status: 'completed' | 'cancelled' | 'failed' | 'busy';
  readonly detail?: string;
}

// One-line footer for a settled turn: the editor row is the loop's only
// always-visible status surface besides the status bar, and a silent
// outcome (especially a cancellation) would leave the user guessing.
export function footerForOutcome(outcome: TuiTurnOutcome): string {
  if (outcome.status === 'completed') return '';
  if (outcome.status === 'cancelled') return 'cancelled';
  if (outcome.status === 'busy') return 'busy — wait for the turn to finish';
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

  constructor(app: TuiApp, loop: TuiLaneLoop, model: string) {
    this.app = app;
    this.loop = loop;
    this.model = model;
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
          detail:
            'turn suspended waiting on an approval that cannot arrive without a TTY',
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

  async refreshTranscript(): Promise<void> {
    const entries = await this.loop.findEntries(undefined, this.loop.context);
    this.app.applyLaneEntries(entries);
  }
}

export async function runTuiCommand(
  args: string[],
  deps: TuiRunDeps,
): Promise<number> {
  let sessionId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--help' || arg === '-h') {
      deps.out('usage: kubic tui [--session <id>]');
      return RUN_EXIT_OK;
    }
    if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --session needs a value');
        return RUN_EXIT_USAGE;
      }
      sessionId = value;
      i += 1;
    } else {
      deps.out(`error: unknown flag ${arg}`);
      return RUN_EXIT_USAGE;
    }
  }
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    deps.out(
      `error: invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
    return RUN_EXIT_USAGE;
  }
  let boot: TuiLaneBoot;
  try {
    boot = await deps.bootLane(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.out(`error: ${message}`);
    if (error instanceof ModelSelectError)
      return RUN_EXIT_PROVIDER_PROBE_FAILED;
    return mapCaughtErrorToTerminus(error) === 'workspace_unavailable'
      ? RUN_EXIT_WORKSPACE_UNAVAILABLE
      : RUN_EXIT_FAILED;
  }
  const app = createTuiApp({ sessionId: boot.sessionId, model: boot.model });
  const terminal = deps.createTerminal();
  const turn =
    boot.loop === undefined
      ? undefined
      : new TuiTurnRunner(app, boot.loop, boot.model);
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
    booted.render();
    process.once('SIGINT', onSigint);
    stdin?.once('end', onStdinEnd);
    stdin?.once('close', onStdinEnd);
    booted.tui.addInputListener((data: string) => {
      if (stopped) return { consume: true };
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
      return routed.consumed ? { consume: true } : undefined;
    });
    if (turn !== undefined) {
      app.onSubmit((prompt: string) => {
        if (stopped || turn.isRunning()) return;
        app.setBusy(true);
        app.setEditorFooter('working… Ctrl-C cancels');
        screen?.render();
        void turn
          .run(prompt)
          .then((outcome) => {
            app.setBusy(false);
            app.setEditorFooter(footerForOutcome(outcome));
            if (!stopped) screen?.render();
          })
          .catch((error: unknown) => {
            app.setBusy(false);
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
