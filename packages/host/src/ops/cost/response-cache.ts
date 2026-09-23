// (8) exact response cache now; semantic explicitly deferred (issue #56;
// §62 lever 8). Exact-key hits (prompt+model+resources, byte-identical)
// are served without a model call. Semantic caching has NO code path by
// design — semanticLookup always throws, and the deferred note documents
// the follow-up. Pure, faux-only.

export const SEMANTIC_DEFERRED_NOTE =
  'semantic response cache is deferred to a follow-up issue: ' +
  'no semantic code path exists; only the exact cache ships now';

export class SemanticCacheDeferredError extends Error {
  constructor() {
    super(`${SEMANTIC_DEFERRED_NOTE}`);
    this.name = 'SemanticCacheDeferredError';
  }
}

export interface ExactCacheStats {
  hits: number;
  total: number;
  rate: number;
}

export interface ExactResponseCache {
  get(key: string): string | undefined;
  set(key: string, response: string): void;
  stats(): ExactCacheStats;
}

export function createExactCache(): ExactResponseCache {
  const entries = new Map<string, string>();
  let hits = 0;
  let total = 0;
  return {
    get(key: string): string | undefined {
      total += 1;
      const hit = entries.get(key);
      if (hit !== undefined) hits += 1;
      return hit;
    },
    set(key: string, response: string): void {
      entries.set(key, response);
    },
    stats(): ExactCacheStats {
      return { hits, total, rate: total === 0 ? 0 : hits / total };
    },
  };
}

export function semanticLookup(_query: string): never {
  throw new SemanticCacheDeferredError();
}
