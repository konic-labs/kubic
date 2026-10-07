// A TTY-only spinner for CLI progress. On a stream
// that is not a TTY every method is a no-op, so pipes, files and CI logs
// never see a carriage return or an escape code. On a TTY it redraws one
// line in place (`\r` + erase line), hides the cursor while spinning, and
// restores it on stop and on process exit.

import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from '../ui/glyphs.js';
import type { CliTheme } from './theme.js';

export interface SpinnerStream {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface Spinner {
  /** True while the spinner owns the current line. */
  readonly active: boolean;
  /** Start (or restart) spinning with this text. */
  start(text: string): void;
  /** Replace the text next to the spinner. */
  update(text: string): void;
  /** Print a settled line above the spinner and keep spinning. */
  print(line: string): void;
  /** Stop and leave `line` in place of the spinner (nothing when omitted). */
  stop(line?: string): void;
}

export interface SpinnerOptions {
  readonly intervalMs?: number;
  /** Process hooks; injectable for tests. */
  readonly onExit?: (restore: () => void) => () => void;
}

const ESC = '\u001b';
const CLEAR_LINE = `\r${ESC}[2K`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

function defaultOnExit(restore: () => void): () => void {
  process.once('exit', restore);
  return () => {
    process.removeListener('exit', restore);
  };
}

const NOOP_SPINNER: Spinner = {
  active: false,
  start: () => {},
  update: () => {},
  print: () => {},
  stop: () => {},
};

export function createSpinner(
  stream: SpinnerStream,
  theme: CliTheme,
  options: SpinnerOptions = {},
): Spinner {
  if (stream.isTTY !== true) return NOOP_SPINNER;
  const intervalMs = options.intervalMs ?? SPINNER_INTERVAL_MS;
  const onExit = options.onExit ?? defaultOnExit;
  const frameStyle = theme.ui.fg('accent');
  let text = '';
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let removeExitHook: (() => void) | undefined;

  const draw = (): void => {
    const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '';
    stream.write(`${CLEAR_LINE}${frameStyle(glyph)} ${text}`);
  };
  const restoreCursor = (): void => {
    stream.write(SHOW_CURSOR);
  };
  const halt = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    removeExitHook?.();
    removeExitHook = undefined;
  };

  return {
    get active(): boolean {
      return timer !== undefined;
    },
    start(next: string): void {
      text = next;
      if (timer === undefined) {
        stream.write(HIDE_CURSOR);
        removeExitHook = onExit(restoreCursor);
        timer = setInterval(() => {
          frame += 1;
          draw();
        }, intervalMs);
        timer.unref?.();
      }
      draw();
    },
    update(next: string): void {
      text = next;
      if (timer !== undefined) draw();
    },
    print(line: string): void {
      if (timer === undefined) {
        stream.write(`${line}\n`);
        return;
      }
      stream.write(`${CLEAR_LINE}${line}\n`);
      draw();
    },
    stop(line?: string): void {
      if (timer === undefined) {
        if (line !== undefined) stream.write(`${line}\n`);
        return;
      }
      halt();
      stream.write(CLEAR_LINE);
      if (line !== undefined) stream.write(`${line}\n`);
      restoreCursor();
    },
  };
}
