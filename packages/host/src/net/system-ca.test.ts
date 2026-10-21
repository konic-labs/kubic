// Trusting the system certificate store: the system's roots join the
// defaults (none twice), and a Node without the API says what to do instead.
import { describe, expect, it } from 'vitest';
import { type TrustStoreApi, trustSystemCertificates } from './system-ca.js';

describe('trustSystemCertificates', () => {
  it('adds the system roots to the defaults', () => {
    let set: readonly string[] | undefined;
    const api: TrustStoreApi = {
      getCACertificates: (type) =>
        type === 'system' ? ['corp-root', 'shared-root'] : ['shared-root'],
      setDefaultCACertificates: (certs) => {
        set = certs;
      },
    };
    expect(trustSystemCertificates(api)).toEqual({ added: 1 });
    expect(set).toEqual(['shared-root', 'corp-root']);
  });

  it('names the remedy on a Node without the API', () => {
    const result = trustSystemCertificates({});
    expect(result).toMatchObject({
      unsupported: expect.stringContaining('NODE_OPTIONS=--use-system-ca'),
    });
  });

  it('names a store that cannot be read', () => {
    const result = trustSystemCertificates({
      getCACertificates: () => {
        throw new Error('no keychain');
      },
      setDefaultCACertificates: () => undefined,
    });
    expect(result).toEqual({
      unsupported:
        'the system certificate store could not be read: no keychain',
    });
  });
});
