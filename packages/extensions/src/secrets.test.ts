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
