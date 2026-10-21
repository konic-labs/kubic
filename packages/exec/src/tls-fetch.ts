// A fetch for a provider behind mutual TLS: each request goes out through
// node:https with the provider's client certificate and key — and its own CA
// beside the default roots, when it names one — and the answer streams back
// as a web Response, so the SDK reads a server-sent event stream as it
// arrives. A compressed answer is decompressed, as fetch does.
//
// Lives in exec: the certificate files are read here.

import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import * as tls from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** Where a provider's client certificate, key and CA are (PEM files). */
export interface ClientTlsPaths {
  readonly cert: string;
  readonly key: string;
  readonly ca?: string;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function readPem(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `cannot read the TLS ${what} ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// The roots a provider CA joins: whatever this process trusts by default
// (the system store too, once it was added).
function defaultRoots(): string[] {
  const api = tls as unknown as {
    getCACertificates?: (type: 'default') => string[];
  };
  return typeof api.getCACertificates === 'function'
    ? api.getCACertificates('default')
    : [...tls.rootCertificates];
}

function decoded(response: IncomingMessage): Readable {
  switch (String(response.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return response.pipe(createGunzip());
    case 'deflate':
      return response.pipe(createInflate());
    case 'br':
      return response.pipe(createBrotliDecompress());
    default:
      return response;
  }
}

function responseHeaders(response: IncomingMessage, decoded: boolean): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (decoded && (name === 'content-encoding' || name === 'content-length')) {
      continue;
    }
    for (const entry of Array.isArray(value) ? value : [value]) {
      headers.append(name, entry);
    }
  }
  return headers;
}

/** A fetch that presents the client certificate at `paths`. Reads the files now. */
export function createTlsFetch(paths: ClientTlsPaths): typeof fetch {
  const agent = new Agent({
    cert: readPem(paths.cert, 'client certificate'),
    key: readPem(paths.key, 'client key'),
    ...(paths.ca === undefined
      ? {}
      : { ca: [...defaultRoots(), readPem(paths.ca, 'CA')] }),
    keepAlive: true,
  });
  return async (input, init) => {
    const request = new Request(
      input,
      init?.body instanceof ReadableStream
        ? ({ ...init, duplex: 'half' } as RequestInit)
        : init,
    );
    const url = new URL(request.url);
    const body =
      request.body === null
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    if (body !== undefined) headers['content-length'] = String(body.length);
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = send(
        url,
        {
          method: request.method,
          headers,
          signal: request.signal,
          ...(url.protocol === 'https:' ? { agent } : {}),
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const empty =
            NULL_BODY_STATUSES.has(status) || request.method === 'HEAD';
          const stream = empty ? undefined : decoded(response);
          if (empty) response.resume();
          resolve(
            new Response(
              stream === undefined
                ? null
                : (Readable.toWeb(stream) as ReadableStream<Uint8Array>),
              {
                status,
                statusText: response.statusMessage ?? '',
                headers: responseHeaders(
                  response,
                  stream !== undefined && stream !== response,
                ),
              },
            ),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
}
