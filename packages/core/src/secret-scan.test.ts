import { describe, expect, it } from 'vitest';
import { scanSecrets } from './secret-scan.js';

// Inert material shaped like the real thing (no live key ever lands here).
const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM2ijnJ9xTzRCx',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

describe('scanSecrets', () => {
  it('redacts a whole PEM block, in plain text and in escaped JSON', () => {
    expect(scanSecrets(`key:\n${PEM}\ndone`)).toEqual({
      text: 'key:\n[redacted-secret]\ndone',
      found: 1,
    });
    const json = JSON.stringify({ text: `${PEM}\n` });
    const scanned = scanSecrets(json);
    expect(scanned.found).toBe(1);
    expect(JSON.parse(scanned.text)).toEqual({ text: '[redacted-secret]\n' });
  });

  it('redacts random-looking secret-named values and leaves words alone', () => {
    const scanned = scanSecrets(
      [
        `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
        'password: string',
        'const token = getToken();',
        'client_secret: "s3cr3t-Value-0123456789"',
        'API_KEY=aaaaaaaaaaaaaaaaaaaa',
      ].join('\n'),
    );
    expect(scanned.text.split('\n')).toEqual([
      'AWS_SECRET_ACCESS_KEY=[redacted-secret]',
      'password: string',
      'const token = getToken();',
      'client_secret: "[redacted-secret]"',
      // One repeated character is not random.
      'API_KEY=aaaaaaaaaaaaaaaaaaaa',
    ]);
    expect(scanned.found).toBe(2);
  });

  it('keeps a scanned JSON line valid', () => {
    const line = JSON.stringify({
      content: `export const db = "postgres://app:Pa55w0rd-x9@db:5432/app";\nAPI_KEY="${AWS_SECRET}"`,
    });
    const scanned = scanSecrets(line);
    const parsed = JSON.parse(scanned.text) as { content: string };
    expect(parsed.content).toBe(
      'export const db = "postgres://app:[redacted-secret]@db:5432/app";\nAPI_KEY="[redacted-secret]"',
    );
    expect(scanned.found).toBe(2);
  });

  it('redacts the shared key shapes and Basic credentials, and counts nothing twice', () => {
    const scanned = scanSecrets(
      'curl -H "Authorization: Basic dXNlcjpzM2NyM3QtcGFzcw==" sk-proj-AbCdEf0123456789',
    );
    expect(scanned.text).toBe(
      'curl -H "Authorization: Basic [redacted-secret]" [redacted-secret]',
    );
    expect(scanned.found).toBe(2);
    expect(scanSecrets(scanned.text)).toEqual({ text: scanned.text, found: 0 });
    expect(scanSecrets('nothing to see')).toEqual({
      text: 'nothing to see',
      found: 0,
    });
  });
});
