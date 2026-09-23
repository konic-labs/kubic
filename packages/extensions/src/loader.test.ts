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

  it('refuses .. traversal on register AND resolve', () => {
    const traversals = [
      `${HOME}/.pi/agent/extensions/../evil.js`,
      '/repo/.pi/extensions/../evil',
      '.pi/extensions/../evil',
    ];
    for (const evil of traversals) {
      const loader = new ExtensionLoader(OPTS);
      expect(() =>
        loader.register(manifest({ sourcePath: evil }), () => undefined),
      ).toThrow(ExtensionRefusedError);
      expect(() => loader.resolve(evil)).toThrow(ExtensionRefusedError);
    }
  });

  it('still resolves a legit nested path under owned dirs', () => {
    const loader = new ExtensionLoader(OPTS);
    expect(
      loader.resolve(`${HOME}/.pi/agent/extensions/budget/deep/nested`),
    ).toBe(`${HOME}/.pi/agent/extensions/budget/deep/nested`);
  });
});

// Loader hardening (issue #69): registration ledger and activation edge
// cases pinned so dropped steps fail loudly.
describe('extension loader hardening (issue #69)', () => {
  it('starts with an empty ledger and lists names in order', () => {
    const loader = new ExtensionLoader(OPTS);
    expect(loader.registered).toEqual([]);
    loader.register(manifest({ name: 'kubic/a' }), () => undefined);
    loader.register(manifest({ name: 'kubic/b' }), () => undefined);
    expect(loader.registered).toEqual(['kubic/a', 'kubic/b']);
  });

  it('skips factories that return undefined, flush still runs in order', async () => {
    const loader = new ExtensionLoader(OPTS);
    const events: string[] = [];
    loader.register(manifest(), () => undefined);
    await loader.activateAll({
      use: () => undefined,
      flush: (stage: string) => {
        events.push(`flush:${stage}`);
      },
    });
    expect(events).toEqual([
      'flush:session_start',
      'flush:resources',
      'flush:provider',
    ]);
  });

  it('flushes nothing extra with zero registrations', async () => {
    const loader = new ExtensionLoader(OPTS);
    const events: string[] = [];
    await loader.activateAll({
      use: () => undefined,
      flush: (stage: string) => {
        events.push(String(stage));
      },
    });
    expect(events).toEqual(['session_start', 'resources', 'provider']);
  });

  it('resolves owned relative and package specifiers unchanged', () => {
    const loader = new ExtensionLoader(OPTS);
    expect(loader.resolve('.pi/extensions/budget')).toBe(
      '.pi/extensions/budget',
    );
    expect(loader.resolve('kubic/budget')).toBe('kubic/budget');
  });

  it('refuses first-party publishers on unowned paths at register', () => {
    const loader = new ExtensionLoader(OPTS);
    expect(() =>
      loader.register(
        manifest({ publisher: 'kubic', sourcePath: '/tmp/evil/bundle' }),
        () => undefined,
      ),
    ).toThrow(/not an owned path/i);
    expect(loader.registered).toEqual([]);
  });

  it('pins the refusal message on resolve', () => {
    const loader = new ExtensionLoader(OPTS);
    try {
      loader.resolve('https://evil.example/x.js');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExtensionRefusedError);
      expect((error as Error).name).toBe('ExtensionRefusedError');
      expect((error as Error).message).toMatch(/not an owned path/);
    }
  });
});
