// The journal panels' feed, and the `/diff` and `/undo` commands.
import type { JournalChangeLike } from '@kubic/tui/tui-app';

// The inspectable pair reads the session journal through
// the SAME projection `kubic diff` uses (diffEntries: one change per path,
// latest attribution). Reads are throttled like the transcript refresh: a
// burst of tool-end events collapses into one read per window, and a
// settlement (or the boot) reads at once. A read failure never reaches the
// loop — the panels keep their last rows.
const JOURNAL_REFRESH_MS = 100;

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
