// Kubic compaction policy on the pi-durable mechanism.
//
// Pi owns the mechanism: the threshold and overflow checks, the summarization
// request, the `pi.compaction` entry, output bounds and spill files. Kubic
// owns the policy numbers Pi reads and the compact prompt:
// - `compactionSettings` builds the `HarnessSettings.compaction` Kubic
//   hands the harness. HarnessSettings are read at every use and never copied,
//   so `reserveTokens` and `keepRecentTokens` are LIVE getters over the current
//   model's window: a `configure({ model })` switch re-clamps both with no
//   explicit re-clamp step. A pending manual compaction narrows the keep window
//   through the lane's `ManualKeepScope`.
// - `runManualCompaction` admits Pi's compaction task with Kubic's compact
//   prompt as the summarizer instructions, then runs it to its outcome.
//   `runCompactCommand` is the user's `/compact`, which also holds the manual
//   keep window while the task is pending.
//
// The rest of this module is pure policy and formatting. The seam types are
// type-only imports (erased), no Pi runtime import, no network, no filesystem.

import type {
  CompactionPolicy,
  CompactionResult,
  Context,
  Conversation,
  Harness,
  TaskId,
} from './pi-boundary.js';
import { estimateContextTokens } from './pi-boundary.js';

export const DEFAULT_RESERVE_TOKENS = 16384;

// A reserve may take at most this share of the window. Without the clamp a
// window at or below the reserve (an 8192-token local model vs the 16384
// default) puts the threshold at or below zero and every turn compacts.
// Pi has no equivalent clamp; this is Kubic policy.
/** @internal */
export const MAX_RESERVE_FRACTION = 0.25;

export function effectiveReserveTokens(
  contextWindow: number,
  reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): number {
  if (!(contextWindow > 0)) return reserveTokens;
  return Math.min(
    reserveTokens,
    Math.floor(contextWindow * MAX_RESERVE_FRACTION),
  );
}

// Roughly how much recent context stays verbatim. 20000 matches
// pi-durable's own default (pi-durable's `keepRecentTokens`).
export const KEEP_RECENT_TOKENS = 20000;

// The kept window takes at most this share of the room below the reserve
// (window - reserve). The system prompt and the tool definitions sit in the
// same transcript and count toward the threshold: on an 8k window they take
// about 2.8k of the 6.1k blocking threshold, so a larger share would leave no
// room for the next exchange after a compaction.
/** @internal */
export const MAX_KEEP_RECENT_FRACTION = 0.25;

/**
 * The kept window for a model window: the configured keep-recent figure, capped
 * to `MAX_KEEP_RECENT_FRACTION` of the room below the reserve. Pi's cut
 * selection needs that much history before it can cut. With a fixed 20000 kept
 * window, a window under about 23k overflows before it holds 20000 tokens of
 * history, so the overflow path never cuts there. The threshold path cuts only
 * from about 30k, since the threshold must leave 20000 tokens of history below
 * it beside the system entry. An unknown window keeps the configured figure,
 * as the reserve does.
 */
/** @internal */
export function effectiveKeepRecentTokens(
  contextWindow: number,
  keepRecentTokens: number = KEEP_RECENT_TOKENS,
  reserveTokens: number = DEFAULT_RESERVE_TOKENS,
): number {
  if (!(contextWindow > 0)) return keepRecentTokens;
  const room =
    contextWindow - effectiveReserveTokens(contextWindow, reserveTokens);
  return Math.min(
    keepRecentTokens,
    Math.floor(room * MAX_KEEP_RECENT_FRACTION),
  );
}

// The system entry of Kubic's default boot, in pi-ai's estimate: the
// prompt section plus the 18 default tool declarations (about 2800 tokens).
// The room estimate below and `kubic doctor` use it; a test pins it to the
// real boot, so a prompt or tool-set change moves the figure with it.
/** @internal */
export const SYSTEM_ENTRY_ESTIMATE = 2822;

// A planning figure for one summary, in estimated tokens. Pi's own budget for a
// summary is 0.8 of the reserve; a typical summary is far shorter.
const SUMMARY_ESTIMATE = 800;

/**
 * The room a compaction leaves for the next exchange: the window, less its
 * reserve, the system entry, the kept window and a typical summary. A room
 * below about 4k tokens means compaction runs every turn or two.
 */
