// Trust + third-party refusal (issue #37; §31.1, §31.5). RED first.
import { describe, expect, it } from 'vitest';
import { ExtensionRefusedError } from './contract.js';
import { assertFirstParty, isFirstParty, isOwnedPath } from './trust.js';

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
});
