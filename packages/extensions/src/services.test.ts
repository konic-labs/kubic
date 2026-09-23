// Services: provide/provideMany/use/observe via env.use(); local:{true}
// never remote (issue #37; §32). RED first.
import { describe, expect, it } from 'vitest';
import { createEnv, ServiceRegistry } from './services.js';

describe('extension services (issue #37, §32)', () => {
  it('provides and uses a service via env.use()', () => {
    const registry = new ServiceRegistry();
    registry.provide('budget/limits', { maxTokens: 100 });
    const env = createEnv(registry);
    expect(env.use('budget/limits')).toEqual({ maxTokens: 100 });
  });

  it('supports provideMany', () => {
    const registry = new ServiceRegistry();
    registry.provideMany([
      { name: 'a', impl: 1 },
      { name: 'b', impl: 2 },
    ]);
    expect(registry.use('a')).toBe(1);
    expect(registry.use('b')).toBe(2);
  });

  it('notifies observers on provide', () => {
    const registry = new ServiceRegistry();
    const seen: unknown[] = [];
    const unsub = registry.observe('x', (impl) => {
      seen.push(impl);
    });
    registry.provide('x', 42);
    expect(seen).toEqual([42]);
    unsub();
    registry.provide('x', 43);
    expect(seen).toEqual([42]);
  });

  it('local:{true} services are never resolvable remotely', () => {
    const registry = new ServiceRegistry();
    registry.provide('secrets/db', { token: 's3cret' }, { local: true });
    expect(registry.use('secrets/db')).toEqual({ token: 's3cret' });
    expect(() => registry.use('secrets/db', { remote: true })).toThrow(
      /local.*never remote|never.*remote/i,
    );
  });
});
