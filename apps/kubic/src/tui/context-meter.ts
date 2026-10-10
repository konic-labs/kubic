// The context gauge's reading. Every commit can change what the next request
// carries (a response, a tool result, a prompt, a compaction summary), so the
// root asks for a fresh measure after each one, at boot and after a session
// switch. The gauge then moves while a turn runs instead of waiting for the
// next response to report its usage.
import type { TuiContext } from './context.js';

export interface ContextMeterOptions {
  // One measure. `undefined` means there is nothing to show (no live lane, or
  // the session it measured is no longer the one on screen).
  readonly read: () => Promise<number | undefined>;
  readonly apply: (tokens: number) => void;
}

// One read runs at a time: the requests that land while it is in flight fold
// into one more read after it, so a burst of tool results costs two reads,
// not one per result. A failed read keeps the last reading; the next commit
// asks again.
export class ContextMeter {
  private readonly read: ContextMeterOptions['read'];
  private readonly apply: ContextMeterOptions['apply'];
  private running: Promise<void> | undefined;
  private stale = false;

  constructor(options: ContextMeterOptions) {
    this.read = options.read;
    this.apply = options.apply;
  }

  // Resolves once a read that started after this request has landed. It
  // never rejects, so callers may drop the promise.
  request(): Promise<void> {
    this.stale = true;
    this.running ??= this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.stale) {
      this.stale = false;
      try {
        const tokens = await this.read();
        if (tokens !== undefined) this.apply(tokens);
      } catch {
        // A storage closing under a quit, or a torn entry: keep the reading.
      }
    }
    this.running = undefined;
  }
}

// The meter over the CURRENT boot's lane, built once per screen. A reading
// that resolves after `/new`, `/resume` or `/fork` replaced the boot belongs
// to the session that was left, so it is dropped.
export function contextMeter(ctx: TuiContext): ContextMeter {
  return new ContextMeter({
    read: async () => {
      const boot = ctx.boot;
      const loop = boot.loop;
      if (loop?.contextTokens === undefined) return undefined;
      const tokens = await loop.contextTokens(loop.context);
      return ctx.boot === boot ? tokens : undefined;
    },
    apply: (tokens) => {
      ctx.app.setContextTokens(tokens);
      if (!ctx.stopped) ctx.screen?.update();
    },
  });
}
