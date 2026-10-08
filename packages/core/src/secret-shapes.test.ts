// Shared secret-shape backstop tests.
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

describe('bearer/AKIA/PEM case bypass', () => {
  it.each(['BEARER', 'bEaReR', 'BeArEr', 'bearer'])(
    'detects %s-scheme tokens case-insensitively',
    (scheme) => {
      expect(containsSecretShape(`${scheme} faux-token-0001-abcdef`)).toBe(
        true,
      );
    },
  );

  it.each(['BEARER', 'bEaReR', 'BeArEr'])(
    'redacts %s-scheme tokens instead of echoing them',
    (scheme) => {
      const live = `${scheme} faux-token-0001-abcdef`;
      const out = redactSecretShapes(`saw ${live} on the wire`);
      expect(out).not.toContain(live);
      expect(out).not.toContain('faux-token-0001-abcdef');
      expect(out).toContain(REDACTED_SECRET);
    },
  );

  it('detects lowercase akia access keys', () => {
    expect(containsSecretShape('akiafauxtestkey00012')).toBe(true);
    const out = redactSecretShapes('saw akiafauxtestkey00012 on the wire');
    expect(out).not.toContain('akiafauxtestkey00012');
    expect(out).toContain(REDACTED_SECRET);
  });

  it('detects lowercase PEM private-key headers', () => {
    expect(containsSecretShape('-----begin rsa private key-----')).toBe(true);
    const out = redactSecretShapes(
      'saw -----begin rsa private key----- on the wire',
    );
    expect(out).not.toContain('begin rsa private key');
    expect(out).toContain(REDACTED_SECRET);
  });
});
