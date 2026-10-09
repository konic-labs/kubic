// The process lifecycle of `kubic tui`: the signals, the fatal handler, stdin
// EOF, and the quit — a running turn drained, the terminal restored and the
// session closed, each bounded, and exactly once.
import {
  EXIT_FAILED,
  type ExitCode,
  INTERRUPT_EXIT_CODES,
} from '@kubic/core/cli/exit-codes';
import type { TuiContext } from './context.js';
import type { TuiProcessEvents, TuiSignal } from './options.js';

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

function defaultDrainTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}

export class TuiLifecycle {
  private readonly ctx: TuiContext;
  // SIGINT, SIGTERM and SIGHUP all run the same
  // shutdown (mid-turn drain, restore, sweep, close) and exit 128+signo. The
  // listeners stay attached until the terminal is restored, so a second
  // signal during the drain only shortens it; they are detached before the
  // session close, so a signal after that takes the default disposition.
  private readonly signals: TuiProcessEvents;
  private readonly signalListeners = new Map<
    TuiSignal,
    (value: unknown) => void
  >();
  private signalsAttached = false;
  // The last-resort restore. An exception in input or render, or
  // an unhandled rejection, would otherwise kill the process with the alt
  // screen, raw mode, mouse tracking and the Kitty protocol still active.
  // The terminal is restored first (nothing is printed — the layout may be
  // what threw), then the error is reported and the process exits 1.
  private fatalHandled = false;
  private fatalAttached = false;
  // Stdin EOF (a closed pty, `kubic tui < /dev/null`, or a shell that
  // detached the tty) is a quit: Pi's terminal never reports it, so a
  // missing handler would leave the alt-screen hung on a dead input stream
  // forever. Registered only when the stream exists, and always removed.
  private readonly stdin = process.stdin;
  // Set while a quit drains a running turn; calling it ends the
  // wait at once (a second Ctrl-C, a second SIGINT, or the bound firing).
  private endDrain: (() => void) | undefined;
  private resolveExit: () => void = () => {};
  // Resolves once the loop is over: a quit's close finished, or a fatal
  // error was reported.
  readonly exited: Promise<void>;

  constructor(ctx: TuiContext) {
    this.ctx = ctx;
    this.signals = ctx.deps.signals ?? process;
    this.exited = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    for (const name of TUI_SIGNALS) {
      this.signalListeners.set(name, () => {
        if (!ctx.stopped) ctx.exitCode = signalExitCode(name);
        this.shutdown();
      });
    }
  }

  attachSignals(): void {
    if (this.signalsAttached) return;
    this.signalsAttached = true;
    for (const [name, listener] of this.signalListeners)
      this.signals.on(name, listener);
  }

  detachSignals(): void {
    if (!this.signalsAttached) return;
    this.signalsAttached = false;
    for (const [name, listener] of this.signalListeners)
      this.signals.off(name, listener);
  }

  attachFatal(): void {
    if (this.fatalAttached) return;
    this.fatalAttached = true;
    for (const name of TUI_FATAL_EVENTS)
      this.signals.on(name, this.fatalListener);
  }

  detachFatal(): void {
    if (!this.fatalAttached) return;
    this.fatalAttached = false;
    for (const name of TUI_FATAL_EVENTS)
      this.signals.off(name, this.fatalListener);
  }

  attachStdin(): void {
    this.stdin?.once('end', this.onStdinEnd);
    this.stdin?.once('close', this.onStdinEnd);
  }

  detachStdin(): void {
    this.stdin?.removeListener('end', this.onStdinEnd);
    this.stdin?.removeListener('close', this.onStdinEnd);
  }

  fatal(error: unknown): void {
    if (this.fatalHandled) return;
    const { ctx } = this;
    this.fatalHandled = true;
    ctx.stopped = true;
    ctx.exitCode = EXIT_FAILED;
    ctx.chrome.stopSpinner();
    ctx.chrome.stopClock();
    this.endDrain?.();
    try {
      ctx.screen?.restore();
    } catch {
      // Best effort: the report below must still happen.
    }
    this.detachSignals();
    this.detachFatal();
    this.detachStdin();
    ctx.surface.cancelPending(
      'the session ended before the approval was answered',
    );
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    (ctx.deps.err ?? ctx.deps.out)(`error: kubic tui crashed: ${detail}`);
    (ctx.deps.exit ?? ((code: number) => process.exit(code)))(EXIT_FAILED);
    this.resolveExit();
  }

