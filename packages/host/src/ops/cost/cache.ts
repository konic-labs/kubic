// (2) cache preservation check + prefix hit-rate.
// A prompt/prefix edit that breaks the cache prefix forces a full-price
// re-read; this gate names what broke it. Prefix hit-rate is measurable
// from usage rows (cacheRead > 0 counts as a prefix hit). The transparent
// caching note is the user-visible statement that caching is observable,
// never silent. Pure: no I/O, no network, faux-only.

export interface PrefixHitRate {
  hits: number;
  total: number;
  rate: number;
}

export function prefixHitRate(
  rows: ReadonlyArray<{ cacheRead: number; cacheWrite: number }>,
): PrefixHitRate {
  let hits = 0;
  for (const row of rows) {
    if (row.cacheRead > 0) hits += 1;
  }
  const total = rows.length;
  return { hits, total, rate: total === 0 ? 0 : hits / total };
}

export function transparentCachingNote(): string {
  return (
    'caching is transparent: prefix hits/misses and exact-cache hits are ' +
    'reported per session; no silent cache rewrites, no hidden routing'
  );
}
