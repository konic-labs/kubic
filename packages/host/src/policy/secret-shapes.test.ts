// Shared secret-shape backstop tests (issue #57 fix cycle 2).
// Case-transform bypass: uppercasing a prefix must never evade detection.
// Faux-only, zero network.
import { describe, expect, it } from 'vitest';
import {
  containsSecretShape,
  findSecretShapes,
  REDACTED_SECRET,
  redactSecretShapes,
} from './secret-shapes.js';

describe('case-insensitive prefixes', () => {
  it('matches uppercase SK- keys', () => {
    expect(containsSecretShape('SK-FAUX-TEST-KEY-0001')).toBe(true);
    expect(findSecretShapes('saw SK-FAUX-TEST-KEY-0001 here')).toEqual([
      'SK-FAUX-TEST-KEY-0001',
    ]);
  });

  it('matches uppercase GitHub-shaped tokens', () => {
    expect(containsSecretShape('GHP_FAUX0001X')).toBe(true);
  });

  it('matches uppercase Slack-shaped tokens', () => {
    expect(containsSecretShape('XOXB-FAUX0001X')).toBe(true);
  });

  it('redacts uppercase shapes instead of echoing them', () => {
    const out = redactSecretShapes('saw SK-FAUX-TEST-KEY-0001 here');
    expect(out).not.toContain('SK-FAUX-TEST-KEY-0001');
    expect(out).toContain(REDACTED_SECRET);
  });

  it('leaves faux markers without a material run inert', () => {
    expect(containsSecretShape('faux marker with no shape')).toBe(false);
    expect(redactSecretShapes('plain text')).toBe('plain text');
  });
});
