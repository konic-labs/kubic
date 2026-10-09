// The process lifecycle of `kubic tui`: signals, the fatal handler and the
// bounded quit drain.
import type { ExitCode } from '@kubic/core/cli/exit-codes';
import { INTERRUPT_EXIT_CODES } from '@kubic/core/cli/exit-codes';
import type { TuiSignal } from './types.js';

export const TUI_SIGNALS: readonly TuiSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
];
export const TUI_FATAL_EVENTS = [
  'uncaughtException',
  'unhandledRejection',
] as const;

// A signalled quit exits 128+signo (SIGHUP 129, SIGINT 130,
// SIGTERM 143) — the shell convention, so a supervisor can tell a signalled
// TUI from a clean quit.
export function signalExitCode(signal: TuiSignal): ExitCode {
  return INTERRUPT_EXIT_CODES[signal];
}

// How long a quit waits for an aborted turn to settle. The kills
// have already run by then; the wait only lets the lane record its terminal
// status and the killed tool finish its last write before the sweep.
export const TUI_DRAIN_TIMEOUT_MS = 3000;

export function defaultDrainTimer(ms: number, fire: () => void): () => void {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
}
