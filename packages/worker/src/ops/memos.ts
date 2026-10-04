// Memo accessors for Kubic invocations (issue #13, slice A; §20.3).
// The LANE no longer uses MemoryMemoStore (EPIC K #393): a pi-durable tool
// memoizes through `api.memo`, which is durable in the call's task record and
// first-writer-wins — that is what `lane/tools-adapter.ts` now builds its
// ToolInvocation on, resolving issue #153's "memos are dead" finding.
// MemoryMemoStore stays for callers that drive an op WITHOUT a durable
// harness — `kubic git` (host/src/git-cli.ts) and the op test suites — where
// one in-process scope per invocation is exactly right.
// getMemo/setMemo are scoped per invocationId. memoOnce is an atomic
// read-or-write: single-threaded check-then-set with no await in between,
// so the same operation/turn/invocation keeps owning the effect —
// an approval answer or external result survives a worker crash
// without repeating.

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
    getMemo: (name: string) => store.get(ref.invocationId, name),
    setMemo: (name: string, value: JsonValue | undefined) =>
      store.set(ref.invocationId, name, value),
    memoOnce: (name: string, candidate: JsonValue) =>
      store.once(ref.invocationId, name, candidate),
  };
}
