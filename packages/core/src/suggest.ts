// "Did you mean …?" for mistyped names (EPIC N, issue #450): commands,
// providers and model ids. Pure; shared by the CLI dispatcher (apps), the
// model selection refusals (worker) and `kubic models <provider>` (host).
//
// A candidate qualifies when its edit distance (optimal string alignment:
// insert, delete, substitute, swap two adjacent letters; case-insensitive)
// is within max(2, ⌊len/3⌋) of the input, or — when no candidate is that
// close — when it is the only candidate that contains the input. Ties keep
// the candidates' own order, so the caller decides which wins.

export function editDistance(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const rows = left.length + 1;
  const cols = right.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const above = d[i - 1] as number[];
      let best = Math.min(
        (above[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (above[j - 1] as number) + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        left[i - 1] === right[j - 2] &&
        left[i - 2] === right[j - 1]
      ) {
        best = Math.min(best, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = best;
    }
  }
  return (d[rows - 1] as number[])[cols - 1] as number;
}

/** The closest candidates to `input`, best first (at most `limit`). */
export function suggest(
  input: string,
  candidates: readonly string[],
  limit = 1,
): string[] {
  const needle = input.trim();
  if (needle === '' || candidates.length === 0) return [];
  const threshold = Math.max(2, Math.floor(needle.length / 3));
  const scored = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      distance: editDistance(needle, candidate),
    }))
    .filter(
      (entry) =>
        entry.distance <= threshold &&
        entry.candidate.toLowerCase() !== needle.toLowerCase(),
    )
    .sort((a, b) => a.distance - b.distance || a.index - b.index);
  if (scored.length > 0) {
    return scored.slice(0, limit).map((entry) => entry.candidate);
  }
  const lower = needle.toLowerCase();
  const containing = candidates.filter(
    (candidate) =>
      candidate.toLowerCase() !== lower &&
      candidate.toLowerCase().includes(lower),
  );
  return containing.length === 1 ? containing.slice(0, limit) : [];
}
