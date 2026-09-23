// Cheap read-only spawn path RED slice 3 (issue #55; §81): the spawn
// fast path performs reads/concurrency checks only — any write or
// network step disqualifies it. Fails until spawn-path.js lands.
import { describe, expect, it } from 'vitest';
import { assertCheapSpawnPath, isCheapSpawnPath } from './spawn-path.js';

describe('cheap read-only spawn path', () => {
  it('admits a read-only step list', () => {
    expect(
      isCheapSpawnPath(['read-config', 'read-registry', 'check-limits']),
    ).toBe(true);
  });

  it('rejects write and network steps', () => {
    expect(isCheapSpawnPath(['read-config', 'write-worktree'])).toBe(false);
    expect(isCheapSpawnPath(['read-config', 'net-fetch'])).toBe(false);
  });

  it('throws naming the offending step', () => {
    expect(() => assertCheapSpawnPath(['read-config', 'net-fetch'])).toThrow(
      /net-fetch/,
    );
  });
});
