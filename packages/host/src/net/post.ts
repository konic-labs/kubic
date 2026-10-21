// Posting JSON to a collector: the audit sinks' https and otlp collectors and
// the OpenTelemetry export share it, and the approval broker reads its JSON
// answers. One request, bounded in time; a 2xx answer resolves, anything
// else rejects. Plain http is accepted only for this machine.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 64 * 1024;

export interface CollectorTls {
  // PEM certificates to trust in place of the system store's.
  readonly ca?: string;
}

export interface HttpCollector extends CollectorTls {
  // The request bound; absent: ten seconds.
  readonly timeoutMs?: number;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** POSTs one JSON body; resolves on a 2xx answer. */
export function postJson(
  collector: HttpCollector,
  body: unknown,
): Promise<void> {
  const url = new URL(collector.url);
  const text = JSON.stringify(body);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<void>((resolve, reject) => {
    const request = send(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text, 'utf8')),
          ...collector.headers,
        },
        timeout: collector.timeoutMs ?? DELIVERY_TIMEOUT_MS,
        ...(collector.ca === undefined ? {} : { ca: collector.ca }),
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`${url.origin} answered ${status}`));
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`${url.origin} timed out`));
    });
    request.on('error', reject);
    request.end(text);
  });
}

/**
 * One JSON request whose answer is read: resolves with the parsed body of a
 * 2xx answer (`null` when it is empty), rejects on anything else, on a body
 * over 64 KiB, and when `signal` aborts.
 */
export function requestJson(
  collector: HttpCollector & { readonly signal?: AbortSignal },
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<unknown> {
  const url = new URL(collector.url);
  const text = body === undefined ? undefined : JSON.stringify(body);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<unknown>((resolve, reject) => {
    const request = send(
      url,
      {
        method,
        headers: {
          accept: 'application/json',
          ...(text === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(text, 'utf8')),
              }),
          ...collector.headers,
        },
        timeout: collector.timeoutMs ?? DELIVERY_TIMEOUT_MS,
        ...(collector.ca === undefined ? {} : { ca: collector.ca }),
        ...(collector.signal === undefined ? {} : { signal: collector.signal }),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_ANSWER_BYTES) {
            request.destroy(
              new Error(`${url.origin} answered more than 64 KiB`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`${url.origin} answered ${status}`));
            return;
          }
          const answer = Buffer.concat(chunks).toString('utf8').trim();
          try {
            resolve(answer === '' ? null : JSON.parse(answer));
          } catch {
            reject(new Error(`${url.origin} answered with invalid JSON`));
          }
        });
        response.on('error', reject);
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`${url.origin} timed out`));
    });
    request.on('error', reject);
    request.end(text);
  });
}

/** Refuses a collector URL that would send records unencrypted off this machine. */
export function checkCollectorUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid collector URL ${JSON.stringify(url)}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)) {
    return parsed;
  }
  throw new Error(
    `collector URL ${url} must use https (plain http only to this machine)`,
  );
}
