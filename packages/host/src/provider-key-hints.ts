// What a keyless provider needs: the
// variable Pi's own auth check would read, so the model picker can say
// `○ no key  set OPENAI_API_KEY` instead of hiding the provider. Kubic keeps
// no table of its own: a throwaway catalogue of Pi's built-ins whose auth
// context claims a variable is set asks each provider's check which source
// it would use — an `*_API_KEY` first (the conventional name to suggest),
// else any variable at all. The context never reads the real environment
// or the disk, and no credential is involved.

import {
  builtinProviders,
  createModels,
} from '../../worker/src/pi-boundary.js';

type AuthContext = NonNullable<
  NonNullable<Parameters<typeof createModels>[0]>['authContext']
>;

function probeContext(claims: (name: string) => boolean): AuthContext {
  return {
    env: async (name: string) => (claims(name) ? `probe:${name}` : undefined),
    fileExists: async () => false,
  };
}

async function sources(
  providers: readonly string[],
  claims: (name: string) => boolean,
): Promise<Map<string, string>> {
  const models = createModels({ authContext: probeContext(claims) });
  for (const provider of builtinProviders()) {
    if (providers.includes(provider.id)) models.setProvider(provider);
  }
  const found = new Map<string, string>();
  for (const id of providers) {
    try {
      const check = await models.checkAuth(id);
      if (check?.source !== undefined) found.set(id, check.source);
    } catch {
      // Unknown or OAuth-only: nothing to suggest.
    }
  }
  return found;
}

/** Provider id → the variable that would authenticate it. */
export async function providerKeyHints(
  providers: readonly string[],
): Promise<Map<string, string>> {
  const conventional = await sources(providers, (name) =>
    name.endsWith('_API_KEY'),
  );
  const rest = providers.filter((id) => !conventional.has(id));
  const any = rest.length === 0 ? new Map() : await sources(rest, () => true);
  return new Map([...conventional, ...any]);
}
