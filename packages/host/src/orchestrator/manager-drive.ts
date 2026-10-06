// The manager drive loop's safety gear (issue #431, step 7 of the #204
// split): the tool-call bound wrapper, the named bound error, and the
// final-message reader. The router (`runOrchestrateCommand`) wraps the
// lane's real adapters with `withManagerToolCallBound` before booting:
// past the bound every call trips `onTrip` (the router records the trip),
// aborts the live submission (so a model that keeps calling on refusals
// still ends), and throws the named refusal the model reads. The
// submission-iteration bound lives in the router itself (one submit→wait
// per iteration); both termini share the one code below.
import type {
  EntryRecord,
  ToolRegistration,
} from '../../../worker/src/pi-boundary.js';
import {
  QUESTION_UNANSWERED_CODE,
  type WorkerQuestionOutcome,
} from './approvals/worker-questions.js';
import type { ManagerToolset } from './manager-tools.js';
import { ManagerToolRefusalError } from './manager-tools.js';

/** The tool-call backstop: generous, deterministic, documented. */
export const MANAGER_MAX_TOOL_CALLS = 200;
/** The submit→wait backstop: a healthy run finishes in two or three. */
export const MANAGER_MAX_SUBMISSIONS = 10;

/** The one code both drive bounds end the run with. */
export const MANAGER_TURN_BOUND_CODE = 'manager_turn_bound';

export class ManagerTurnBoundError extends ManagerToolRefusalError {
  constructor(calls: number, max: number) {
    super(
      MANAGER_TURN_BOUND_CODE,
      `manager turn bound exceeded: ${calls} tool calls past the ${max}-call backstop — stopping the manager lane`,
    );
  }
}

export interface ManagerToolCallBound {
  maxToolCalls: number;
  /** The router records the trip (the run ends `manager_turn_bound`). */
  onTrip(): void;
  /**
   * Abort the live submission, fire-and-forget safe: past the bound the
   * model may keep calling on refusals, so the trip also ends the
   * submission from the outside. Safe to call with no live submission.
   */
  abortCurrent(): void;
}

function withBound(
  tool: ToolRegistration,
  state: { calls: number },
  bound: ManagerToolCallBound,
): ToolRegistration {
  const execute = tool.execute;
  if (execute === undefined) return tool;
  return {
    ...tool,
    execute: async (args, api, callContext) => {
      state.calls += 1;
      if (state.calls > bound.maxToolCalls) {
        bound.onTrip();
        bound.abortCurrent();
        throw new ManagerTurnBoundError(state.calls, bound.maxToolCalls);
      }
      return execute(args, api, callContext);
    },
  };
}

/**
 * Wrap every adapter of the lane toolset with the tool-call bound. Counts
 * executions, not turns: every attempt counts, even one the adapter
 * refuses (a refusal loop is still a loop). The counter is per wrap, so
 * one drive loop owns exactly one count.
 */
export function withManagerToolCallBound(
  tools: ManagerToolset,
  bound: ManagerToolCallBound,
): ManagerToolset {
  const state = { calls: 0 };
  return {
    ...tools,
    spawnAgent: withBound(tools.spawnAgent, state, bound),
    waitForAgent: withBound(tools.waitForAgent, state, bound),
    collectResult: withBound(tools.collectResult, state, bound),
    inspectAgent: withBound(tools.inspectAgent, state, bound),
    cancelAgent: withBound(tools.cancelAgent, state, bound),
    sendToAgent: withBound(tools.sendToAgent, state, bound),
    workspaceDiff: withBound(tools.workspaceDiff, state, bound),
    workspaceApply: withBound(tools.workspaceApply, state, bound),
    workspaceMerge: withBound(tools.workspaceMerge, state, bound),
    askUser: withBound(tools.askUser, state, bound),
    gitStatus: withBound(tools.gitStatus, state, bound),
    gitDiff: withBound(tools.gitDiff, state, bound),
    gitLog: withBound(tools.gitLog, state, bound),
  };
}

/**
 * Race one seat ask against the deps bound (issue #431, #417 review gap):
 * the adapter carries no timeout of its own, so the ROUTER keeps the
 * bound here — a hanging prod seat resolves unanswered instead of hanging
 * the turn. The bound elapsing is reported with the seat's own code, so
 * the manager cannot tell a slow seat from an absent one (and need not).
 */
