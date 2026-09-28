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
  // Lane abort support (issue #11): the op hands its process kill to the
  // lane's kill registry so requestLaneAbort drains in-flight trees.
  trackHandle?: (kill: () => void, invocation: ToolInvocation) => void;
  // Issue #339: bash default/max timeout and background-job policy.
  // Absent ⇒ resolved from the documented KUBIC_BASH_* env overrides.
  bashPolicy?: import('./bash.js').BashPolicy;
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
// (issue #122) is the pre-allocation size refusal for edit.
export const OP_FAILURE_CODES = [
  'invalid_args',
  'not_found',
  'no_match',
  'ambiguous_match',
  'file_too_large',
  'journal_failed',
  'not_a_repo',
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
