// Operation kernel types (issue #13; §20.3, §37.5).
// Every tool is an Operation: strict args in, structured result out.
// Invocation threading (invocationId stable across safe replay,
// operationId, turnId) plus memo accessors per §20.3.

import type {
  CheckpointStore,
  ExecutionEnv,
  ProcessSnapshot,
} from '../../../exec/src/env.js';
import type { FileJournalStore } from '../../../exec/src/journal.js';
import type { SpillSink } from '../spill.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface MemoStore {
  get(invocationId: string, name: string): Promise<JsonValue | undefined>;
  set(
    invocationId: string,
    name: string,
    value: JsonValue | undefined,
  ): Promise<void>;
  once(
    invocationId: string,
    name: string,
    candidate: JsonValue,
  ): Promise<JsonValue>;
}

export interface ToolInvocation {
  readonly invocationId: string;
  readonly operationId: string;
  readonly turnId: string;
  /**
   * Whether `callOperation` keeps its own never-replay result memo (§20.2)
   * under this invocation.
   *
   * `true` — the caller has NO replay gate of its own (an in-process
   * `MemoStore` at best), so the result of a `replay: 'never'` op is stored
   * under `op-result-<op>` and a retry with the same invocation id returns
   * it instead of re-executing.
   *
   * `false` — the caller's engine already refuses to re-execute the op
   * (pi-durable `ToolRegistration.replay: 'unsafe'`: an interrupted call is
   * settled `interrupted` without re-entering `execute`). The memo could
   * never be read, and writing it costs a second durable copy of a result
   * that can be a fully capped bash transcript, so nothing is stored.
   * Explicit op memos (`getMemo`/`setMemo`/`memoOnce`) stay available either
   * way; this only governs the registry's own guard.
   */
  readonly keepEffectMemo: boolean;
  getMemo(name: string): Promise<JsonValue | undefined>;
  setMemo(name: string, value: JsonValue | undefined): Promise<void>;
  memoOnce(name: string, candidate: JsonValue): Promise<JsonValue>;
}

export interface OpContext {
  env: ExecutionEnv;
  sessionId: string;
  agentId: string;
  signal?: AbortSignal;
  onUpdate?: (snapshot: ProcessSnapshot) => void;
  checkpointStore?: CheckpointStore;
  // Journal interception (issue #17): the lane's toolCallId for this call
  // plus the session journal. write/edit record every mutation; a journal
  // failure fails the op loud (journal_failed) — a silent gap in the
  // recovery record is worse than a failed tool call.
  toolCallId?: string;
  journal?: FileJournalStore;
  // Interactive turn (issue #436): the lane's `currentTurn` supplier,
  // sampled per call. write/edit journal it; absent means turn-less
  // (headless runs, tests, journal-free contexts).
  turn?: number;
  // Lane abort support (issue #11): the op hands its process kill to the
  // lane's kill registry so requestLaneAbort drains in-flight trees. The
  // return value is the registry's unregister fn (issue #142): the op calls
  // it once the handle settles, so a finished call does not keep its handle
  // (and its output) in a registry the lane reuses for the whole session.
  trackHandle?: (
    kill: () => void,
    invocation: ToolInvocation,
  ) => (() => void) | undefined;
  // Issue #339: bash default/max timeout and background-job policy.
  // Absent ⇒ resolved from the documented KUBIC_BASH_* env overrides.
  bashPolicy?: import('./bash.js').BashPolicy;
  // Issue #182: where a clipped stream's full text is written. The lane
  // injects a session-scoped sink; absent (tests, journal-free contexts) the
  // clip notice simply names no path and the result shape is unchanged.
  spill?: SpillSink;
  // Issue #456: the change's display record (the inline diff the TUI
  // shows). It rides the tool result's details, never the model's text;
  // absent, nobody is listening and nothing is computed.
  display?: (record: import('./display-diff.js').ToolDisplay) => void;
}

export interface InvocationRef {
  invocationId: string;
  operationId: string;
  turnId: string;
}

export interface OpErrorDetails {
  code: string;
  message: string;
}

// The named failure-code vocabulary `OpError.code` draws from (§52).
// Model-readable and stable: the model routes on these names, so each is a
// distinct, actionable refusal — never a generic catch-all. `file_too_large`
// (issue #122) is the pre-allocation size refusal for edit; `is_directory`
// and `permission_denied` (issue #199) keep read from calling every I/O
// failure a missing file; `symlink_escape` (issue #140) is a write path that
// resolves through a symlink to a location outside the workspace, which the
// write tool refuses instead of following.
export const OP_FAILURE_CODES = [
  'invalid_args',
  'not_found',
  'is_directory',
  'permission_denied',
  'no_match',
  'ambiguous_match',
  'file_too_large',
  'journal_failed',
  'not_a_repo',
  'symlink_escape',
  'tool_failed',
] as const;

export type OpFailureCode = (typeof OP_FAILURE_CODES)[number];

export type OpResult<TResult> =
  | { ok: true; invocation: InvocationRef; result: TResult }
  | { ok: false; invocation: InvocationRef; error: OpErrorDetails };

export class OpError extends Error {
  readonly code: OpFailureCode;

  constructor(code: OpFailureCode, message: string) {
    super(message);
    this.name = 'OpError';
    this.code = code;
  }
}

// Strict sampling (issue #168; §37.5): an argument the tool does not
// declare is refused by name, never silently ignored — the model then sees
// the real argument names instead of a guess that quietly did nothing.
export function rejectUnknownArgs(
  op: string,
  raw: object,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new OpError(
        'invalid_args',
        `${op}: unknown argument "${key}" (strict sampling)`,
      );
    }
  }
}

export interface Operation<TArgs, TResult> {
  readonly name: string;
  readonly description: string;
  readonly replay: 'never' | 'safe';
  validateArgs(raw: unknown): TArgs;
  execute(inv: ToolInvocation, args: TArgs, ctx: OpContext): Promise<TResult>;
}

export function refOf(inv: ToolInvocation): InvocationRef {
  return {
    invocationId: inv.invocationId,
    operationId: inv.operationId,
    turnId: inv.turnId,
  };
}
