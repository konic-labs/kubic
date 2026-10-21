// The `[[hooks]]` around each tool call, adapted to the lane's interceptor
// seam: a before-tool hook's refusal blocks the call with its reason, an
// after-tool hook hears the result.

import type { ToolHookCalls } from '@kubic/agent/lane/interceptors';
import type { AdminHook } from '@kubic/host/config';
import {
  type HookContext,
  runAfterToolHooks,
  runBeforeToolHooks,
} from '@kubic/host/hooks';

export function toolHooksFor(
  hooks: readonly AdminHook[] | undefined,
  ctx: HookContext,
): ToolHookCalls | undefined {
  const before = (hooks ?? []).filter((hook) => hook.event === 'beforeTool');
  const after = (hooks ?? []).filter((hook) => hook.event === 'afterTool');
  if (before.length === 0 && after.length === 0) return undefined;
  return {
    ...(before.length === 0
      ? {}
      : {
          before: (call) =>
            runBeforeToolHooks(
              before,
              { tool: call.toolName, arguments: call.args },
              ctx,
            ),
        }),
    ...(after.length === 0
      ? {}
      : {
          after: (call) =>
            runAfterToolHooks(
              after,
              {
                tool: call.toolName,
                arguments: call.args,
                isError: call.isError,
                output: call.output,
              },
              ctx,
            ),
        }),
  };
}
