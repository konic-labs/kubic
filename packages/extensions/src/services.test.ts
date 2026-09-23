// Services: provide/provideMany/use/observe via env.use(); local:{true}
// never remote (issue #37; §32). RED first.
import { describe, expect, it } from 'vitest';
import {
  createEnv,
  ServiceNotFoundError,
  ServiceRegistry,
  ServiceRemoteError,
} from './services.js';

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

  it('remote gate is fail-closed on truthy non-boolean flags', () => {
    const registry = new ServiceRegistry();
    registry.provide('secrets/db', { token: 's3cret' }, { local: true });
    expect(() => registry.use('secrets/db', { remote: 1 } as never)).toThrow(
      ServiceRemoteError,
    );
    expect(() =>
      registry.use('secrets/db', { remote: 'yes' } as never),
    ).toThrow(ServiceRemoteError);
  });
});

// Service registry hardening (issue #69): missing-service and re-provide
// branches pinned with exact errors.
describe('extension services hardening (issue #69)', () => {
  it('throws ServiceNotFoundError naming the missing service', () => {
    const registry = new ServiceRegistry();
    try {
      registry.use('nope/missing');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceNotFoundError);
      expect((error as Error).name).toBe('ServiceNotFoundError');
      expect((error as Error).message).toMatch(/nope\/missing/);
    }
    try {
      createEnv(registry).use('nope/missing');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceNotFoundError);
    }
  });

  it('pins the remote-refusal error name and service name', () => {
    const registry = new ServiceRegistry();
    registry.provide('secrets/db', { token: 's3cret' }, { local: true });
    try {
      registry.use('secrets/db', { remote: true });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).name).toBe('ServiceRemoteError');
      expect((error as Error).message).toMatch(/secrets\/db/);
    }
    // Non-local services stay remotely resolvable.
    registry.provide('shared/clock', { now: 1 });
    expect(registry.use('shared/clock', { remote: true })).toEqual({ now: 1 });
  });

  it('re-provide overwrites and notifies with the latest impl', () => {
    const registry = new ServiceRegistry();
    const seen: unknown[] = [];
    registry.observe('x', (impl) => {
      seen.push(impl);
    });
    registry.provide('x', 1);
    registry.provide('x', 2);
    expect(registry.use('x')).toBe(2);
    expect(seen).toEqual([1, 2]);
  });

  it('notifies every watcher and tolerates double-unsubscribe', () => {
    const registry = new ServiceRegistry();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const unsub = registry.observe('x', (impl) => {
      first.push(impl);
    });
    registry.observe('x', (impl) => {
      second.push(impl);
    });
    registry.provide('x', 7);
    expect(first).toEqual([7]);
    expect(second).toEqual([7]);
    unsub();
    unsub();
    registry.provide('x', 8);
    expect(first).toEqual([7]);
    expect(second).toEqual([7, 8]);
  });

  it('returns the identical impl reference via env', () => {
    const registry = new ServiceRegistry();
    const impl = { maxTokens: 100 };
    registry.provide('budget/limits', impl);
    expect(createEnv(registry).use('budget/limits')).toBe(impl);
  });
});
