const BRACE_LIMIT = 32;

export function pathSegments(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[\\/]/)
    .filter((part) => part !== '');
}

// Can the (possibly globbed) path `segments` name `dir` itself or something
// below it that is protected? `subs` lists the protected first-level names;
// undefined protects everything below (the session root).
export function globReaches(
  segments: readonly string[],
  dir: readonly string[],
  subs: readonly string[] | undefined,
): boolean {
  // A path shorter than `dir` runs out of segments: '' matches no name.
  for (let index = 0; index < dir.length; index += 1) {
    if (!globMatches(segments[index] ?? '', dir[index] ?? '')) return false;
  }
  if (segments.length === dir.length || subs === undefined) return true;
  const next = segments[dir.length] ?? '';
  return subs.some((sub) => globMatches(next, sub));
}

// fnmatch for one path segment (both sides case-folded): `*`, `?`, `[set]`,
// `[!set]` / `[^set]` and ranges. Iterative with one backtrack point, so it is
// O(pattern x name) whatever the pattern.
function globMatches(pattern: string, name: string): boolean {
  if (!/[*?[]/.test(pattern)) return pattern === name;
  let p = 0;
  let n = 0;
  let starAt = -1;
  let starName = 0;
  while (n < name.length) {
    if (pattern[p] === '*') {
      starAt = p;
      starName = n;
      p += 1;
      continue;
    }
    const next = p < pattern.length ? matchOne(pattern, p, name[n] ?? '') : -1;
    if (next >= 0) {
      p = next;
      n += 1;
    } else if (starAt >= 0) {
      p = starAt + 1;
      starName += 1;
      n = starName;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
}

// One pattern element against one character: the pattern index after it, or -1.
function matchOne(pattern: string, at: number, char: string): number {
  const first = pattern[at];
  if (first === '?') return at + 1;
  if (first === '[') {
    const negate = pattern[at + 1] === '!' || pattern[at + 1] === '^';
    const start = at + (negate ? 2 : 1);
    const close = pattern.indexOf(']', start + 1);
    if (close > 0) {
      let inSet = false;
      for (let index = start; index < close; index += 1) {
        const from = pattern[index] ?? '';
        if (pattern[index + 1] === '-' && index + 2 < close) {
          if (char >= from && char <= (pattern[index + 2] ?? '')) inSet = true;
          index += 2;
        } else if (char === from) {
          inSet = true;
        }
      }
      return inSet === !negate ? close + 1 : -1;
    }
  }
  return first === char ? at + 1 : -1;
}

// `a{b,c}d` -> `abd`, `acd` (nested and multiple groups; a group with no comma
// is literal). undefined when the enumeration would pass BRACE_LIMIT or the
// text is too long to scan.
export function expandBraces(text: string): string[] | undefined {
  if (text.length > 2048) return undefined;
  const pending = [text];
  const done: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop() ?? '';
    const group = firstBraceGroup(current);
    if (group === undefined) {
      done.push(current);
    } else {
      for (const option of group.options) {
        pending.push(group.before + option + group.after);
      }
    }
    if (done.length + pending.length > BRACE_LIMIT) return undefined;
  }
  return done;
}

function firstBraceGroup(
  text: string,
): { before: string; options: string[]; after: string } | undefined {
  for (
    let open = text.indexOf('{');
    open >= 0;
    open = text.indexOf('{', open + 1)
  ) {
    let depth = 0;
    const commas: number[] = [];
    for (let index = open; index < text.length; index += 1) {
      const char = text[index];
      if (char === '{') depth += 1;
      else if (char === ',' && depth === 1) commas.push(index);
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          if (commas.length === 0) break;
          const bounds = [open, ...commas, index];
          return {
            before: text.slice(0, open),
            options: bounds
              .slice(0, -1)
              .map((from, at) => text.slice(from + 1, bounds[at + 1])),
            after: text.slice(index + 1),
          };
        }
      }
    }
  }
  return undefined;
}