  shutdown(): void {
    const { ctx } = this;
    if (ctx.stopped) {
      // A second quit while the drain waits shortens it: the kills already
      // ran, so the loop exits now instead of at the bound.
      this.endDrain?.();
      return;
    }
    ctx.stopped = true;
    ctx.chrome.stopSpinner();
    ctx.chrome.stopClock();
    // A quit (SIGINT, stdin EOF, or the loop's own quit path) must
    // settle a pending approval as a deny — the turn that is waiting on it
    // would otherwise sit until the lane's timeout, and the operator gets no
    // second chance to answer a screen they have left.
    ctx.surface.cancelPending(
      'the session quit before the approval was answered',
    );
    this.detachStdin();
    // A turn still running is aborted and
    // drained BEFORE the sweep and the session close — otherwise its detached
    // process group outlives the session, its late writes escape both the
    // journal and the reconciliation, and the operation never records a
    // terminal status. The screen stays up (footer: cancelling…) until the
    // drain ends, bounded by drainTimeoutMs.
    const draining = ctx.activeTurn?.isRunning() === true;
    // The drain has its own bound, and the close gets a FRESH one
    // of its own: pi-durable's `Harness.close` joins live task invocations
    // (`beforeClose`), so a provider that ignores the abort must not hang the
    // quit — but a drain that consumed its whole budget must not leave the
    // close (the session lock release among it) zero time either.
    let drainBound: Promise<void> | undefined;
    let endBound: () => void = () => {};
    if (draining) {
      drainBound = new Promise<void>((resolve) => {
        this.endDrain = resolve;
        endBound = this.drainTimer(resolve);
      });
      ctx.app.setEditorFooter('cancelling…');
      ctx.app.setCancelling(true);
      ctx.screen?.render();
    }
    void (async () => {
      const running = ctx.activeTurn;
      if (draining && running !== undefined && drainBound !== undefined) {
        try {
          await running.drainForQuit(drainBound);
        } catch {
          // The drain is best-effort; the sweep and close still run.
        }
      }
      if (this.fatalHandled) return;
      // Pop the Kitty protocol and let late input (the quitting
      // key's release, especially over SSH) arrive and be swallowed here
      // instead of printing as `[27;1:3u` in the operator's shell.
      try {
        await ctx.terminal?.drainInput();
      } catch {
        // Draining is best effort; the restore below still runs.
      }
      if (this.fatalHandled) return;
      try {
        ctx.screen?.stop((line: string) => ctx.deps.out(line));
      } catch {
        // Restore failures never mask the clean quit.
      }
      this.detachSignals();
      // The close joins the harness's live task invocations: a close that
      // cannot finish inside ITS OWN fresh bound is abandoned — the process is
      // leaving anyway, and the next attach reclaims the stale lock by pid
      // liveness. The harness's own storage may stay open until then. A quit
      // key that arrives while the close waits ends that wait at once
      // (`endDrain` points at the close bound from here on).
      endBound();
      const closeBound = new Promise<void>((resolve) => {
        this.endDrain = resolve;
        endBound = this.drainTimer(resolve);
      });
      // An idle quit re-baselines first, so the close's sweep
      // (which still catches a turn the quit interrupted) never journals an
      // edit the operator made after the last turn settled.
      if (!ctx.reconcileTurnOpen) ctx.rebaseline();
      try {
        await Promise.race([ctx.boot.close?.(), closeBound]);
      } catch {
        // Close failures never mask the clean quit.
      }
      endBound();
      this.endDrain = undefined;
      this.detachFatal();
      this.resolveExit();
    })();
  }

  // A setup step threw after the screen went active: the main screen is
  // restored and the lane closed, so the failure never strands either.
  async abandon(): Promise<void> {
    const { ctx } = this;
    ctx.chrome.stopClock();
    this.detachSignals();
    this.detachFatal();
    this.detachStdin();
    try {
      ctx.screen?.stop((line: string) => ctx.deps.out(line));
    } catch {
      // Restore failures never mask the setup error.
    }
    try {
      await ctx.boot.close?.();
    } catch {
      // Close failures never mask the setup error.
    }
  }

  private drainTimer(fire: () => void): () => void {
    return (this.ctx.deps.setDrainTimer ?? defaultDrainTimer)(
      this.ctx.deps.drainTimeoutMs ?? TUI_DRAIN_TIMEOUT_MS,
      fire,
    );
  }

  private readonly fatalListener = (value: unknown): void => {
    this.fatal(value);
  };

  private readonly onStdinEnd = (): void => {
    this.shutdown();
  };
}
