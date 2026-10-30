// Tools from outside the binary — an allowlisted MCP server's: each is a
// pi-durable tool with the JSON schema its server published, run by the
// host's call. The lane offers them beside the built-ins, outside the
// permission classes (the server's allowlist entry and the enterprise tool
// gate decide them), and every call goes through the same interceptors:
// the approval ask, the hooks, the secret scan.

import type { ToolRegistration } from '../pi-boundary.js';
import { defineTool, Type } from '../pi-boundary.js';

export interface ExternalTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly call: (
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) => Promise<{ readonly text: string; readonly isError: boolean }>;
}

// The same backstop the built-in tools' output is held to.
const OUTPUT_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxLines: 100_000,
  retain: 'head',
} as const;

export function externalToolRegistrations(
  tools: readonly ExternalTool[],
): ToolRegistration[] {
  return tools.map(
    (tool) =>
      defineTool({
        name: tool.name,
        description: tool.description,
        parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
        // A call to another process's tool is never replayed on recovery.
        replay: 'unsafe',
        outputLimits: OUTPUT_LIMITS,
        execute: async (args, _api, callContext) => {
          const result = await tool.call(
            args as Record<string, unknown>,
            callContext.abortSignal,
          );
          return {
            output: [{ type: 'text', text: result.text }],
            isError: result.isError,
          };
        },
      }) as ToolRegistration,
  );
}