export function withAskTimeout(
  seat: Promise<WorkerQuestionOutcome>,
  boundMs: number,
): Promise<WorkerQuestionOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<WorkerQuestionOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        answered: false,
        code: QUESTION_UNANSWERED_CODE,
        reason: `no answer within ${boundMs}ms (the ask bound elapsed)`,
      });
    }, boundMs);
  });
  return Promise.race([seat, bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Assert a model-supplied base names a git ref (issue #431, #416 review
 * gap 1): the `readWorkerChange` seam validates BEFORE the base reaches
 * git. A leading dash would be parsed as a flag; `..`, `@{`, spaces and
 * the rest are not refs. Throws the adapter's `invalid_args` refusal.
 */
export function assertGitRef(base: string): void {
  const bad =
    base === '' ||
    base.startsWith('-') ||
    base.startsWith('.') ||
    base.endsWith('.') ||
    base.endsWith('/') ||
    base.endsWith('.lock') ||
    base.includes('..') ||
    base.includes('@{');
  // `~^:` stay legal (HEAD~1, HEAD^, HEAD:path are revisions the diff
  // accepts); `?*[]\` never name a ref, and a space never does either.
  const controls = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(32)}?*\\[\\]${String.fromCharCode(127)}]`,
  );
  if (bad || controls.test(base)) {
    throw new ManagerToolRefusalError(
      'invalid_args',
      `not a git ref: '${base}' — the base names a revision, never a flag or a path expression`,
    );
  }
}

/** The envelope's `result:` line budget: one line, never a wall. */
export const MANAGER_FINAL_MESSAGE_MAX_CHARS = 500;

/**
 * The manager's final message: the last assistant text in the lane
 * transcript, whitespace-collapsed and capped. Undefined when the lane
 * never spoke (no text to carry into the envelope — the mechanical line
 * stays). Control characters go (the envelope line must be one clean
 * line); the text is the manager's own words, verbatim otherwise.
 */
export function managerFinalMessage(
  entries: readonly EntryRecord[],
): string | undefined {
  let last: string | undefined;
  for (const entry of entries) {
    const messages = entry.model as
      | Array<{
          role?: string;
          content?: Array<{ type?: string; text?: string }> | string;
        }>
      | undefined;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (message?.role !== 'assistant') continue;
      const content = message.content;
      const text = Array.isArray(content)
        ? content
            .map((part) => (part?.type === 'text' ? (part.text ?? '') : ''))
            .join('')
        : typeof content === 'string'
          ? content
          : '';
      if (text.trim() !== '') last = text;
    }
  }
  if (last === undefined) return undefined;
  // No control-character regex literals (biome): the class is built from
  // char codes, like the transcript strip in sessions-cli.
  const controls = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`,
    'g',
  );
  const collapsed = last.replace(controls, ' ').replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.length <= MANAGER_FINAL_MESSAGE_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, MANAGER_FINAL_MESSAGE_MAX_CHARS)}…`;
}

/**
 * The lane's fail-fast gear (issue #431, L-D34): an unreachable manager
 * provider ends the run with the named `lane_provider_unreachable` reason —
 * never a hang inside durable retries. Two triggers feed the one code: a
 * bounded drive deadline (the whole drive, wall-clock) and transport-error
 * classification of a submit/wait rejection.
 */
export const LANE_PROVIDER_UNREACHABLE_CODE = 'lane_provider_unreachable';

/**
 * Default wall-clock bound for one lane drive (issue #431): ten minutes —
 * long enough for a real multi-turn drive, bounded so a black-hole provider
 * cannot hang the run past it. Tests inject a smaller bound; the deadline
 * is a drive total, not a per-turn limit.
 */
export const MANAGER_DRIVE_DEADLINE_MS = 10 * 60 * 1000;

/** Thrown when a submission wait outlives the drive deadline. */
export class LaneDriveTimeoutError extends Error {
  readonly boundMs: number;
  constructor(boundMs: number) {
    super(
      `the manager provider did not answer within the drive deadline (${boundMs}ms)`,
    );
    this.name = 'LaneDriveTimeoutError';
    this.boundMs = boundMs;
  }
}

// Syscall codes and message shapes that name the network, never the model:
// a refused/unresolved/reset connection, a hung socket, a failed fetch
// (undici wraps the syscall in `cause`, so the chain is walked one level).
const LANE_TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
]);
const LANE_TRANSPORT_MESSAGE = new RegExp(
  [
    'fetch failed',
    'socket hang up',
    'network unreachable',
    'connection refused',
    'connection reset',
    'connection timed out',
    'getaddrinfo',
    'tls handshake',
    // Anchored TLS shapes (review #431): bare 'certificate' matched any
    // message containing the word (e.g. a credential-config error).
    'certificate verify failed',
    'self-signed certificate',
    'unable to verify the first certificate',
    'certificate has expired',
  ].join('|'),
  'i',
);

function laneTransportText(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (
    typeof record.code === 'string' &&
    LANE_TRANSPORT_CODES.has(record.code)
  ) {
    return record.code;
  }
  if (
    typeof record.message === 'string' &&
    LANE_TRANSPORT_MESSAGE.test(record.message)
  ) {
    return record.message;
  }
  if (typeof record.cause === 'object' && record.cause !== null) {
    return laneTransportText(record.cause);
  }
  return undefined;
}

/** True when the rejection names the network (a transport), never the model. */
export function isLaneTransportError(error: unknown): boolean {
  return laneTransportText(error) !== undefined;
}

/**
 * The one-line transport account for the refusal, or undefined when the
 * error is not a transport (model answers, usage errors and aborts pass
 * through to their own handling — never misclassified as unreachable).
 */
export function describeLaneTransportError(error: unknown): string | undefined {
  const text = laneTransportText(error);
  if (text === undefined) return undefined;
  return `the manager provider is unreachable (${text})`;
}

/**
 * Race a submission wait against the drive deadline's remainder: a wait that
 * outlives it aborts the submission (best-effort — an abort rejection never
 * masks the timeout) and rejects with `LaneDriveTimeoutError`. A wait that
 * settles in time passes through untouched.
 */
export async function waitLaneSubmissionWithDeadline<T>(
  wait: Promise<T>,
  options: {
    remainingMs: number;
    onTimeout: () => Promise<unknown>;
  },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => {
          void (async () => {
            try {
              await options.onTimeout();
            } catch {
              // The abort is best-effort: the timeout, not the abort's
              // outcome, is what the drive reports.
            }
            reject(new LaneDriveTimeoutError(options.remainingMs));
          })();
        },
        Math.max(0, options.remainingMs),
      );
      wait.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
