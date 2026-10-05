// Shared fake Terminal for headless TUI tests (issue #403; consolidation in
// #321): writes + start/stop counters, a mutable size, a resize trigger and
// an input injector, so no test needs its own copy or a timing sleep to read
// back what the TUI drew.
//
// It lives at the repo root because `packages/tui` and `packages/host` tests
// both import it: `host -> tui` is a forbidden dependency edge
// (`npm run lint:deps`), so a `packages/tui/src/test-support` module could
// never be the one fake. Root `test/` is also outside the reachability gate's
// scope (`packages/*/src`, `apps/*/src`), so a test-only helper needs no
// dead-surface ledger row.
//
// The `Terminal` type comes from the presentation boundary, not from
// `@earendil-works/*` directly: only `tui-boundary.ts` may touch Pi.
import type { Terminal } from '../packages/tui/src/tui-boundary.js';

export interface FakeTerminal extends Terminal {
  /** One entry per write() call, in order. */
  writes: string[];
  /** Every write joined — the whole terminal output as one string. */
  output: () => string;
  /** How many times the TUI entered the terminal (start() calls). */
  started: number;
  /** How many times the TUI left the terminal (stop() calls). */
  stopped: number;
  /** Change the size the TUI reads back; fire it with resize(). */
  setSize: (columns: number, rows: number) => void;
  /** Deliver a resize event to the handler registered in start(). */
  resize: () => void;
  /** Feed raw terminal input (keystrokes, mouse sequences) to the TUI. */
  inject: (data: string) => void;
  /** Alias of inject(), the name most TUI tests use. */
  feed: (data: string) => void;
  /** How many times the TUI drained pending input (drainInput() calls). */
  drained: number;
}

/**
 * Optional observers for tests that need more than the record: each hook runs
 * inside the matching Terminal call, before the fake's own bookkeeping, so a
 * hook can log the call order (terminal-restore tests) or throw to simulate a
 * failing terminal (an onWrite that throws aborts that write).
 */
export interface FakeTerminalHooks {
  onStart?: (input: (data: string) => void) => void;
  onStop?: () => void;
  onDrain?: () => void;
  onWrite?: (data: string) => void;
}

export function fakeTerminal(
  columns = 100,
  rows = 30,
  hooks: FakeTerminalHooks = {},
): FakeTerminal {
  const writes: string[] = [];
  let onInput: ((data: string) => void) | undefined;
  let onResize: (() => void) | undefined;
  const terminal: FakeTerminal = {
    writes,
    output: () => writes.join(''),
    started: 0,
    stopped: 0,
    drained: 0,
    start: (input, resize) => {
      hooks.onStart?.(input);
      terminal.started += 1;
      onInput = input;
      onResize = resize;
    },
    stop: () => {
      hooks.onStop?.();
      terminal.stopped += 1;
    },
    drainInput: () => {
      hooks.onDrain?.();
      terminal.drained += 1;
      return Promise.resolve();
    },
    write: (data: string) => {
      hooks.onWrite?.(data);
      writes.push(data);
    },
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    setSize: (nextColumns, nextRows) => {
      columns = nextColumns;
      rows = nextRows;
    },
    resize: () => {
      onResize?.();
    },
    inject: (data: string) => {
      onInput?.(data);
    },
    feed: (data: string) => {
      onInput?.(data);
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
  return terminal;
}

/**
 * The shape most host/app TUI tests destructure: the fake Terminal plus its
 * write log, live start/stop/drain counts, an input feeder and frame readers.
 * A thin view over one fakeTerminal() — never a second implementation.
 */
export interface TerminalRig {
  terminal: FakeTerminal;
  writes: string[];
  counts: {
    readonly started: number;
    readonly stopped: number;
    readonly drained: number;
  };
  feed: (data: string) => void;
  /** Everything written so far, as one string. */
  readonly frame: string;
  /** A position in the write log, for since(). */
  mark: () => number;
  /** Everything written after a mark(). */
  since: (mark: number) => string;
}

export function terminalRig(
  columns = 100,
  rows = 30,
  hooks: FakeTerminalHooks = {},
): TerminalRig {
  const terminal = fakeTerminal(columns, rows, hooks);
  return {
    terminal,
    writes: terminal.writes,
    counts: {
      get started() {
        return terminal.started;
      },
      get stopped() {
        return terminal.stopped;
      },
      get drained() {
        return terminal.drained;
      },
    },
    feed: terminal.feed,
    get frame() {
      return terminal.output();
    },
    mark: () => terminal.writes.length,
    since: (mark) => terminal.writes.slice(mark).join(''),
  };
}
