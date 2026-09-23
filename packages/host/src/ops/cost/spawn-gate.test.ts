// (4) subagent selection: spawn-only-needed gate (issue #56): RED first.
import { describe, expect, it } from 'vitest';
import { gateSpawn } from './spawn-gate.js';

describe('spawn-only-needed gate (issue #56)', () => {
  it('admits a needed spawn under concurrency', () => {
    expect(
      gateSpawn({ needed: true, running: 1, maxConcurrency: 4 }).admitted,
    ).toBe(true);
  });

  it('blocks an unneeded spawn with a recorded reason', () => {
    const verdict = gateSpawn({ needed: false, running: 0, maxConcurrency: 4 });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.reason).toMatch(/not needed/);
  });

  it('blocks a needed spawn when concurrency is full', () => {
    const verdict = gateSpawn({ needed: true, running: 4, maxConcurrency: 4 });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.reason).toMatch(/concurrency/);
  });
});
