// Deterministic manifest encoding (issue #54; design §74).
// canonicalJson sorts object keys recursively so the same trajectory +
// verifier always serializes byte-identically. Builders emit no
// timestamps or random ids, so determinism holds by construction.
export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map(stringifyCanonical).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry) => entry[1] !== undefined)
      .sort((left, right) =>
        left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
      );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stringifyCanonical(entry)}`).join(',')}}`;
  }
  throw new Error(`uncapturable value of type ${typeof value}`);
}
