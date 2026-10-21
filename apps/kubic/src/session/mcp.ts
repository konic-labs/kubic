// The boot's MCP step: each server the managed config allowlists is
// started (stdio) or reached (streamable HTTP), its version checked against
// the pin and its tools listed; a server that cannot be used is named on
// stderr and left out. Its tools become the lane's external tools, each call
// audited; the tools its entry says always ask join the approval
// obligations. The connections close with the boot.

import type { ExternalTool } from '@kubic/agent/lane/external-tools';
import type { ExecutionEnv } from '@kubic/exec/env';
import { spawnMcpStdio } from '@kubic/exec/mcp-stdio';
import {
  appendToLedger,
  auditLedgerDirFor,
  mcpCallAudit,
} from '@kubic/host/audit';
import {
  connectMcpServer,
  type McpConnection,
  type McpServerSpec,
  mcpHttpTransport,
  qualifiedToolName,
} from '@kubic/host/mcp';
import { cliVersion } from '../version.js';
import type { SessionBoot } from './bootstrap.js';

function passedThrough(spec: McpServerSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of spec.env ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Connects the allowlisted servers; the ones that cannot be used are named. */
export async function connectBootMcp(
  boot: SessionBoot,
  env: ExecutionEnv,
): Promise<void> {
  for (const spec of boot.config.mcp ?? []) {
    const transport =
      spec.command === undefined
        ? mcpHttpTransport(spec.url as string)
        : spawnMcpStdio({
            command: spec.command,
            args: spec.args ?? [],
            cwd: env.cwd,
            env: passedThrough(spec),
            stderr: (line) => boot.sinks.debug?.(`mcp ${spec.name}: ${line}`),
          });
    try {
      const connection = await connectMcpServer(spec, transport, cliVersion());
      boot.mcp.push(connection);
      for (const tool of connection.missing) {
        boot.sinks.warn(
          `mcp: server '${spec.name}' does not offer ${tool}, which the allowlist names`,
        );
      }
    } catch (error) {
      boot.sinks.warn(
        `mcp: server '${spec.name}' is left out: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The lane tools of the connected servers, each call audited. */
export function mcpExternalTools(
  boot: SessionBoot,
  workspace: string,
): ExternalTool[] {
  const audit = (
    connection: McpConnection,
    tool: string,
    result: 'ok' | 'error',
    reason: string,
  ): void => {
    appendToLedger(
      auditLedgerDirFor(workspace),
      mcpCallAudit({
        sessionId: boot.id,
        workspace,
        server: connection.spec.name,
        tool,
        result,
        reason,
      }),
      (message) =>
        boot.sinks.debug?.(`audit: ledger append failed: ${message}`),
    );
  };
  return boot.mcp.flatMap((connection) =>
    connection.tools.map(
      (tool): ExternalTool => ({
        name: tool.qualified,
        description: `${tool.description} (MCP server ${tool.server})`,
        inputSchema: tool.inputSchema,
        call: async (args, signal) => {
          try {
            const answer = await connection.call(tool.name, args, signal);
            audit(
              connection,
              tool.name,
              answer.isError ? 'error' : 'ok',
              answer.isError ? 'the tool reported an error' : 'ok',
            );
            return answer;
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            audit(connection, tool.name, 'error', reason);
            return {
              text: `error: the MCP server '${tool.server}' could not run ${tool.name}: ${reason}`,
              isError: true,
            };
          }
        },
      }),
    ),
  );
}

/** The MCP tools whose allowlist entry says they always ask. */
export function mcpApprovalTools(
  specs: readonly McpServerSpec[] | undefined,
): string[] {
  return (specs ?? []).flatMap((spec) =>
    (spec.approve ?? []).flatMap((tool) => {
      const name = qualifiedToolName(spec.name, tool);
      return name === undefined ? [] : [name];
    }),
  );
}
