// The audit collectors a spooled sink delivers to: syslog over TCP or TLS
// (RFC 6587 octet-counted frames, as RFC 5425 prescribes for TLS), an HTTPS
// endpoint that takes a JSON batch of records, and an OpenTelemetry collector
// that takes OTLP/HTTP logs. Each delivery is one connection and one batch,
// bounded in time; anything short of a clean delivery rejects, so the batch
// stays spooled. Plain http and plain TCP are refused for anything but this
// machine, except where a protocol has no TLS form (syslog over `tcp://`).

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { OrgAuditRecord } from './audit.js';

const DELIVERY_TIMEOUT_MS = 10_000;
// How long a delivered stream waits for the collector to close its side.
const CLOSE_GRACE_MS = 2_000;

export interface CollectorTls {
  // PEM certificates to trust in place of the system store's.
  readonly ca?: string;
}

/** Writes octet-counted syslog frames to a TCP or TLS syslog collector. */
export function deliverSyslogStream(
  target: { host: string; port: number; tls: boolean } & CollectorTls,
  lines: readonly string[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const payload = lines
      .map((line) => `${Buffer.byteLength(line, 'utf8')} ${line}`)
      .join('');
    const host = target.host.replace(/^\[|\]$/g, '');
    const socket = target.tls
      ? tlsConnect({
          host,
          port: target.port,
          servername: host,
          ...(target.ca === undefined ? {} : { ca: target.ca }),
        })
      : netConnect({ host, port: target.port });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error === undefined) {
        // The frames are handed to the kernel and the stream half-closed:
        // the collector closes its side, or the grace below does.
        setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
        resolve();
      } else {
        socket.destroy();
        reject(error);
      }
    };
    socket.setTimeout(DELIVERY_TIMEOUT_MS, () =>
      finish(new Error(`syslog ${target.host}:${target.port} timed out`)),
    );
    socket.on('error', (error) => finish(error));
    socket.once(target.tls ? 'secureConnect' : 'connect', () => {
      socket.setTimeout(0);
      socket.end(payload, () => finish());
    });
  });
}

export interface HttpCollector extends CollectorTls {
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
        timeout: DELIVERY_TIMEOUT_MS,
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

// An OTLP attribute value from a scalar.
function attribute(
  key: string,
  value: string | number,
): { key: string; value: Record<string, string | number> } {
  return {
    key,
    value:
      typeof value === 'number' ? { intValue: value } : { stringValue: value },
  };
}

/** The records as an OTLP/HTTP JSON logs request. */
export function otlpLogsBody(records: readonly OrgAuditRecord[]): unknown {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [attribute('service.name', 'kubic')],
        },
        scopeLogs: [
          {
            scope: { name: 'kubic.audit' },
            logRecords: records.map((record) => ({
              timeUnixNano: `${BigInt(Date.parse(record.when)) * 1_000_000n}`,
              severityNumber: record.result === 'ok' ? 10 : 13,
              severityText: record.result === 'ok' ? 'NOTICE' : 'WARN',
              body: { stringValue: JSON.stringify(record) },
              attributes: [
                attribute('kubic.audit.what', record.what),
                attribute('kubic.audit.result', record.result),
                attribute('kubic.audit.posture', record.posture),
                attribute('kubic.session.id', record.agent.session),
                attribute('process.pid', record.process.pid),
              ],
            })),
          },
        ],
      },
    ],
  };
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
