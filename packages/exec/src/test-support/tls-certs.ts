// Throwaway certificates for mutual-TLS tests, made with `openssl` in a
// temp directory: a CA, a server certificate for localhost and 127.0.0.1,
// and a client certificate, each signed by the CA (two days' validity).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TestPki {
  readonly caPath: string;
  readonly ca: string;
  readonly serverCert: string;
  readonly serverKey: string;
  readonly clientCertPath: string;
  readonly clientKeyPath: string;
}

function openssl(dir: string, args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

const EC_KEY = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'];

export function makeTestPki(dir: string): TestPki {
  openssl(dir, [
    'req',
    '-x509',
    ...EC_KEY,
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=kubic-test-ca',
  ]);
  writeFileSync(
    join(dir, 'server.ext'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\n',
  );
  writeFileSync(join(dir, 'client.ext'), 'extendedKeyUsage=clientAuth\n');
  for (const [name, subject, serial] of [
    ['server', '/CN=localhost', '01'],
    ['client', '/CN=kubic-test-client', '02'],
  ] as const) {
    openssl(dir, [
      'req',
      ...EC_KEY,
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      subject,
    ]);
    openssl(dir, [
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-set_serial',
      serial,
      '-days',
      '2',
      '-out',
      `${name}.pem`,
      '-extfile',
      `${name}.ext`,
    ]);
  }
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  return {
    caPath: join(dir, 'ca.pem'),
    ca: read('ca.pem'),
    serverCert: read('server.pem'),
    serverKey: read('server.key'),
    clientCertPath: join(dir, 'client.pem'),
    clientKeyPath: join(dir, 'client.key'),
  };
}
