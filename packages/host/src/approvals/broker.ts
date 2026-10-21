// The approval broker: the answer seat of a run with no terminal. Each
// challenged call is posted to the broker as one ask; the broker answers at
// once, or says `pending` and Kubic polls until a person decides. The
// service's `maxPendingMs` bound withdraws an ask nobody answered, which
// denies the call. A chat or code-review bridge (Slack, Teams, a GitHub
// check) implements this protocol on its side:
//
//   POST <broker>  {"kind": "kubic.approval", "version": 1, "id", "sessionId",
//                   "workspace", "tool", "capability", "summary", "command"?,
//                   "deadline"}
//   answer         {"decision": "allow-once" | "allow-session" | "deny" |
//                   "pending", "by"?, "reason"?, "poll"?}
//   GET <poll>     the same answer, until it is not `pending` (`poll`
//                  defaults to `<broker>/<id>` and stays on the broker's
//                  origin)
//
// The ask carries what the TUI shows: the summary and the redacted command,
// never the raw arguments.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { requestJson } from '../net/index.js';
import type { ApprovalVerdict } from './policy.js';
import type { ApprovalRequest } from './request.js';

const DEFAULT_POLL_MS = 2_000;
const DECISIONS = ['allow-once', 'allow-session', 'deny', 'pending'] as const;

export interface ApprovalBrokerTarget {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApprovalBrokerContext {
  readonly sessionId: string;
  readonly workspace: string;
  // The bound the service holds the ask to: the ask's deadline.
  readonly maxPendingMs: number;
  readonly pollMs?: number;
  readonly clock?: () => number;
}

interface BrokerAnswer {
  readonly decision: (typeof DECISIONS)[number];
  readonly by?: string;
  readonly reason?: string;
  readonly poll?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A name or a reason from the broker, as it may appear in a record: no
// control characters, bounded.
function clean(text: unknown, max: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned === '' ? undefined : cleaned.slice(0, max);
}

function parseAnswer(value: unknown): BrokerAnswer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the answer is not a JSON object');
  }
  const record = value as Record<string, unknown>;
  const decision = record.decision;
  if (!DECISIONS.includes(decision as BrokerAnswer['decision'])) {
    throw new Error(
      `the answer's decision ${JSON.stringify(decision)} is not one of ${DECISIONS.join(', ')}`,
    );
  }
  const by = clean(record.by, 64);
  const reason = clean(record.reason, 500);
  return {
    decision: decision as BrokerAnswer['decision'],
    ...(by === undefined ? {} : { by }),
    ...(reason === undefined ? {} : { reason }),
    ...(typeof record.poll === 'string' ? { poll: record.poll } : {}),
  };
}

// Where a pending ask is polled: the URL the answer names, on the broker's
// own origin, or `<broker>/<id>`.
function pollUrl(broker: URL, id: string, poll: string | undefined): string {
  const url =
    poll === undefined
      ? new URL(`${broker.href.replace(/\/+$/, '')}/${encodeURIComponent(id)}`)
      : new URL(poll, broker);
  if (url.origin !== broker.origin) {
    throw new Error(
      `the poll URL ${url.href} is not on the broker's origin ${broker.origin}`,
    );
  }
  return url.href;
}

function verdictOf(answer: BrokerAnswer): ApprovalVerdict {
  const who = answer.by ?? 'unnamed';
  if (answer.decision === 'deny') {
    return {
      approved: false,
      reason: `denied by ${who} through the approval broker${answer.reason === undefined ? '' : `: ${answer.reason}`}`,
    };
  }
  return answer.decision === 'allow-once'
    ? { approved: true, by: `broker:${who}`, once: true }
    : { approved: true, by: `broker:${who}` };
}

/**
 * The answer seat for a webhook broker. Resolves the broker's verdict;
 * `undefined` when the ask was withdrawn (the bound passed) first. A broker
 * that cannot take the ask denies the call, named.
 */
export function webhookApprovalBroker(
  target: ApprovalBrokerTarget,
  ctx: ApprovalBrokerContext,
): (
  request: ApprovalRequest,
  signal?: AbortSignal,
) => Promise<ApprovalVerdict | undefined> {
  const broker = new URL(target.url);
  return async (request, signal) => {
    const id = randomUUID();
    const now = (ctx.clock ?? Date.now)();
    const ask = {
      kind: 'kubic.approval',
      version: 1,
      id,
      sessionId: ctx.sessionId,
      workspace: ctx.workspace,
      tool: request.toolName,
      capability: request.capability,
      summary: request.summary,
      ...(request.command === undefined ? {} : { command: request.command }),
      deadline: new Date(now + ctx.maxPendingMs).toISOString(),
    };
    const call = (url: string, method: 'GET' | 'POST', body?: unknown) =>
      requestJson(
        {
          url,
          ...(target.headers === undefined ? {} : { headers: target.headers }),
          ...(signal === undefined ? {} : { signal }),
        },
        method,
        body,
      ).then(parseAnswer);
    let answer: BrokerAnswer;
    let poll: string;
    try {
      answer = await call(broker.href, 'POST', ask);
      poll = pollUrl(broker, id, answer.poll);
    } catch (error) {
      if (signal?.aborted === true) return undefined;
      return {
        approved: false,
        reason: `the approval broker ${broker.origin} could not take the ask: ${message(error)}`,
      };
    }
    while (answer.decision === 'pending') {
      try {
        await sleep(ctx.pollMs ?? DEFAULT_POLL_MS, undefined, {
          ...(signal === undefined ? {} : { signal }),
        });
        answer = await call(poll, 'GET');
      } catch {
        // A poll that fails is retried until the bound withdraws the ask.
        if (signal?.aborted === true) return undefined;
      }
    }
    return verdictOf(answer);
  };
}
