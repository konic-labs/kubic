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

// Refusal-path hardening (issue #69): every owned-path boundary branch is
// pinned so a removed refusal fails a test, not just lowers a score.
describe('owned-path boundaries (issue #69)', () => {
  it('refuses empty and blank specs', () => {
    expect(isOwnedPath('', OPTS)).toBe(false);
    expect(isOwnedPath('   ', OPTS)).toBe(false);
  });

  it('refuses dot and climbing relative specs', () => {
    expect(isOwnedPath('.', OPTS)).toBe(false);
    expect(isOwnedPath('..', OPTS)).toBe(false);
    expect(isOwnedPath('../evil', OPTS)).toBe(false);
    expect(isOwnedPath('../../evil', OPTS)).toBe(false);
  });

  it('accepts exact owned directory roots', () => {
    expect(isOwnedPath(`${HOME}/.pi/agent/extensions`, OPTS)).toBe(true);
    expect(isOwnedPath('/repo/.pi/extensions', OPTS)).toBe(true);
    expect(isOwnedPath('.pi/extensions', OPTS)).toBe(true);
  });

  it('refuses http and ftp remotes, not just https', () => {
    expect(isOwnedPath('http://evil.example/bundle.js', OPTS)).toBe(false);
    expect(isOwnedPath('ftp://evil.example/bundle.js', OPTS)).toBe(false);
    expect(() =>
      assertFirstParty(
        manifest({ sourcePath: 'http://evil.example/bundle.js' }),
        OPTS,
      ),
    ).toThrow(ExtensionRefusedError);
  });

  it('never admits a remote specifier via the allowlist', () => {
    // Regression: posix normalize collapses 'https://' to 'https:/', so a
    // mangled allowlist entry used to match a remote URL post-normalization.
    const opts = {
      ...OPTS,
      allowlist: ['https:/evil.example/bundle.js'],
    };
    expect(isOwnedPath('https://evil.example/bundle.js', opts)).toBe(false);
    expect(() =>
      assertFirstParty(
        manifest({ sourcePath: 'https://evil.example/bundle.js' }),
        opts,
      ),
    ).toThrow(ExtensionRefusedError);
  });

  it('refuses case-variant remote schemes: URL schemes are case-insensitive', () => {
    // Regression: the remote-specifier guard matched lowercase schemes only,
    // but new URL('HTTPS://evil.example/bundle.js').protocol === 'https:' —
    // a case-variant remote is still a parseable remote URL and never owned.
    const variants = [
      'HTTPS://evil.example/bundle.js',
      'Http://evil.example/bundle.js',
      'HTTP://evil.example/bundle.js',
      'FTP://evil.example/bundle.js',
      'fTp://evil.example/bundle.js',
      '  HTTPS://evil.example/bundle.js  ',
    ];
    for (const evil of variants) {
      expect(isOwnedPath(evil, OPTS)).toBe(false);
      expect(() =>
        assertFirstParty(manifest({ sourcePath: evil }), OPTS),
      ).toThrow(ExtensionRefusedError);
    }
  });

  it('never admits a case-variant remote via a mangled allowlist entry', () => {
    const cases: Array<[string, string[]]> = [
      ['HTTPS://evil.example/bundle.js', ['HTTPS:/evil.example/bundle.js']],
      ['Http://evil.example/bundle.js', ['Http:/evil.example/bundle.js']],
      ['FTP://evil.example/bundle.js', ['FTP:/evil.example/bundle.js']],
    ];
    for (const [evil, allowlist] of cases) {
      const opts = { ...OPTS, allowlist };
      expect(isOwnedPath(evil, opts)).toBe(false);
      expect(() =>
        assertFirstParty(manifest({ sourcePath: evil }), opts),
      ).toThrow(ExtensionRefusedError);
    }
  });

  it('normalizes non-string specs to the fail-closed boundary error type', () => {
    // A non-string spec used to leak a raw TypeError from String methods;
    // the trust boundary reports refusal as ExtensionRefusedError instead.
    for (const bad of [123, null, undefined, {}, ['x']] as never[]) {
      try {
        isOwnedPath(bad, OPTS);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ExtensionRefusedError);
        expect(error).not.toBeInstanceOf(TypeError);
      }
    }
    expect(() =>
      assertFirstParty(manifest({ sourcePath: 123 as never }), OPTS),
    ).toThrow(ExtensionRefusedError);
    expect(isFirstParty(manifest({ sourcePath: 123 as never }), OPTS)).toBe(
      false,
    );
  });

  it('accepts a first-party publisher with no sourcePath', () => {
    const m = manifest({ publisher: 'konic-labs' });
    delete (m as Record<string, unknown>).sourcePath;
    expect(isFirstParty(m, OPTS)).toBe(true);
    expect(() => assertFirstParty(m, OPTS)).not.toThrow();
  });

  it('refuses a first-party publisher on an unowned path', () => {
    const m = manifest({
      publisher: 'konic-labs',
      sourcePath: '/tmp/evil/bundle',
    });
    expect(isFirstParty(m, OPTS)).toBe(false);
    expect(() => assertFirstParty(m, OPTS)).toThrow(/not an owned path/i);
  });

  it('pins refusal error names and messages', () => {
    try {
      assertFirstParty(manifest({ publisher: 'evil-corp' }), OPTS);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionRefusedError);
      expect((error as Error).name).toBe('ExtensionRefusedError');
      expect((error as Error).message).toMatch(/not first-party/);
    }
    try {
      assertFirstParty(manifest({ sourcePath: '/tmp/evil/bundle' }), OPTS);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).name).toBe('ExtensionRefusedError');
      expect((error as Error).message).toMatch(/not an owned path/);
    }
  });
});
