// Dogfood: the budget surface ships as a first-party bundle via the public
// loader path (issue #37). RED first. Reads agents/budget read-only.
import { describe, expect, it } from 'vitest';
import { ExtensionLoader } from '../loader.js';
import { createBudgetBundle } from './budget/index.js';

const HOME = '/Users/tester';
const OPTS = { homeDir: HOME, cwd: '/repo', allowlist: [] as string[] };

describe('budget bundle dogfood (issue #37)', () => {
  it('loads via the public loader path and exposes budget limits', async () => {
    const loader = new ExtensionLoader(OPTS);
    const bundle = createBudgetBundle({ maxTokens: 100 });
    loader.register(bundle.manifest, bundle.factory);
    const provided: Record<string, unknown> = {};
    await loader.activateAll({
      use: (_name: string) => undefined,
      provide: (name: string, impl: unknown) => {
        provided[name] = impl;
      },
      flush: (_stage: string) => undefined,
    });
    expect(bundle.manifest.publisher).toBe('kubic');
    expect(provided['budget/limits']).toEqual({ maxTokens: 100 });
  });

  it('delegates to the real agents budget surface (no defaults smuggled)', async () => {
    const bundle = createBudgetBundle({});
    const seen: unknown[] = [];
    await bundle
      .factory({
        use: () => undefined,
        provide: (name: string, impl: unknown) => {
          seen.push([name, impl]);
        },
        flush: () => undefined,
      })
      ?.onActivate?.();
    expect(seen).toEqual([['budget/limits', {}]]);
  });
});
