// §62 strict 8-lever cost order (issue #56).
// The levers minimize total task cost — not token price — and apply in
// order, observably. Applying a later lever before an earlier one is a
// review-blocking skip (e.g. cache work before per-role selection).
// Pure: no I/O, no network, faux-only.

export const COST_LEVERS = [
  'role-model',
  'cache-preservation',
  'compact-reuse',
  'spawn-gate',
  'retry-discipline',
  'output-limits',
  'escalation',
  'exact-cache',
] as const;

export type CostLever = (typeof COST_LEVERS)[number];

export type LeverOrderVerdict =
  | { ok: true }
  | { ok: false; reason: string; missing: string[]; reviewBlocking: true };

function isLever(value: string): value is CostLever {
  return (COST_LEVERS as readonly string[]).includes(value);
}

export function assertLeverOrder(applied: string[]): LeverOrderVerdict {
  const seen = new Set<string>();
  for (const lever of applied) {
    if (!isLever(lever)) {
      return {
        ok: false,
        reason: `unknown cost lever '${lever}': not in §62 order`,
        missing: [],
        reviewBlocking: true,
      };
    }
    const idx = COST_LEVERS.indexOf(lever);
    const missing = COST_LEVERS.slice(0, idx).filter(
      (earlier) => !seen.has(earlier),
    );
    if (missing.length > 0) {
      return {
        ok: false,
        reason:
          `§62 order violated: '${lever}' applied before ` +
          `${missing.map((m) => `'${m}'`).join(', ')}`,
        missing: [...missing],
        reviewBlocking: true,
      };
    }
    seen.add(lever);
  }
  return { ok: true };
}

export function nextRequiredLever(applied: string[]): CostLever | undefined {
  const seen = new Set(applied);
  return COST_LEVERS.find((lever) => !seen.has(lever));
}
