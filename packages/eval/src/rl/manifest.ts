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
    const record = value as Record<string, unknown>;
    // Default string order is UTF-16 code-unit order — the same total
    // order an explicit comparator would implement, minus its equality
    // branch (object keys are unique, so that branch is unreachable).
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stringifyCanonical(record[key])}`).join(',')}}`;
  }
  throw new Error(`uncapturable value of type ${typeof value}`);
}
