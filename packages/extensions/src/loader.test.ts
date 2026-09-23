// Loader ordering: factory + async init before session_start/resources/provider
// flush (issue #37; §31.2–§31.3). RED first.
import { describe, expect, it } from 'vitest';
import { ExtensionRefusedError } from './contract.js';
import { ExtensionLoader } from './loader.js';

const HOME = '/Users/tester';
const OPTS = { homeDir: HOME, cwd: '/repo', allowlist: [] as string[] };

function manifest(overrides = {}) {
  return {
    name: 'kubic/budget',
    publisher: 'kubic',
    version: '0.0.0',
    sourcePath: `${HOME}/.pi/agent/extensions/budget`,
    facets: ['contract', 'host'] as ('contract' | 'host')[],
    ...overrides,
  };
}

describe('extension loader (issue #37, §31)', () => {
  it('runs factory setup + async onActivate before the flush stages', async () => {
    const loader = new ExtensionLoader(OPTS);
    const events: string[] = [];
    const env = {
      use: (_name: string) => undefined,
      flush: (stage: string) => {
        events.push(`flush:${stage}`);
      },
    };
    loader.register(manifest(), () => {
      events.push('setup:kubic/budget');
      return {
        onActivate: async () => {
          events.push('activate:kubic/budget');
        },
      };
    });
    await loader.activateAll(env);
    expect(events).toEqual([
      'setup:kubic/budget',
      'activate:kubic/budget',
      'flush:session_start',
      'flush:resources',
      'flush:provider',
    ]);
  });

  it('refuses third-party bundles at registration with no bypass', () => {
    const loader = new ExtensionLoader(OPTS);
    expect(() =>
      loader.register(manifest({ publisher: 'evil-corp' }), () => undefined),
    ).toThrow(ExtensionRefusedError);
  });

  it('refuses unowned resolve targets', () => {
    const loader = new ExtensionLoader(OPTS);
    expect(() => loader.resolve('https://evil.example/x.js')).toThrow(
      ExtensionRefusedError,
    );
    expect(loader.resolve('@kubic/agents')).toBe('@kubic/agents');
  });
});
