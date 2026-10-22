// What `kubic run` reads for its approvals before it starts: the broker with
// its token, and a pre-approval file verified against the configured key —
// one that cannot be checked or does not verify refuses the run.
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import type { CliConfigResult } from '../config/load.js';
import { headlessApprovalDeps } from './headless-approvals.js';

function configWith(approvals: Record<string, unknown>): CliConfigResult {
  return { runtime: { approvals } } as unknown as CliConfigResult;
}

function signedFile(): { dir: string; keyPath: string } {
  const dir = tempDir('run-pre-approvals-');
  const pair = generateKeyPairSync('ed25519');
  const keyPath = join(dir, 'approvals.pub');
  writeFileSync(
    keyPath,
    pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
  const text = JSON.stringify({
    version: 1,
    job: 'deps',
    reason: 'refresh',
    grants: [{ capability: 'install', commands: ['npm ci'] }],
  });
  writeFileSync(join(dir, 'job.json'), text);
  writeFileSync(
    join(dir, 'job.json.sig'),
    sign(null, Buffer.from(text), pair.privateKey).toString('base64'),
  );
  return { dir, keyPath };
}

describe('headlessApprovalDeps', () => {
  it('loads a verified pre-approval file, from the flag or the variable', () => {
    const { dir, keyPath } = signedFile();
    const config = configWith({ preApprovalKey: keyPath });
    const fromFlag = headlessApprovalDeps('job.json', config, {}, dir);
    expect(fromFlag).toMatchObject({ preApprovals: { job: 'deps' } });
    const fromEnv = headlessApprovalDeps(
      undefined,
      config,
      { KUBIC_PRE_APPROVALS: join(dir, 'job.json') },
      '/',
    );
    expect(fromEnv).toMatchObject({ preApprovals: { job: 'deps' } });
  });

  it('refuses a tampered file, and one with no key to check it', () => {
    const { dir, keyPath } = signedFile();
    writeFileSync(
      join(dir, 'job.json'),
      JSON.stringify({
        version: 1,
        job: 'deps',
        reason: 'refresh',
        grants: [{ capability: 'install', commands: ['npm *'] }],
      }),
    );
    const tampered = headlessApprovalDeps(
      'job.json',
      configWith({ preApprovalKey: keyPath }),
      {},
      dir,
    );
    expect(tampered).toMatchObject({
      refused: expect.stringContaining('does not match its signature'),
    });
    expect(
      headlessApprovalDeps('job.json', configWith({}), {}, dir),
    ).toMatchObject({
      refused: expect.stringContaining('no [approvals] preApprovalKey'),
    });
  });

  it('sends the broker token as a bearer, and refuses a missing one', () => {
    const config = configWith({
      broker: { url: 'https://approvals.example.com', tokenEnv: 'BROKER_T' },
    });
    expect(
      headlessApprovalDeps(undefined, config, { BROKER_T: 's3cret' }, '/'),
    ).toEqual({
      approvalBroker: {
        url: 'https://approvals.example.com',
        headers: { authorization: 'Bearer s3cret' },
      },
    });
    expect(headlessApprovalDeps(undefined, config, {}, '/')).toMatchObject({
      refused: expect.stringContaining('BROKER_T, which is not set'),
    });
  });
});
