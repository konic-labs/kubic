// Worker tool facts (EPIC N, issue #464; docs/ui 04-C, 04-D): the live
// channel a worker process reports its tool calls on, beside the readiness
// marker and the final `--json` report on the same stdout. The child prints
// one `KUBIC_WORKER_FACT <json>` line per tool start and end: the tool, a
// redacted one-line summary of its arguments and outcome (raw arguments
// never leave the worker) and, for an edit or write, the display diff.
//
// The manager follows the stream (`createFactScanner`): only complete lines
// past the last one it read, located through the accumulator's dropped
// count, so a capped stream is followed exactly. Each line parses closed
// world and bounded, and `batchFacts` delivers what arrived at most once
// per interval (≤ 10 batches a second per worker). The fact lines are
// protocol, not output: `stripFactLines` takes them out of the stdout the
// run reads its report and diagnostics from.

import type { WorkerToolActivity } from '../../../core/src/presentation.js';

export const FACT_PREFIX = 'KUBIC_WORKER_FACT';

/** Bounds a fact crosses the process boundary within. */
export const FACT_TEXT_MAX_CHARS = 200;
export const FACT_DIFF_MAX_CHARS = 20 * 1024;
/** One delivery per this many milliseconds, at most (≤ 10/s). */
export const FACT_INTERVAL_MS = 100;

const FACT_STATES: ReadonlySet<string> = new Set(['running', 'done', 'error']);
const FACT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'tool',
  'target',
  'state',
  'outcome',
  'diff',
  'at',
]);

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The line a worker prints for one fact (bounded before it crosses). */
export function factLine(fact: WorkerToolActivity): string {
  const wire: WorkerToolActivity = {
    id: bounded(fact.id, FACT_TEXT_MAX_CHARS),
    tool: bounded(fact.tool, FACT_TEXT_MAX_CHARS),
    ...(fact.target === undefined
      ? {}
      : { target: bounded(fact.target, FACT_TEXT_MAX_CHARS) }),
    state: fact.state,
    ...(fact.outcome === undefined
      ? {}
      : { outcome: bounded(fact.outcome, FACT_TEXT_MAX_CHARS) }),
    ...(fact.diff === undefined
      ? {}
      : {
          diff: {
            text: fact.diff.text.slice(0, FACT_DIFF_MAX_CHARS),
            ...(fact.diff.firstChangedLine === undefined
              ? {}
              : { firstChangedLine: fact.diff.firstChangedLine }),
          },
        }),
    at: fact.at,
  };
  // JSON escapes every newline, so a fact is always exactly one line.
  return `${FACT_PREFIX} ${JSON.stringify(wire)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const optionalText = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === 'string' && value.length <= FACT_TEXT_MAX_CHARS);

/**
 * One stdout line as a fact, or undefined. Closed world: an unknown key, a
 * wrong type or an over-bound field refuses the whole line — a line that
 * merely starts with the prefix never becomes a half-trusted fact.
 */
export function parseFactLine(line: string): WorkerToolActivity | undefined {
  if (!line.startsWith(`${FACT_PREFIX} `)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(FACT_PREFIX.length + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) => !FACT_KEYS.has(key))) return undefined;
  const { id, tool, target, state, outcome, diff, at } = value;
  if (typeof id !== 'string' || id === '' || id.length > FACT_TEXT_MAX_CHARS)
    return undefined;
  if (
    typeof tool !== 'string' ||
    tool === '' ||
    tool.length > FACT_TEXT_MAX_CHARS
  )
    return undefined;
  if (typeof state !== 'string' || !FACT_STATES.has(state)) return undefined;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  if (!optionalText(target) || !optionalText(outcome)) return undefined;
  let parsedDiff: WorkerToolActivity['diff'];
  if (diff !== undefined) {
    if (!isRecord(diff)) return undefined;
    const { text, firstChangedLine } = diff;
    if (
      Object.keys(diff).some(
        (key) => key !== 'text' && key !== 'firstChangedLine',
      )
    )
      return undefined;
    if (typeof text !== 'string' || text.length > FACT_DIFF_MAX_CHARS)
      return undefined;
    if (
      firstChangedLine !== undefined &&
      (typeof firstChangedLine !== 'number' ||
        !Number.isInteger(firstChangedLine))
    )
      return undefined;
    parsedDiff = {
      text,
      ...(firstChangedLine === undefined ? {} : { firstChangedLine }),
    };
  }
  return {
    id,
    tool,
    ...(target === undefined ? {} : { target: target as string }),
    state: state as WorkerToolActivity['state'],
    ...(outcome === undefined ? {} : { outcome: outcome as string }),
    ...(parsedDiff === undefined ? {} : { diff: parsedDiff }),
    at,
  };
}

/**
 * Follows one cumulative stream: each call takes the latest snapshot (and
 * how much of the stream's head the accumulator dropped), reads only the
 * complete lines past the last one read, and hands every fact among them to
 * `onFact`, in order. A trim that cut into unread output drops the cut line
 * and resumes at the next complete one.
 */
export function createFactScanner(
  onFact: (fact: WorkerToolActivity) => void,
): (text: string, dropped?: number) => void {
  // The stream position just past the last newline read.
  let consumed = 0;
  return (text, dropped = 0) => {
    let from = consumed - dropped;
    if (from < 0) {
      // The head we had not read yet is gone: skip the cut line.
      const cut = text.indexOf('\n');
      if (cut === -1) return;
      from = cut + 1;
    }
    const end = text.lastIndexOf('\n');
    if (end < from) return;
    for (const line of text.slice(from, end).split('\n')) {
      const fact = parseFactLine(line);
      if (fact !== undefined) onFact(fact);
    }
    consumed = dropped + end + 1;
  };
}

/** The stream with its fact lines taken out (they are protocol). */
export function stripFactLines(text: string): string {
  if (!text.includes(FACT_PREFIX)) return text;
  return text
    .split('\n')
    .filter((line) => !line.startsWith(`${FACT_PREFIX} `))
    .join('\n');
}

export interface FactBatcher {
  push(fact: WorkerToolActivity): void;
  /** Deliver what is pending now (the worker ended). */
  flush(): void;
}

export interface FactBatchOptions {
  readonly intervalMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/**
 * Batches facts: the first fact after a quiet interval goes out at once,
 * later ones wait for the interval to end and leave together — at most one
 * delivery per interval, nothing dropped, order kept.
 */
export function batchFacts(
  deliver: (facts: WorkerToolActivity[]) => void,
  options: FactBatchOptions = {},
): FactBatcher {
  const intervalMs = options.intervalMs ?? FACT_INTERVAL_MS;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      return timer;
    });
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let pending: WorkerToolActivity[] = [];
  let timer: unknown;
  const send = (): void => {
    if (pending.length === 0) return;
    const facts = pending;
    pending = [];
    deliver(facts);
  };
  const open = (): void => {
    timer = setTimer(() => {
      timer = undefined;
      if (pending.length === 0) return;
      send();
      open();
    }, intervalMs);
  };
  return {
    push(fact) {
      pending.push(fact);
      if (timer !== undefined) return;
      send();
      open();
    },
    flush() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      send();
    },
  };
}
