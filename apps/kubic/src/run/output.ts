// What a `kubic run` says while it runs: the debug channel, the warning and
// notice lines, the no-isolation notice, and the summary the result reports.
import type { KubicLaneEvent } from '@kubic/agent/lane/events';
import type { RetryDecision } from '@kubic/agent/lane/failures';
import type { TranscriptItem } from '@kubic/agent/lane/transcript';
import { emitNoIsolationNotice, shouldEmitNotice } from '@kubic/host/doctor';
import {
  type DebugSink,
  hookErrorLine,
  modelLine,
  type RunProgressSink,
} from '@kubic/host/run';
import { redactingSink } from '@kubic/host/secret-refs';
import type { HeadlessRunDeps, HeadlessRunOptions } from './options.js';

export interface RunSinks {
  // The span lines' sink: set only under `--debug`.
  debugSink?: DebugSink;
  // The run's diagnostics (extension receipt, reconcile/overlap notices,
  // skill-load reports, drain failures), redacted of live provider keys.
  debug?: (line: string) => void;
  // User-facing warnings that show without --debug.
  warn: (line: string) => void;
  // Operator notices: a model switched or kept at boot, a pending
  // operation's settlement, an overflow recovery.
  notice: (line: string) => void;
}

export function runSinks(
  options: HeadlessRunOptions,
  deps: HeadlessRunDeps,
  liveSecrets: () => string[],
): RunSinks {
  // Debug channel: `--debug` routes the span lines AND the run's
  // diagnostics to one sink. An injected deps.debug still wins; without
  // either, the diagnostics are off.
  const debugSink: DebugSink | undefined =
    options.debug === true
      ? (deps.debugSink ?? ((line: string) => console.error(line)))
      : undefined;
  // The vocabulary is closed: a diagnostic without its own class rides
  // the sink as `[session]`.
  // Every resolved provider key is redacted from the debug
  // channel — the values are known only once the resolver has run, so the
  // redaction reads them at emit time.
  const rawDebug: ((line: string) => void) | undefined =
    deps.debug ??
    (debugSink === undefined
      ? undefined
      : (line: string) =>
          debugSink(/^\[[a-z]+\]/.test(line) ? line : `[session] ${line}`));
  return {
    ...(debugSink === undefined ? {} : { debugSink }),
    ...(rawDebug === undefined
      ? {}
      : { debug: redactingSink(rawDebug, liveSecrets) }),
    warn: deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)),
    notice: deps.notice ?? ((line: string) => console.error(line)),
  };
}

// The no-isolation notice: the trust model is announced on
// stderr before the first turn, once per process start, using the module
// strings verbatim so `kubic tui` reads identically. Suppressed by the
// documented KUBIC_NO_NOTICE opt-out. stderr, never stdout: `--json`
// stays parseable.
// With a progress sink the notice is its compact one-liner,
// printed by `progress.begin` once the lane has booted (still before the
// first turn); the three-line block stays for every other run. Returns
// whether the notice is due.
export function announceNoIsolation(
  progress: RunProgressSink | undefined,
): boolean {
  const due = shouldEmitNotice(process.env);
  if (due && progress === undefined) {
    emitNoIsolationNotice((line) => process.stderr.write(`${line}\n`));
  }
  return due;
}

// The user-facing overflow line must tell the truth.
// The decision hook fires for every decision (including abandon), but
// only a retry_with_new_context compacts and retries — anything else
// stays silent, and the failure terminus already reports the failure.
export function overflowRecoveryNotice(
  decision: RetryDecision,
): string | undefined {
  if (decision.decision !== 'retry_with_new_context') return undefined;
  return `context overflow — compacting and retrying once (${decision.reason})`;
}

// The named non-answer a completed run with no assistant text reports: the
// summary is the model's own output or this sentence — never the operator's
// prompt echoed back as if it were a result.
export const NO_ASSISTANT_TEXT_SUMMARY =
  '(no assistant text — the run settled without output)';

// Final assistant text of the settled run for the result summary. A run
// that left no assistant text yields undefined; the caller reports the
// named non-answer (NO_ASSISTANT_TEXT_SUMMARY) instead of the prompt.
// Takes the shared transcript: newest assistant item wins.
export function assistantSummary(
  items: readonly TranscriptItem[],
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || item.kind !== 'assistant') continue;
    const text = item.text.trim();
    if (text === '') continue;
    return text.slice(0, 500);
  }
  return undefined;
}

// The `[lane]` debug line for a retry or compaction event, or
// undefined for any other event. The 1.0 harness reports the attempt and the
// error (the contract — no maxAttempts, no notBefore).
// A lane fault (pi-durable `task_failed` — Pi 1.0 has no
// `handler_error` event) maps to the handler_error line, and a
// committed response maps to the [model] token line. Both reuse the
// spans vocabulary formatters, so every path emits byte-identical lines.
export function laneActivityDebugLine(
  event: KubicLaneEvent,
): string | undefined {
  if (event.type === 'fault') {
    return hookErrorLine(event.code, event.message);
  }
  if (event.type === 'usage') {
    return modelLine(
      event.row.usage.input,
      event.row.usage.output,
      event.row.usage.cacheRead,
      `${event.row.provider}/${event.row.model}`,
    );
  }
  if (event.type === 'retry') {
    const attempt = event.attempt ?? 1;
    return event.phase === 'start'
      ? `[lane] retry attempt ${attempt} after error: ${event.error ?? 'unknown'}`
      : `[lane] retry attempt ${attempt} settled`;
  }
  if (event.type === 'compaction') {
    const reason = event.reason === undefined ? '' : ` (${event.reason})`;
    return event.phase === 'start'
      ? `[lane] compaction started${reason}`
      : `[lane] compaction finished${reason}`;
  }
  return undefined;
}
