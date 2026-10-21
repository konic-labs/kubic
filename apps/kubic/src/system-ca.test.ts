// `[tls] systemCa` and KUBIC_SYSTEM_CA=1 turn the system store on; without
// either nothing changes, and an unsupported Node is a stderr warning.
import { describe, expect, it } from 'vitest';
import type { CliConfigResult } from './config/load.js';
import { applySystemCertificates } from './system-ca.js';

function config(systemCa?: boolean): CliConfigResult {
  return {
    runtime: { config: systemCa === undefined ? {} : { tls: { systemCa } } },
  } as unknown as CliConfigResult;
}

describe('applySystemCertificates', () => {
  it('applies the store when the config or the variable asks', () => {
    let calls = 0;
    const trust = () => {
      calls += 1;
      return { added: 2 };
    };
    applySystemCertificates(config(true), {}, () => undefined, trust);
    applySystemCertificates(
      config(),
      { KUBIC_SYSTEM_CA: '1' },
      () => undefined,
      trust,
    );
    applySystemCertificates(config(), {}, () => undefined, trust);
    applySystemCertificates(config(false), {}, () => undefined, trust);
    expect(calls).toBe(2);
  });

  it('warns when this Node cannot apply it', () => {
    const lines: string[] = [];
    applySystemCertificates(
      config(true),
      {},
      (line) => lines.push(line),
      () => ({ unsupported: 'start it with NODE_OPTIONS=--use-system-ca' }),
    );
    expect(lines).toEqual([
      'warning: tls: start it with NODE_OPTIONS=--use-system-ca',
    ]);
  });
});
