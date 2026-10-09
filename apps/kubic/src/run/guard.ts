// The run's guard: the wall-clock bound (`--timeout`), the turn bound
// (`--max-turns`) and the interrupts (SIGINT/SIGTERM/SIGHUP). Each one stops
// the run's waits through one cancellable context, and the first stop is
// the one the run reports.
import { turnAbort } from '@kubic/agent/lane/turn';
import { type Context, withCancel } from '@kubic/agent/pi-boundary';
import type { InterruptSignal, SignalSource } from './options.js';

const INTERRUPT_SIGNALS: readonly InterruptSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
];

// Guard exhaustion surfaces as control flow, never as a lane failure: an
// interrupt maps to `cancelled` (128+signo, the POSIX convention `kubic tui`
// uses), the wall clock to `timeout` and `--max-turns` to `turn_limit`, each
// with the ref triple intact.
export type GuardStop =
  | { readonly kind: 'interrupted'; readonly signal: string }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'turn-limit'; readonly turns: number };

export function guardStopMessage(stop: GuardStop): string {
  switch (stop.kind) {
    case 'interrupted':
      return `run interrupted by ${stop.signal}`;
    case 'timeout':
      return `run timed out after ${stop.ms}ms`;
    case 'turn-limit':
      return `turn limit reached after ${stop.turns} turns`;
  }
}

export class RunGuard {
  // Every wait of the run runs on this context, cancelled by the wall clock,
  // the turn count or a signal. The DURABLE stop is conversation.abort() on
  // the divert paths; this context only stops waiting. The abort reason
  // travels on the context (lane/turn.ts reads it).
  readonly context: Context;
  private readonly cancel: (reason: unknown) => void;
  private readonly signals: SignalSource;
  private readonly maxTurns: number | undefined;
  private firstStop: GuardStop | undefined;
  private signalled: string | undefined;
  // Counted from the committed usage events: one per assistant response,
  // the turn unit `--max-turns` bounds.
  private turns = 0;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private attached = false;
  private onInterrupt: () => void = () => undefined;

  constructor(
    parent: Context,
    signals: SignalSource,
    maxTurns: number | undefined,
  ) {
    const guard = withCancel(parent);
    this.context = guard.context;
    this.cancel = (reason) => guard.cancel(reason);
    this.signals = signals;
    this.maxTurns = maxTurns;
  }

  // The stop that ended the run's waits, if any: the first one wins.
  get stop(): GuardStop | undefined {
    return this.firstStop;
  }

  get stopMessage(): string | undefined {
    return this.firstStop === undefined
      ? undefined
      : guardStopMessage(this.firstStop);
  }

  // The first signal, set even when another bound stopped the run first:
  // the boot checks it before each expensive step (and the run before the
  // turn), so a pre-turn Ctrl-C cancels the boot instead of letting it run
  // on unseen.
  get interruptedBy(): string | undefined {
    return this.signalled;
  }

  // Interrupts are installed from here until `close`, so the default handler
  // cannot kill the run past its own cleanup, and the wall clock starts
  // with the run's own work (the pending settlement and the turn), not with
  // the session open. `onInterrupt` runs on the first signal, before the
  // stop.
  start(boundMs: number, onInterrupt: () => void): void {
    this.onInterrupt = onInterrupt;
    this.attached = true;
    for (const name of INTERRUPT_SIGNALS) this.signals.on(name, this.onSignal);
    this.deadline = setTimeout(
      () => this.trip({ kind: 'timeout', ms: boundMs }),
      boundMs,
    );
  }

  // One committed response: past `--max-turns`, the run stops.
  countTurn(): void {
    this.turns += 1;
    if (this.maxTurns !== undefined && this.turns > this.maxTurns) {
      this.trip({ kind: 'turn-limit', turns: this.turns - 1 });
    }
  }

  // In-flight work is dead: a later signal takes the default path again.
  close(): void {
    this.detach();
    if (this.deadline !== undefined) clearTimeout(this.deadline);
  }

  private trip(stop: GuardStop): void {
    this.firstStop ??= stop;
    this.cancel(
      turnAbort(
        stop.kind === 'interrupted' ? 'signal' : 'guard',
        guardStopMessage(stop),
      ),
    );
  }

  // The listeners detach at once, so a second Ctrl-C force-quits through
  // the default handler.
  private readonly onSignal = (signal: string): void => {
    this.detach();
    this.signalled ??= signal;
    this.onInterrupt();
    this.trip({ kind: 'interrupted', signal });
  };

  private detach(): void {
    if (!this.attached) return;
    this.attached = false;
    for (const name of INTERRUPT_SIGNALS) this.signals.off(name, this.onSignal);
  }
}