export function roomAfterCompaction(
  contextWindow: number,
  reserveTokens: number = DEFAULT_RESERVE_TOKENS,
  keepRecentTokens: number = KEEP_RECENT_TOKENS,
): number {
  return (
    contextWindow -
    effectiveReserveTokens(contextWindow, reserveTokens) -
    SYSTEM_ENTRY_ESTIMATE -
    effectiveKeepRecentTokens(contextWindow, keepRecentTokens, reserveTokens) -
    SUMMARY_ESTIMATE
  );
}

// The user's `/compact` keeps about this much recent context verbatim (or the
// effective window, when that is smaller), cut at a message boundary. The user
// asked for a compaction, so the kept window is deliberately small.
/** @internal */
export const MANUAL_KEEP_RECENT_TOKENS = 2000;

/**
 * The manual compaction scope of one lane. The user's `/compact` holds it from
 * before its admission until the task settles. While it is held, the keep getter
 * reads `MANUAL_KEEP_RECENT_TOKENS`, so pi-durable's cut selection for that task
 * sees the smaller window. A threshold check during the same span uses it too,
 * which is harmless: the user asked for a compaction.
 */
export interface ManualKeepScope {
  /** True while at least one manual compaction is pending. */
  readonly active: boolean;
  /** Marks one manual compaction pending. The returned release is idempotent. */
  open(): () => void;
}

export function createManualKeepScope(): ManualKeepScope {
  let pending = 0;
  return {
    get active() {
      return pending > 0;
    },
    open() {
      pending += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending -= 1;
      };
    },
  };
}

// Kubic owns the trigger: exactly one threshold (contextTokens above
// contextWindow - reserveTokens) starts a summarization. pi-durable's own
// default (32768) also starts a background compaction that far BELOW the
// blocking threshold, i.e. a speculative summary model call before the
// reserved room is needed. Kubic pins it off so the reserved room is the only
// trigger — the behaviour the lane had before the Pi 1.0 migration — and
// so a session that ends early never pays for a summary nobody needed. A
// caller that wants the head start can still pass an explicit value.
/** @internal */
export const BACKGROUND_TOKENS = 0;

export interface CompactionSettingsOptions {
  enabled?: boolean;
  configuredReserveTokens?: number;
  keepRecentTokens?: number;
  backgroundTokens?: number;
  /** Window of the conversation's CURRENT model; undefined when unknown. */
  currentWindow: () => number | undefined;
  /** The lane's manual-compaction scope; absent when the lane has none. */
  manualKeep?: ManualKeepScope;
}

/**
 * The `settings.compaction` Kubic hands the harness.
 *
 * HarnessSettings are harness-wide and read at every use, so the process
 * (one active conversation) satisfies the live getters with that
 * conversation's current model window. `reserveTokens` and `keepRecentTokens`
 * are getters for exactly that reason: the harness reads them at each
 * threshold check, overflow decision, cut selection and summarization request,
 * so a model switch follows without any re-clamp call (Pi 1.0 has none).
 */
export function compactionSettings(
  options: CompactionSettingsOptions,
): Partial<CompactionPolicy> {
  const configured = options.configuredReserveTokens ?? DEFAULT_RESERVE_TOKENS;
  const configuredKeep = options.keepRecentTokens ?? KEEP_RECENT_TOKENS;
  return {
    enabled: options.enabled ?? true,
    backgroundTokens: options.backgroundTokens ?? BACKGROUND_TOKENS,
    // A window of 0/undefined (model unknown) has nothing to clamp against:
    // effectiveReserveTokens returns the configured reserve.
    get reserveTokens() {
      return effectiveReserveTokens(options.currentWindow() ?? 0, configured);
    },
    get keepRecentTokens() {
      const keep = effectiveKeepRecentTokens(
        options.currentWindow() ?? 0,
        configuredKeep,
        configured,
      );
      return options.manualKeep?.active === true
        ? Math.min(keep, MANUAL_KEEP_RECENT_TOKENS)
        : keep;
    },
  };
}

export function parseCompactCommand(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '/compact') return '';
  if (trimmed.startsWith('/compact ')) return trimmed.slice('/compact '.length);
  throw new CompactionError(`not a /compact command: '${input}'`);
}

class CompactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompactionError';
  }
}

/** @internal */
export interface CompactPromptInput {
  focus?: string;
  extraSections?: string[];
}

