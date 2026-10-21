// A Model Context Protocol server over stdio: one child process speaking
// newline-delimited JSON-RPC 2.0 on its standard input and output. It runs
// in the workspace with the tool environment (no provider key), plus the
// variables its allowlist entry names; its stderr goes to the caller's
// sink. A request is bounded in time, and every pending request fails,
// named, when the server exits.
//
// Lives in exec: only packages/exec spawns processes.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { toolSpawnEnv } from './env/tool-env.js';

const MAX_LINE = 16 * 1024 * 1024;

export interface JsonRpcTransport {
  request(
    method: string,
    params: unknown,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

export interface McpStdioOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  // Variables passed through to the server, above the tool environment.
  readonly env?: Readonly<Record<string, string>>;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly stderr?: (line: string) => void;
}

export class JsonRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function spawnMcpStdio(options: McpStdioOptions): JsonRpcTransport {
  const child: ChildProcessWithoutNullStreams = spawn(
    options.command,
    [...options.args],
    {
      cwd: options.cwd,
      env: {
        ...toolSpawnEnv(options.baseEnv ?? process.env),
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let ended: string | undefined;
  const failAll = (reason: string): void => {
    ended ??= reason;
    for (const [id, waiter] of pending) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
      pending.delete(id);
    }
  };
  const write = (message: unknown): void => {
    if (ended !== undefined) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  child.stdin.on('error', () => undefined);
  child.on('error', (error) =>
    failAll(`the MCP server could not start: ${error.message}`),
  );
  child.on('exit', (code, signal) =>
    failAll(
      `the MCP server exited (${signal ?? `code ${String(code)}`}) before it answered`,
    ),
  );
  createInterface({ input: child.stderr }).on('line', (line) =>
    options.stderr?.(line),
  );
  createInterface({
    input: child.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  }).on('line', (line) => {
    if (line.length > MAX_LINE || line.trim() === '') return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.method === 'string' && message.id !== undefined) {
      // A request from the server: a ping is answered, anything else
      // (sampling, roots) is not offered by this client.
      write(
        message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'not offered by this client' },
            },
      );
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    const error = message.error as
      | { code?: unknown; message?: unknown }
      | undefined;
    if (error !== undefined) {
      waiter.reject(
        new JsonRpcError(
          typeof error.code === 'number' ? error.code : -32603,
          typeof error.message === 'string' ? error.message : 'error',
        ),
      );
    } else {
      waiter.resolve(message.result);
    }
  });
  return {
    request(method, params, requestOptions = {}) {
      if (ended !== undefined) return Promise.reject(new Error(ended));
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        const timer =
          requestOptions.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                pending.delete(id);
                reject(
                  new Error(
                    `the MCP server did not answer ${method} within ${requestOptions.timeoutMs} ms`,
                  ),
                );
              }, requestOptions.timeoutMs);
        pending.set(id, { resolve, reject, timer });
        requestOptions.signal?.addEventListener(
          'abort',
          () => {
            if (!pending.has(id)) return;
            pending.delete(id);
            if (timer !== undefined) clearTimeout(timer);
            write({
              jsonrpc: '2.0',
              method: 'notifications/cancelled',
              params: { requestId: id, reason: 'cancelled' },
            });
            reject(new Error(`${method} was cancelled`));
          },
          { once: true },
        );
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      write({
        jsonrpc: '2.0',
        method,
        ...(params === undefined ? {} : { params }),
      });
    },
    close() {
      failAll('the MCP server was closed');
      child.stdin.end();
      child.kill();
    },
  };
}
