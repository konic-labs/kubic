// The egress proxy that makes `network_policy = "proxy"` with
// `allowed_domains` enforceable for tool processes: a local HTTP proxy
// (CONNECT tunnels and plain HTTP requests) started per run on 127.0.0.1,
// which the bash tool's environment points at. A host the allowlist does not
// name is refused (403); every connection is reported with its host, port,
// decision and byte count. No TLS is intercepted.

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { connect, type Socket } from 'node:net';

export interface EgressConnection {
  readonly host: string;
  readonly port: number;
  readonly allowed: boolean;
  readonly bytes: number;
}

export interface EgressProxy {
  readonly port: number;
  // `http://127.0.0.1:<port>`.
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Whether `host` is on `allowed`: an entry `example.com` covers the domain
 * and its subdomains, `*.example.com` only the subdomains; an IP matches
 * itself.
 * @internal
 */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase().trim();
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
    return name === pattern || name.endsWith(`.${pattern}`);
  });
}

function splitTarget(
  target: string,
  defaultPort: number,
): {
  host: string;
  port: number;
} {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(target);
  if (bracketed !== null) {
    return {
      host: bracketed[1] as string,
      port: Number(bracketed[2] ?? defaultPort),
    };
  }
  const at = target.lastIndexOf(':');
  return at === -1
    ? { host: target, port: defaultPort }
    : { host: target.slice(0, at), port: Number(target.slice(at + 1)) };
}

export function startEgressProxy(options: {
  readonly allowed: readonly string[];
  readonly onConnection: (connection: EgressConnection) => void;
}): Promise<EgressProxy> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    // A plain HTTP request through the proxy: an absolute URL.
    let target: URL;
    try {
      target = new URL(request.url ?? '');
    } catch {
      response.writeHead(400).end();
      return;
    }
    const port = Number(
      target.port || (target.protocol === 'https:' ? 443 : 80),
    );
    if (!hostAllowed(target.hostname, options.allowed)) {
      options.onConnection({
        host: target.hostname,
        port,
        allowed: false,
        bytes: 0,
      });
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end(
        `kubic egress proxy: ${target.hostname} is not an allowed domain\n`,
      );
      return;
    }
    let bytes = 0;
    const upstream = httpRequest(
      target,
      { method: request.method, headers: request.headers },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
        });
        answer.pipe(response);
        answer.on('end', () =>
          options.onConnection({
            host: target.hostname,
            port,
            allowed: true,
            bytes,
          }),
        );
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
      options.onConnection({
        host: target.hostname,
        port,
        allowed: true,
        bytes,
      });
    });
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
    });
    request.pipe(upstream);
  });
  server.on(
    'connect',
    (request: IncomingMessage, client: Socket, head: Buffer) => {
      const { host, port } = splitTarget(request.url ?? '', 443);
      if (!hostAllowed(host, options.allowed)) {
        options.onConnection({ host, port, allowed: false, bytes: 0 });
        client.end(
          'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nkubic egress proxy: not an allowed domain\n',
        );
        return;
      }
      let bytes = head.byteLength;
      let reported = false;
      const report = (): void => {
        if (reported) return;
        reported = true;
        options.onConnection({ host, port, allowed: true, bytes });
      };
      const upstream = connect(port, host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.byteLength > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
        });
        socket.on('close', () => {
          sockets.delete(socket);
          report();
        });
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
    },
  );
  return new Promise<EgressProxy>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