// /compact [instructions]: caller focus instructions ride verbatim in
// the summary prompt; empty focus builds the instruction-free prompt. Pi's own
// summarization prompt already defines the summary's sections, so the line only
// names the ones a session has.
/** @internal */
export function buildCompactPrompt(input: CompactPromptInput): string {
  const sections = [
    'Summarize this session for compaction: goal, decisions, open work, next steps.',
  ];
  const focus = (input.focus ?? '').trim();
  if (focus.length > 0) sections.push(`focus: ${focus}`);
  sections.push(...(input.extraSections ?? []));
  return sections.join('\n');
}

/**
 * The half of the `Lane` compaction needs: the structural twin of
 * `Pick<Lane, 'harness' | 'conversation'>`. Naming `Lane` here would
 * make compaction.ts import lane/boot.ts while boot.ts imports this module.
 */
export interface CompactionLane {
  readonly harness: Harness;
  readonly conversation: Conversation;
  // The lane's manual-compaction scope: the user's `/compact` holds it from
  // before the admission until the task settles. Absent on a bare harness.
  readonly manualKeep?: ManualKeepScope;
}

/**
 * The size of the context the next request carries, counted the way the
 * compaction trigger counts it: the newest response's reported usage (its
 * output included, since the reply rides along) plus an estimate of every
 * message committed after it (tool results, the next prompt). After a
 * compaction the summary and the kept messages are estimated until the next
 * response reports real usage.
 */
export async function measureContext(
  lane: Pick<CompactionLane, 'conversation'>,
  context: Context,
): Promise<number> {
  const view = await lane.conversation.context(context);
  return estimateContextTokens(view.messages).tokens;
}

interface ManualCompactionAdmission {
  taskId: TaskId<CompactionResult>;
  // The context estimate at admission (Pi's own estimate over the derived
  // model context), so the caller can report what the cut removed. Read
  // BEFORE the task is admitted: after placement the context is the summary.
  tokensBefore: number;
}

// How a manual compaction ended. `aborted` is the
// operator's cancel (Esc/Ctrl-C -> conversation.abort()), `orphaned` a task
// whose abort protocol could not run; `faulted` is Pi's runtime-detected
// contract failure (an uncaught throw), reported as a failure by name;
// `nothing` is Pi's own "nothing to compact" completion — the task ran, the
// cut selection found no older history to summarize, and NO `pi.compaction`
// entry was placed (`CompactionResult`'s `entryId`/`submissionId` both
// absent, pi-durable's types.ts). Reporting that as a cut would be a lie.
type ManualCompactionStatus =
  | 'completed'
  | 'nothing'
  | 'failed'
  | 'aborted'
  | 'orphaned'
  | 'faulted';

// Why a manual compaction cut nothing (status `nothing` only).
// `most-recent-turn`: the context holds no history older than its most recent
// turn, so there was nothing to summarize and no task was admitted.
// `no-cut`: older history exists, but pi-durable found no cut point before the
// most recent turn.
type ManualCompactionReason = 'most-recent-turn' | 'no-cut';

export interface ManualCompactionOutcome {
  status: ManualCompactionStatus;
  // The context estimate before the cut; 0 when the admission itself failed.
  tokensBefore: number;
  // The harness' own failure message — never an invented one.
  error?: string;
  reason?: ManualCompactionReason;
}

type ContextView = Awaited<ReturnType<Conversation['context']>>;

/**
 * Whether a context holds history older than its most recent turn: a
 * non-system message before the last user message, after the head marker.
 * The system entry counts toward cut selection, so without this check a
 * session of one turn would summarize that turn's user message.
 */
function hasOlderHistory(
  view: Pick<ContextView, 'head' | 'contributions'>,
): boolean {
  const turns = view.contributions.slice(view.head === undefined ? 0 : 1);
  let latestUser = -1;
  for (let index = 0; index < turns.length; index++) {
    if (turns[index]?.some((message) => message.role === 'user')) {
      latestUser = index;
    }
  }
  for (let index = 0; index < latestUser; index++) {
    if (turns[index]?.some((message) => message.role !== 'system')) {
      return true;
    }
  }
  return false;
}

/**
 * Options of one manual compaction. Its outcome is reported in Kubic's own
 * vocabulary: a refused admission, a failed summary, a cancellation and a
 * rejected wait all come back as an outcome, so the caller never has to catch.
 */
