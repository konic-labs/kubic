// Trusting the operating system's certificate store: Node's bundled roots
// stay and the system's are added, for every TLS connection this process
// opens afterwards — a provider request, an https collector, the approval
// broker. A corporate root that device management installed in the store is
// then trusted without NODE_EXTRA_CA_CERTS.

import * as tls from 'node:tls';

type CaKind = 'default' | 'system' | 'bundled' | 'extra';

/** The slice of node:tls this reads and sets (absent on an older Node). */
export interface TrustStoreApi {
  getCACertificates?: (type?: CaKind) => string[];
  setDefaultCACertificates?: (certs: readonly string[]) => void;
}

export function trustSystemCertificates(
  api: TrustStoreApi = tls as unknown as TrustStoreApi,
): { readonly added: number } | { readonly unsupported: string } {
  if (
    typeof api.getCACertificates !== 'function' ||
    typeof api.setDefaultCACertificates !== 'function'
  ) {
    return {
      unsupported: `this Node (${process.version}) cannot add the system certificate store while running; start it with NODE_OPTIONS=--use-system-ca`,
    };
  }
  try {
    const current = api.getCACertificates('default');
    const known = new Set(current);
    const added = api
      .getCACertificates('system')
      .filter((cert) => !known.has(cert));
    if (added.length > 0) api.setDefaultCACertificates([...current, ...added]);
    return { added: added.length };
  } catch (error) {
    return {
      unsupported: `the system certificate store could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
