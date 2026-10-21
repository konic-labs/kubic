// The webhook approval broker against a loopback broker: the ask it posts,
// an answer at once or after polling, a deny with its reason, a withdrawn
// ask, and a broker that cannot take the ask.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { webhookApprovalBroker } from './broker.js';
import type { ApprovalRequest } from './request.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) resolve();
    else server.close(() => resolve());
  });
  server = undefined;
});

// A broker that answers each request with the next of `answers`.
async function broker(
  answers: Array<{ status?: number; body: unknown }>,
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      const answer = answers.shift() ?? { body: { decision: 'pending' } };
      response.writeHead(answer.status ?? 200, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) =>
    (server as Server).listen(0, '127.0.0.1', resolve),
  );
  const { port } = (server as Server).address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/asks`, seen };
}

const REQUEST: ApprovalRequest = {
  key: 'k',
  capability: 'destructive-shell',
  toolName: 'bash',
  summary: 'bash: rm -rf build',
  command: 'rm -rf build',
};

const CONTEXT = {
  sessionId: 's-1',
  workspace: '/repo',
  maxPendingMs: 60_000,
  pollMs: 10,
};

describe('webhookApprovalBroker', () => {
  it('posts the ask and returns an answer given at once', async () => {
    const { url, seen } = await broker([
      { body: { decision: 'allow-session', by: 'alice' } },
    ]);
    const ask = webhookApprovalBroker(
      { url, headers: { authorization: 'Bearer t0k' } },
      CONTEXT,
    );
    expect(await ask(REQUEST)).toEqual({
      approved: true,
      by: 'broker:alice',
    });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers.authorization).toBe('Bearer t0k');
    expect(JSON.parse(seen[0]?.body ?? '')).toMatchObject({
      kind: 'kubic.approval',
      version: 1,
      sessionId: 's-1',
      workspace: '/repo',
      tool: 'bash',
      capability: 'destructive-shell',
      summary: 'bash: rm -rf build',
      command: 'rm -rf build',
    });
  });

  it('polls a pending ask until a person answers, once', async () => {
    const { url, seen } = await broker([
      { body: { decision: 'pending' } },
      { body: { decision: 'pending' } },
      { body: { decision: 'allow-once', by: 'bob' } },
    ]);
    const verdict = await webhookApprovalBroker({ url }, CONTEXT)(REQUEST);
    expect(verdict).toEqual({ approved: true, by: 'broker:bob', once: true });
    const id = JSON.parse(seen[0]?.body ?? '').id as string;
    expect(seen.slice(1).map((entry) => [entry.method, entry.url])).toEqual([
      ['GET', `/asks/${id}`],
      ['GET', `/asks/${id}`],
    ]);
  });

  it('follows the poll URL the broker names, on its own origin only', async () => {
    const { url, seen } = await broker([
      { body: { decision: 'pending', poll: '/status/42' } },
      { body: { decision: 'deny', by: 'carol', reason: 'not on Fridays' } },
    ]);
    expect(await webhookApprovalBroker({ url }, CONTEXT)(REQUEST)).toEqual({
      approved: false,
      reason: 'denied by carol through the approval broker: not on Fridays',
    });
    expect(seen[1]?.url).toBe('/status/42');
    const offOrigin = await broker([
      { body: { decision: 'pending', poll: 'https://elsewhere.test/x' } },
    ]);
    const refused = await webhookApprovalBroker(
      { url: offOrigin.url },
      CONTEXT,
    )(REQUEST);
    expect(refused).toMatchObject({ approved: false });
    expect(JSON.stringify(refused)).toContain("not on the broker's origin");
  });

  it('gives up on a withdrawn ask without a verdict', async () => {
    const { url } = await broker([]);
    const controller = new AbortController();
    const pending = webhookApprovalBroker({ url }, CONTEXT)(
      REQUEST,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toBeUndefined();
  });

  it('denies, named, when the broker cannot take the ask', async () => {
    const { url } = await broker([{ status: 503, body: { error: 'down' } }]);
    const verdict = await webhookApprovalBroker({ url }, CONTEXT)(REQUEST);
    expect(verdict).toMatchObject({ approved: false });
    expect(JSON.stringify(verdict)).toContain('could not take the ask');
    expect(JSON.stringify(verdict)).toContain('answered 503');
  });

  it('refuses an answer that is not a decision', async () => {
    const { url } = await broker([{ body: { decision: 'maybe' } }]);
    const verdict = await webhookApprovalBroker({ url }, CONTEXT)(REQUEST);
    expect(JSON.stringify(verdict)).toContain(
      'is not one of allow-once, allow-session, deny, pending',
    );
  });
});
