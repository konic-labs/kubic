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
}

export function fakeTerminal(columns = 100, rows = 30): FakeTerminal {
  const writes: string[] = [];
  let onInput: ((data: string) => void) | undefined;
  let onResize: (() => void) | undefined;
  const terminal: FakeTerminal = {
    writes,
    output: () => writes.join(''),
    started: 0,
    stopped: 0,
    start: (input, resize) => {
      terminal.started += 1;
      onInput = input;
      onResize = resize;
    },
    stop: () => {
      terminal.stopped += 1;
    },
    drainInput: () => Promise.resolve(),
    write: (data: string) => {
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
