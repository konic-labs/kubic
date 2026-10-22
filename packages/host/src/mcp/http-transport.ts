// A Model Context Protocol server over streamable HTTP: each JSON-RPC
// message is one POST; the answer is a JSON body or a server-sent event
// stream carrying it. The session the server opens on `initialize` rides
// every later request, and is closed with a DELETE.

import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { JsonRpcError, type JsonRpcTransport } from '@kubic/exec/mcp-stdio';

const MAX_BODY = 16 * 1024 * 1024;

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(
  url: URL,
  method: 'POST' | 'DELETE',
  headers: Record<string, string>,
  body: string | undefined,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<Answer> {
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Answer>((resolve, reject) => {
    const outgoing = transport(
      url,
      {
        method,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body, 'utf8')),
              }),
        },
        ...(options.timeoutMs === undefined
          ? {}
          : { timeout: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BODY) {
            outgoing.destroy(new Error('the MCP server answered over 16 MiB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    outgoing.on('timeout', () =>
      outgoing.destroy(new Error(`${url.origin} timed out`)),
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

// The JSON-RPC messages an answer carries: a JSON body, or the `data:`
// payloads of an event stream.
function messagesOf(answer: Answer): unknown[] {
  const type = String(answer.headers['content-type'] ?? '');
  const payloads = type.includes('text/event-stream')
    ? answer.body
        .split(/\r?\n\r?\n/)
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n'),
        )
        .filter((data) => data !== '')
    : [answer.body];
  return payloads.flatMap((payload) => {
    try {
      const parsed = JSON.parse(payload) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
}

export function mcpHttpTransport(
  url: string,
  headers: Readonly<Record<string, string>> = {},
): JsonRpcTransport {
  const target = new URL(url);
  let session: string | undefined;
  let nextId = 1;
  const base = (): Record<string, string> => ({
    accept: 'application/json, text/event-stream',
    ...headers,
    ...(session === undefined ? {} : { 'mcp-session-id': session }),
  });
  return {
    async request(method, params, options = {}) {
      const id = nextId;
      nextId += 1;
      const answer = await send(
        target,
        'POST',
        base(),
        JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        options,
      );
      if (answer.status < 200 || answer.status >= 300) {
        throw new Error(
          `${target.origin} answered ${answer.status} to ${method}`,
        );
      }
      const opened = answer.headers['mcp-session-id'];
      if (typeof opened === 'string' && opened !== '') session = opened;
      const reply = messagesOf(answer).find(
        (message) => (message as { id?: unknown }).id === id,
      ) as
        | { result?: unknown; error?: { code?: unknown; message?: unknown } }
        | undefined;
      if (reply === undefined) {
        throw new Error(`${target.origin} answered ${method} without a reply`);
      }
      if (reply.error !== undefined) {
        throw new JsonRpcError(
          typeof reply.error.code === 'number' ? reply.error.code : -32603,
          typeof reply.error.message === 'string'
            ? reply.error.message
            : 'error',
        );
      }
      return reply.result;
    },
    notify(method, params) {
      send(
        target,
        'POST',
        base(),
        JSON.stringify({
          jsonrpc: '2.0',
          method,
          ...(params === undefined ? {} : { params }),
        }),
        { timeoutMs: 10_000 },
      ).catch(() => undefined);
    },
    close() {
      if (session === undefined) return;
      send(target, 'DELETE', base(), undefined, { timeoutMs: 5_000 }).catch(
        () => undefined,
      );
      session = undefined;
    },
  };
}
