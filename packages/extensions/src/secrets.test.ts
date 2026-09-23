// Secrets: local-full + narrow non-secret facade (issue #37; §32). RED first.
import { describe, expect, it } from 'vitest';
import { SecretRemoteError, SecretStore } from './secrets.js';

describe('extension secrets (issue #37, §32)', () => {
  it('resolves the full secret locally', () => {
    const store = new SecretStore();
    store.set('db/password', 's3cret');
    expect(store.getLocal('db/password')).toBe('s3cret');
  });

  it('exposes a narrow non-secret facade only', () => {
    const store = new SecretStore();
    store.set('db/password', 's3cret');
    const facade = store.facade('db/password');
    expect(facade.name).toBe('db/password');
    expect(facade.hasValue).toBe(true);
    expect(JSON.stringify(facade)).not.toContain('s3cret');
    expect('value' in facade).toBe(false);
  });

  it('refuses remote resolution of a secret-holding local', () => {
    const store = new SecretStore();
    store.set('db/password', 's3cret');
    expect(() => store.resolveRemote('db/password')).toThrow(SecretRemoteError);
  });
});

// Extension-secret hardening (issue #69): missing-secret branches must throw
// the plain not-found error, never the remote-refusal one.
describe('extension secrets hardening (issue #69)', () => {
  it('throws not-found (not remote-refusal) for a missing local', () => {
    const store = new SecretStore();
    try {
      store.getLocal('db/missing');
      expect.unreachable();
    } catch (error) {
      expect(error).not.toBeInstanceOf(SecretRemoteError);
      expect((error as Error).message).toMatch(/secret not found/);
      expect((error as Error).message).toMatch(/db\/missing/);
    }
  });

  it('throws not-found (not remote-refusal) for a missing remote', () => {
    const store = new SecretStore();
    try {
      store.resolveRemote('db/missing');
      expect.unreachable();
    } catch (error) {
      expect(error).not.toBeInstanceOf(SecretRemoteError);
      expect((error as Error).message).toMatch(/secret not found/);
    }
  });

  it('pins the remote-refusal error name and message', () => {
    const store = new SecretStore();
    store.set('db/password', 's3cret');
    try {
      store.resolveRemote('db/password');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).name).toBe('SecretRemoteError');
      expect((error as Error).message).toMatch(/local-only/);
      expect((error as Error).message).toMatch(/db\/password/);
    }
  });

  it('reports hasValue false for missing names without leaking', () => {
    const store = new SecretStore();
    const facade = store.facade('db/missing');
    expect(facade).toEqual({ name: 'db/missing', hasValue: false });
    expect(JSON.stringify(facade)).not.toContain('s3cret');
  });

  it('overwrites on re-set and resolves the latest value', () => {
    const store = new SecretStore();
    store.set('db/password', 'old-value');
    store.set('db/password', 'new-value');
    expect(store.getLocal('db/password')).toBe('new-value');
  });
});
