// The invocation an operation receives when a test calls it directly.
import { createInvocation, MemoryMemoStore } from '../ops/memos.js';
import type { ToolInvocation } from '../ops/types.js';

export function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}
