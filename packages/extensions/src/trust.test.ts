// Trust + third-party refusal (issue #37; §31.1, §31.5). RED first.
import { describe, expect, it } from 'vitest';
import { ExtensionRefusedError } from './contract.js';
import {
  assertFirstParty,
  FIRST_PARTY_PUBLISHERS,
  isFirstParty,
  isOwnedPath,
} from './trust.js';

const HOME = '/Users/tester';
const OPTS = { homeDir: HOME, cwd: '/repo', allowlist: [] as string[] };

function manifest(overrides = {}) {
  return {
    name: 'kubic/budget',
    publisher: 'kubic',
    version: '0.0.0',
    sourcePath: `${HOME}/.pi/agent/extensions/budget`,
    ...overrides,
  };
}

describe('extensions trust (issue #37, §31)', () => {
  it('accepts the owned user path ~/.pi/agent/extensions', () => {
    expect(isOwnedPath(`${HOME}/.pi/agent/extensions/budget`, OPTS)).toBe(true);
  });

  it('accepts the owned repo path .pi/extensions', () => {
    expect(isOwnedPath('/repo/.pi/extensions/budget', OPTS)).toBe(true);
  });

  it('accepts owned package specifiers', () => {
    expect(isOwnedPath('@kubic/agents', OPTS)).toBe(true);
    expect(isOwnedPath('kubic/budget', OPTS)).toBe(true);
  });

  it('accepts an explicit -e allowlist entry', () => {
    expect(
      isOwnedPath('/opt/owned/budget', {
        ...OPTS,
        allowlist: ['/opt/owned/budget'],
      }),
    ).toBe(true);
  });

  it('refuses third-party publishers with an explicit error', () => {
    const m = manifest({ publisher: 'evil-corp' });
    expect(isFirstParty(m, OPTS)).toBe(false);
    expect(() => assertFirstParty(m, OPTS)).toThrow(ExtensionRefusedError);
    expect(() => assertFirstParty(m, OPTS)).toThrow(/third-party/i);
  });

  it('refuses unowned absolute paths even when requested', () => {
    const m = manifest({ sourcePath: '/tmp/evil/bundle' });
    expect(() => assertFirstParty(m, OPTS)).toThrow(/not an owned path/i);
  });

  it('refuses remote specifiers', () => {
    expect(isOwnedPath('https://evil.example/bundle.js', OPTS)).toBe(false);
    const m = manifest({ sourcePath: 'https://evil.example/bundle.js' });
    expect(() => assertFirstParty(m, OPTS)).toThrow(ExtensionRefusedError);
  });

  it('has no bypass flag: unknown allow options do not bypass refusal', () => {
    const m = manifest({ publisher: 'evil-corp' });
    expect(() =>
      assertFirstParty(m, { ...OPTS, allowThirdParty: true } as never),
    ).toThrow(ExtensionRefusedError);
  });

  it('rejects .. traversal that escapes owned paths', () => {
    const traversals = [
      `${HOME}/.pi/agent/extensions/../evil.js`,
      '/repo/.pi/extensions/../evil',
      '.pi/extensions/../evil',
    ];
    for (const evil of traversals) {
      expect(isOwnedPath(evil, OPTS)).toBe(false);
      expect(() =>
        assertFirstParty(manifest({ sourcePath: evil }), OPTS),
      ).toThrow(ExtensionRefusedError);
    }
  });

  it('still accepts a legit nested path under owned dirs', () => {
    expect(
      isOwnedPath(`${HOME}/.pi/agent/extensions/budget/deep/nested`, OPTS),
    ).toBe(true);
    expect(isOwnedPath('/repo/.pi/extensions/budget/deep/nested', OPTS)).toBe(
      true,
    );
    expect(() =>
      assertFirstParty(
        manifest({
          sourcePath: `${HOME}/.pi/agent/extensions/budget/deep/nested`,
        }),
        OPTS,
      ),
    ).not.toThrow();
  });

  it('refuses percent-encoded traversal segments (fail-closed, no decode sink)', () => {
    const encoded = [
      `${HOME}/.pi/agent/extensions/%2e%2e/evil.js`,
      `${HOME}/.pi/agent/extensions/%2E%2E/evil.js`,
      `${HOME}/.pi/agent/extensions/%252e%252e/evil.js`,
      `${HOME}/.pi/agent/extensions/budget%2f..%2fevil.js`,
      `${HOME}/.pi/agent/extensions/budget%5c..%5cevil.js`,
    ];
    for (const evil of encoded) {
      expect(isOwnedPath(evil, OPTS)).toBe(false);
      expect(() =>
        assertFirstParty(manifest({ sourcePath: evil }), OPTS),
      ).toThrow(ExtensionRefusedError);
    }
    // Control: legit owned paths still pass.
    expect(isOwnedPath(`${HOME}/.pi/agent/extensions/budget`, OPTS)).toBe(true);
    expect(() => assertFirstParty(manifest(), OPTS)).not.toThrow();
  });

  it('FIRST_PARTY_PUBLISHERS is frozen: push cannot admit third-party', () => {
    expect(Object.isFrozen(FIRST_PARTY_PUBLISHERS)).toBe(true);
    try {
      (FIRST_PARTY_PUBLISHERS as unknown as string[]).push('evil-corp');
    } catch {
      // frozen in strict mode: push throws — still refused below either way
    }
    expect(
      (FIRST_PARTY_PUBLISHERS as readonly string[]).includes('evil-corp'),
    ).toBe(false);
    expect(() =>
      assertFirstParty(manifest({ publisher: 'evil-corp' }), OPTS),
    ).toThrow(ExtensionRefusedError);
  });
});
