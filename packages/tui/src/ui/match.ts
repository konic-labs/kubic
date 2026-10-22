// Fuzzy match positions for highlighting (the palette's
// accent letters). Ranking stays with Pi's fuzzyFilter where
// a list is ordered; this module only answers *which letters* matched.
//
// Case-insensitive subsequence match. A contiguous run is preferred (the
// first occurrence of the whole query); otherwise each query character takes
// the earliest position that starts a word (after a non-alphanumeric, or at
// a lower→upper case change) when the rest of the query can still match
// after it, else the earliest position at all.

import type { Style } from '@kubic/core/ui/style';

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1] ?? '';
  const current = text[index] ?? '';
  if (!/[A-Za-z0-9]/.test(previous)) return true;
  return /[a-z]/.test(previous) && /[A-Z]/.test(current);
}

function canFinish(
  lower: string,
  query: string,
  from: number,
  q: number,
): boolean {
  let cursor = from;
  for (let index = q; index < query.length; index += 1) {
    const found = lower.indexOf(query[index] as string, cursor);
    if (found === -1) return false;
    cursor = found + 1;
  }
  return true;
}

/** Matched indices (code units) of `query` in `text`, or undefined. */
export function fuzzyPositions(
  query: string,
  text: string,
): number[] | undefined {
  const needle = query.toLowerCase();
  if (needle === '') return [];
  const lower = text.toLowerCase();
  const run = lower.indexOf(needle);
  if (run !== -1) {
    return Array.from({ length: needle.length }, (_, offset) => run + offset);
  }
  const positions: number[] = [];
  let cursor = 0;
  for (let q = 0; q < needle.length; q += 1) {
    const char = needle[q] as string;
    let first = -1;
    let preferred = -1;
    for (
      let index = lower.indexOf(char, cursor);
      index !== -1;
      index = lower.indexOf(char, index + 1)
    ) {
      if (!canFinish(lower, needle, index + 1, q + 1)) break;
      if (first === -1) first = index;
      if (isWordStart(text, index)) {
        preferred = index;
        break;
      }
    }
    const pick = preferred !== -1 ? preferred : first;
    if (pick === -1) return undefined;
    positions.push(pick);
    cursor = pick + 1;
  }
  return positions;
}

/**
 * `text` with the characters at `positions` styled (runs merged); the runs
 * between them take `rest` when given (the palette's row colour).
 */
export function highlightPositions(
  text: string,
  positions: readonly number[],
  style: Style,
  rest: Style = (part) => part,
): string {
  if (positions.length === 0) return text === '' ? '' : rest(text);
  const marked = new Set(positions);
  let out = '';
  let run = '';
  let plain = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (marked.has(index)) {
      if (plain !== '') {
        out += rest(plain);
        plain = '';
      }
      run += char;
      continue;
    }
    if (run !== '') {
      out += style(run);
      run = '';
    }
    plain += char;
  }
  if (run !== '') out += style(run);
  if (plain !== '') out += rest(plain);
  return out;
}
