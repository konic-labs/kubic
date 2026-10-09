// `/compact` as a turn driver: Pi's manual compaction under the same
// busy/cancel/quit-drain contract a prompt turn has.
import type { ManualCompactionOutcome } from '@kubic/agent/compaction';
import type { TuiLaneLoop, TuiTurnDriver, TuiTurnOutcome } from './types.js';

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
