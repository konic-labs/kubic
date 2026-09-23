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

export type OpResult<TResult> =
  | { ok: true; invocation: InvocationRef; result: TResult }
  | { ok: false; invocation: InvocationRef; error: OpErrorDetails };

export class OpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
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
