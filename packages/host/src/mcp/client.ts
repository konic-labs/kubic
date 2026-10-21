// The Model Context Protocol client: a server the organization allowlisted
// is initialized, its version checked against the pin, and its tools listed
// and narrowed to the allowlist's; a call returns the text the model reads.
// Each tool is offered to the model as `mcp__<server>__<tool>`.

import type { JsonRpcTransport } from '@kubic/exec/mcp-stdio';

const PROTOCOL_VERSION = '2025-06-18';
const INIT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_PAGES = 20;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface McpServerSpec {
  readonly name: string;
  // A stdio server: the pinned command (absolute) and its arguments.
  readonly command?: string;
  readonly args?: readonly string[];
  // A streamable HTTP server.
  readonly url?: string;
  // The version the server must report (`serverInfo.version`).
  readonly version: string;
  // The tools offered (absent: every tool the server lists).
  readonly tools?: readonly string[];
  // The tools that always ask for approval.
  readonly approve?: readonly string[];
  // Variables passed through to a stdio server.
  readonly env?: readonly string[];
}

interface McpToolInfo {
  readonly server: string;
  readonly name: string;
  // The name the model calls it by.
  readonly qualified: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpConnection {
  readonly spec: McpServerSpec;
  readonly tools: readonly McpToolInfo[];
  // Tools the allowlist names that the server does not offer.
  readonly missing: readonly string[];
  call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ readonly text: string; readonly isError: boolean }>;
  close(): void;
}

class McpRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpRefusal';
  }
}

/** The name the model calls a server's tool by, or undefined when none fits. */
export function qualifiedToolName(
  server: string,
  tool: string,
): string | undefined {
  const name = `mcp__${server}__${tool}`;
  return TOOL_NAME.test(name) ? name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(result: unknown): string {
  const content =
    isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const parts = content.map((part) => {
    if (!isRecord(part)) return '';
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    if (part.type === 'resource' && isRecord(part.resource)) {
      const resource = part.resource;
      return typeof resource.text === 'string'
        ? resource.text
        : `[resource ${String(resource.uri ?? '')}]`;
    }
    return `[${String(part.type ?? 'content')}${typeof part.mimeType === 'string' ? ` ${part.mimeType}` : ''}]`;
  });
  if (
    parts.length === 0 &&
    isRecord(result) &&
    result.structuredContent !== undefined
  ) {
    return JSON.stringify(result.structuredContent);
  }
  return parts.join('\n');
}

async function listTools(
  transport: JsonRpcTransport,
): Promise<Array<Record<string, unknown>>> {
  const tools: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await transport.request(
      'tools/list',
      cursor === undefined ? {} : { cursor },
      { timeoutMs: LIST_TIMEOUT_MS },
    );
    if (isRecord(result) && Array.isArray(result.tools)) {
      tools.push(...result.tools.filter(isRecord));
    }
    cursor =
      isRecord(result) && typeof result.nextCursor === 'string'
        ? result.nextCursor
        : undefined;
    if (cursor === undefined) break;
  }
  return tools;
}

/** Initializes `spec`'s server over `transport` and lists its tools. */
export async function connectMcpServer(
  spec: McpServerSpec,
  transport: JsonRpcTransport,
  clientVersion: string,
): Promise<McpConnection> {
  try {
    const init = await transport.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'kubic', version: clientVersion },
      },
      { timeoutMs: INIT_TIMEOUT_MS },
    );
    const serverInfo =
      isRecord(init) && isRecord(init.serverInfo) ? init.serverInfo : {};
    const version = serverInfo.version;
    if (version !== spec.version) {
      throw new McpRefusal(
        `MCP server '${spec.name}' reports version ${JSON.stringify(version ?? 'none')}, but the allowlist pins ${JSON.stringify(spec.version)}`,
      );
    }
    transport.notify('notifications/initialized');
    const listed = await listTools(transport);
    const allowed = spec.tools === undefined ? undefined : new Set(spec.tools);
    const tools: McpToolInfo[] = [];
    for (const tool of listed) {
      const name = typeof tool.name === 'string' ? tool.name : '';
      if (name === '' || (allowed !== undefined && !allowed.has(name)))
        continue;
      const qualified = qualifiedToolName(spec.name, name);
      if (qualified === undefined) continue;
      tools.push({
        server: spec.name,
        name,
        qualified,
        description:
          typeof tool.description === 'string'
            ? tool.description
            : `${name} (MCP server ${spec.name})`,
        inputSchema: isRecord(tool.inputSchema)
          ? tool.inputSchema
          : { type: 'object', properties: {} },
      });
    }
    const offered = new Set(tools.map((tool) => tool.name));
    return {
      spec,
      tools,
      missing: (spec.tools ?? []).filter((name) => !offered.has(name)),
      async call(tool, args, signal) {
        const result = await transport.request(
          'tools/call',
          { name: tool, arguments: args },
          {
            timeoutMs: CALL_TIMEOUT_MS,
            ...(signal === undefined ? {} : { signal }),
          },
        );
        return {
          text: textOf(result),
          isError: isRecord(result) && result.isError === true,
        };
      },
      close: () => transport.close(),
    };
  } catch (error) {
    transport.close();
    throw error;
  }
}
