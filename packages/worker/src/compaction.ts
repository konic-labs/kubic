// Kubic compaction policy on the pi-durable mechanism.
//
// Pi owns the mechanism: the threshold and overflow checks, the summarization
// request, the `pi.compaction` entry, output bounds and spill files. Kubic
// owns the policy numbers Pi reads and the compact prompt:
// - `soloCompactionSettings` builds the `HarnessSettings.compaction` Kubic
//   hands the harness. HarnessSettings are read at every use and never copied,
//   so `reserveTokens` is a LIVE getter over the current model's window: a
//   `configure({ model })` switch re-clamps with no explicit re-clamp step.
// - `compactSoloLane` is the manual path (`/compact [focus]`):
//   it admits Pi's compaction task with Kubic's compact prompt as the
//   summarizer instructions.
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
export const SOLO_KEEP_RECENT_TOKENS = 20000;

// Kubic owns the trigger: exactly one threshold (contextTokens above
// contextWindow - reserveTokens) starts a summarization. pi-durable's own
// default (32768) also starts a background compaction that far BELOW the
// blocking threshold, i.e. a speculative summary model call before the
// reserved room is needed. Kubic pins it off so the reserved room is the only
// trigger — the behaviour the solo lane had before the Pi 1.0 migration — and
// so a session that ends early never pays for a summary nobody needed. A
// caller that wants the head start can still pass an explicit value.
export const SOLO_BACKGROUND_TOKENS = 0;

export interface SoloCompactionSettingsOptions {
  enabled?: boolean;
  configuredReserveTokens?: number;
  keepRecentTokens?: number;
  backgroundTokens?: number;
  /** Window of the conversation's CURRENT model; undefined when unknown. */
  currentWindow: () => number | undefined;
}

/**
 * The `settings.compaction` Kubic hands the harness.
 *
 * HarnessSettings are harness-wide and read at every use, so the solo process
 * (one active conversation) satisfies the live getter with that
 * conversation's current model window. `reserveTokens` is a getter for exactly
 * that reason: the harness reads it at each threshold check and each
 * summarization request, so a model switch follows without any re-clamp call
 * (Pi 1.0 has none).
 */
export function soloCompactionSettings(
  options: SoloCompactionSettingsOptions,
): Partial<CompactionPolicy> {
  const configured = options.configuredReserveTokens ?? DEFAULT_RESERVE_TOKENS;
  return {
    enabled: options.enabled ?? true,
    keepRecentTokens: options.keepRecentTokens ?? SOLO_KEEP_RECENT_TOKENS,
    backgroundTokens: options.backgroundTokens ?? SOLO_BACKGROUND_TOKENS,
    // A window of 0/undefined (model unknown) has nothing to clamp against:
    // effectiveReserveTokens returns the configured reserve.
    get reserveTokens() {
      return effectiveReserveTokens(options.currentWindow() ?? 0, configured);
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

export interface CompactPromptInput {
  focus?: string;
  extraSections?: string[];
}

// /compact [instructions]: caller focus instructions ride verbatim in
// the summary prompt; empty focus builds the instruction-free prompt.
export function buildCompactPrompt(input: CompactPromptInput): string {
  const sections = [
    'Summarize this session for compaction: goal, decisions, open work, cumulative file ops, spill refs.',
    'Prefer compact state + artifacts + refs over history.',
  ];
  const focus = (input.focus ?? '').trim();
  if (focus.length > 0) sections.push(`focus: ${focus}`);
  sections.push(...(input.extraSections ?? []));
  return sections.join('\n');
}

/**
 * The half of the `SoloLane` compaction needs: the structural twin of
 * `Pick<SoloLane, 'harness' | 'conversation'>`. Naming `SoloLane` here would
 * make compaction.ts import lane/solo.ts while solo.ts imports this module.
 */
export interface SoloCompactionLane {
  readonly harness: Harness;
  readonly conversation: Conversation;
}

export interface ManualCompactionAdmission {
  taskId: TaskId<CompactionResult>;
  // The context estimate at admission (Pi's own estimate over the derived
  // model context), so the caller can report what the cut removed. Read
  // BEFORE the task is admitted: after placement the context is the summary.
  tokensBefore: number;
}

/**
 * Manual compaction: `/compact [focus]` admits Pi's
 * `CompactionTask` and returns its id. Pi summarizes while the conversation
 * keeps working and places the summary at once when idle, otherwise at the
 * next turn boundary; the caller waits on `harness.waitForTask`.
 *
 * Kubic's compact prompt — the caller's focus verbatim — is the
 * task's instructions: the one path where Kubic owns the summarizer's text.
 * Automatic (threshold/overflow) compaction uses Pi's own summarization
 * prompt, because pi-durable only accepts instructions through `compact()`.
 */
export async function compactSoloLane(
  solo: SoloCompactionLane,
  focus: string | undefined,
  context: Context,
): Promise<ManualCompactionAdmission> {
  const instructions = buildCompactPrompt(focus === undefined ? {} : { focus });
  const view = await solo.conversation.context(context);
  const tokensBefore = estimateContextTokens(view.messages).tokens;
  const taskId = await solo.conversation.compact(instructions, context);
  return { taskId, tokensBefore };
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

export interface ManualCompactionOutcome {
  status: ManualCompactionStatus;
  // The context estimate before the cut; 0 when the admission itself failed.
  tokensBefore: number;
  // The harness' own failure message — never an invented one.
  error?: string;
}

/**
 * One manual compaction, admitted and awaited to terminal:
 * `compactSoloLane` plus `harness.waitForTask`, reported in Kubic's own
 * vocabulary. Never throws for a refused admission, a failed summary or a
 * cancellation — the caller reports the outcome, it never has to catch.
 */
export interface ManualCompactionOptions {
  /**
   * Called the moment the task is ADMITTED, before the wait: a caller that
   * latched a cancellation during the admission window (the context read and
   * the admission commit) replays it here, so a Ctrl-C is never lost.
   */
  onAdmitted?: (taskId: string) => void | Promise<void>;
}

export async function runManualCompaction(
  solo: SoloCompactionLane,
  focus: string | undefined,
  context: Context,
  options: ManualCompactionOptions = {},
): Promise<ManualCompactionOutcome> {
  let admitted: ManualCompactionAdmission;
  try {
    admitted = await compactSoloLane(solo, focus, context);
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
  const settled = await solo.harness.waitForTask(admitted.taskId, context);
  const outcome = settled.state.outcome;
  if (outcome.status === 'completed') {
    // Pi's "nothing to compact": the task completed without placing a
    // summary entry. Distinguish it from a real cut — the footer must never
    // claim a compaction that did not happen.
    const result = outcome.result;
    const placed =
      result?.entryId !== undefined || result?.submissionId !== undefined;
    return {
      status: placed ? 'completed' : 'nothing',
      tokensBefore: admitted.tokensBefore,
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

type FileOpKind = 'created' | 'modified' | 'deleted' | 'renamed';
