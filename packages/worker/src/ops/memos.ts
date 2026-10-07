// Memo accessors for Kubic invocations. A LANE call reads and writes memos
// through pi-durable's `api.memo` — the durable, first-writer-wins store of the
// call's own task — which is what `lane/tools-adapter.ts` wires its
// ToolInvocation to. What the lane does NOT do is copy a never-replay result
// into a memo: pi-durable's `replay: 'unsafe'` already settles an interrupted
// effect without re-entering execute, so that copy could never be read (the
// finding, resolved by dropping the write rather than by making it durable).
// MemoryMemoStore therefore stays for callers that drive an op WITHOUT a
// durable engine — `kubic git` (host/src/git-cli.ts) and the op test suites —
// where one in-process scope per invocation is the only gate there is. Those
// invocations set `keepEffectMemo: true`; the lane sets it false.
// getMemo/setMemo are scoped per invocationId. memoOnce is an atomic
// read-or-write: single-threaded check-then-set with no await in between, so
// the same operation/turn/invocation keeps owning the effect — an approval
// answer or external result survives a worker crash without repeating.

import type { JsonValue, MemoStore, ToolInvocation } from './types.js';

export class MemoryMemoStore implements MemoStore {
  private readonly memos = new Map<string, JsonValue | undefined>();

  private key(invocationId: string, name: string): string {
    return JSON.stringify([invocationId, name]);
  }

  get(invocationId: string, name: string): Promise<JsonValue | undefined> {
    return Promise.resolve(this.memos.get(this.key(invocationId, name)));
  }

  set(
    invocationId: string,
    name: string,
    value: JsonValue | undefined,
  ): Promise<void> {
    this.memos.set(this.key(invocationId, name), value);
    return Promise.resolve();
  }

  once(
    invocationId: string,
    name: string,
    candidate: JsonValue,
  ): Promise<JsonValue> {
    const k = this.key(invocationId, name);
    const existing = this.memos.get(k);
    if (existing !== undefined) return Promise.resolve(existing);
    this.memos.set(k, candidate);
    return Promise.resolve(candidate);
  }
}

export function createInvocation(
  ref: { invocationId: string; operationId: string; turnId: string },
  store: MemoStore,
): ToolInvocation {
  return {
    invocationId: ref.invocationId,
    operationId: ref.operationId,
    turnId: ref.turnId,
    // These callers (host/src/git-cli.ts, the op suites) drive an op with no
    // durable engine behind it, so the in-process store is the only
    // never-replay gate there is; the registry keeps its guard.
    keepEffectMemo: true,
    getMemo: (name: string) => store.get(ref.invocationId, name),
    setMemo: (name: string, value: JsonValue | undefined) =>
      store.set(ref.invocationId, name, value),
    memoOnce: (name: string, candidate: JsonValue) =>
      store.once(ref.invocationId, name, candidate),
  };
}
