// Posting JSON to a collector: the audit sinks' https and otlp collectors and
// the OpenTelemetry export share it. One request, bounded in time; a 2xx
// answer resolves, anything else rejects. Plain http is accepted only for
// this machine.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const DELIVERY_TIMEOUT_MS = 10_000;

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