export interface ManualCompactionOptions {
  /**
   * Called the moment the task is ADMITTED, before the wait: a caller that
   * latched a cancellation during the admission window (the context read and
   * the admission commit) replays it here, so a Ctrl-C is never lost.
   */
  onAdmitted?: (taskId: string) => void | Promise<void>;
}

// Admission on a context the caller has already read. The estimate is taken
// from that read, before the task is admitted: after placement the context is
// the summary.
async function admitCompaction(
  lane: CompactionLane,
  focus: string | undefined,
  view: ContextView,
  context: Context,
): Promise<ManualCompactionAdmission> {
  const instructions = buildCompactPrompt(focus === undefined ? {} : { focus });
  const tokensBefore = estimateContextTokens(view.messages).tokens;
  const taskId = await lane.conversation.compact(instructions, context);
  return { taskId, tokensBefore };
}

/**
 * One manual compaction, admitted and awaited to terminal. Overflow recovery
 * takes this path, and keeps the effective window, as pi's own overflow path
 * does. The user's `/compact` goes through `runCompactCommand`, which also
 * holds the manual keep window while the task is pending.
 */
export async function runManualCompaction(
  lane: CompactionLane,
  focus: string | undefined,
  context: Context,
  options: ManualCompactionOptions = {},
): Promise<ManualCompactionOutcome> {
  let view: ContextView;
  try {
    view = await lane.conversation.context(context);
  } catch (error) {
    return { status: 'failed', tokensBefore: 0, error: messageOf(error) };
  }
  const tokensBefore = estimateContextTokens(view.messages).tokens;
  if (!hasOlderHistory(view)) {
    return { status: 'nothing', tokensBefore, reason: 'most-recent-turn' };
  }
  return admitAndSettle(lane, focus, view, context, options);
}

/**
 * The user's `/compact`: one manual compaction under the manual keep window.
 * The scope is held from before the admission until the task settles, on every
 * exit path, admission refusals included.
 */
export async function runCompactCommand(
  lane: CompactionLane,
  focus: string | undefined,
  context: Context,
  options: ManualCompactionOptions = {},
): Promise<ManualCompactionOutcome> {
  const release = lane.manualKeep?.open();
  try {
    return await runManualCompaction(lane, focus, context, options);
  } finally {
    release?.();
  }
}

async function admitAndSettle(
  lane: CompactionLane,
  focus: string | undefined,
  view: ContextView,
  context: Context,
  options: ManualCompactionOptions,
): Promise<ManualCompactionOutcome> {
  let admitted: ManualCompactionAdmission;
  try {
    admitted = await admitCompaction(lane, focus, view, context);
  } catch (error) {
    return { status: 'failed', tokensBefore: 0, error: messageOf(error) };
  }
  if (options.onAdmitted !== undefined) {
    try {
      await options.onAdmitted(String(admitted.taskId));
    } catch {
      // The replay is best-effort: the task's own settlement still decides.
    }
  }
  const waited = await lane.harness
    .waitForTask(admitted.taskId, context)
    .then((settled) => ({ outcome: settled.state.outcome }))
    .catch((error: unknown) => ({ error: messageOf(error) }));
  if ('error' in waited) {
    return {
      status: 'failed',
      tokensBefore: admitted.tokensBefore,
      error: waited.error,
    };
  }
  const outcome = waited.outcome;
  if (outcome.status === 'completed') {
    // Pi's "nothing to compact": the task completed without placing a
    // summary entry. Distinguish it from a real cut — the footer must never
    // claim a compaction that did not happen.
    const result = outcome.result;
    const placed =
      result?.entryId !== undefined || result?.submissionId !== undefined;
    return placed
      ? { status: 'completed', tokensBefore: admitted.tokensBefore }
      : {
          status: 'nothing',
          tokensBefore: admitted.tokensBefore,
          reason: 'no-cut',
        };
  }
  if (outcome.status === 'failed' || outcome.status === 'faulted') {
    return {
      status: outcome.status,
      tokensBefore: admitted.tokensBefore,
      error: outcome.error.message,
    };
  }
  return {
    status: outcome.status,
    tokensBefore: admitted.tokensBefore,
    error: outcome.reason ?? `compaction ${outcome.status}`,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
