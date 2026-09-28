// Shared .gitignore-subset matcher (issues #116, #172).
//
// Extracted from the journal baseline walk so the worker's find/grep walk and
// the journal walk cannot drift into two different notions of "ignored": a
// path that is out of scope for `kubic diff`/`undo` must not be searched
// repo-wide either. The subset is deliberately small and documented in
// docs/packages/exec.md: `*`, `?`, `**` (a leading `**/` matches zero or more
// directories), `dir/` prefixes, `!` negation, last match wins. Exotic forms
// (character classes beyond `?`, rooted mid-pattern `**`) are not covered —
// anything missed only widens the set of walked paths, never narrows it.
//
// Matching is a linear DP over compiled tokens, never a backtracking regex
// (#172 review): a hostile `*a*a*a*a*a*` line in a `.gitignore` must cost
// O(pattern x path) per entry, not exponential time on every walked path.

type GlobToken =
  | { kind: 'char'; value: string } // a literal character
  | { kind: 'any' } // ? — exactly one char, never '/'
  | { kind: 'star' } // * — zero+ chars, never '/'
  | { kind: 'globstar' } // ** — zero+ chars, '/' included
  | { kind: 'leading-globstar' }; // **/ — '' or any run ending in '/'

// Compile one glob to its tokens. `**/` at the START additionally matches
// zero leading directories: git matches `**/foo` at the root, which a plain
// `.*\/` cannot (it demands a slash). Mid-pattern `**` stays the documented
// globstar (the subset does not model the rooted `a/**/b` form).
function compileGlob(glob: string): (text: string) => boolean {
  const tokens: GlobToken[] = [];
  let i = 0;
  if (glob.startsWith('**/')) {
    tokens.push({ kind: 'leading-globstar' });
    i = 3;
  }
  for (; i < glob.length; i += 1) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        tokens.push({ kind: 'globstar' });
        i += 1;
      } else {
        tokens.push({ kind: 'star' });
      }
    } else if (c === '?') {
      tokens.push({ kind: 'any' });
    } else {
      tokens.push({ kind: 'char', value: c });
    }
  }
  return (text: string) => globMatches(tokens, text);
}

// Iterative row DP, O(tokens x text), no backtracking: row[i] means the
// token prefix so far matches text[0..i). Each token advances one row.
function globMatches(tokens: GlobToken[], text: string): boolean {
  const n = text.length;
  let row = new Uint8Array(n + 1);
  row[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(n + 1);
    if (token.kind === 'star' || token.kind === 'globstar') {
      const slashless = token.kind === 'star';
      let reachable = false;
      for (let i = 0; i <= n; i += 1) {
        if (row[i] === 1) reachable = true;
        if (reachable) next[i] = 1;
        // Consuming text[i] is what reaches i + 1, so a '/' blocks a
        // slashless star from there on.
        if (slashless && i < n && text[i] === '/') reachable = false;
      }
    } else if (token.kind === 'leading-globstar') {
      let seen = false;
      for (let i = 0; i <= n; i += 1) {
        if (row[i] === 1) seen = true;
        if (row[i] === 1 || (seen && i > 0 && text[i - 1] === '/')) {
          next[i] = 1;
        }
      }
    } else {
      for (let i = 0; i < n; i += 1) {
        if (row[i] !== 1) continue;
        const ch = text[i] as string;
        if (token.kind === 'any' ? ch !== '/' : ch === token.value) {
          next[i + 1] = 1;
        }
      }
    }
    row = next;
  }
  return row[n] === 1;
}

export interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
  match: (text: string) => boolean;
}

export function parseIgnoreFile(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    const body = negate ? line.slice(1) : line;
    const dirOnly = body.endsWith('/');
    const stripped = dirOnly ? body.slice(0, -1) : body;
    const anchored = stripped.includes('/');
    const pattern = anchored ? stripped.replace(/^\//, '') : stripped;
    rules.push({
      negate,
      dirOnly,
      anchored,
      match: compileGlob(
        anchored ? pattern : (pattern.split('/').pop() ?? pattern),
      ),
    });
  }
  return rules;
}

// Common-subset .gitignore matcher: *, ?, **, dir/ prefixes, ! negation
// (last match wins). Exotic forms (character classes beyond ?, rooted
// mid-pattern **) are not covered — documented, and anything missed only
// widens the walked set, never narrows it.
//
// Nested files (issue #116) are appended to the parent's rules verbatim and
// matched against the walk-root-relative path, exactly as root rules are —
// they are NOT re-rooted at their own directory. The WALK is what scopes
// them: a nested file's rules are in force only inside its own subtree, so a
// rule can never match a sibling's path (git's per-directory scoping, held by
// the recursion rather than by this matcher). The limit that remains is the
// anchored form: a nested anchored pattern must be written root-relative
// (`packages/foo/build/`) to match — a git-style directory-relative one
// (`sub/build/` inside `packages/foo/.gitignore`, meaning
// `packages/foo/sub/build/` to git) matches nothing here and merely widens
// the walk. docs/packages/exec.md states the subset and its limits.
export function isIgnored(
  rules: IgnoreRule[],
  relPath: string,
  isDir: boolean,
): boolean {
  const name = relPath.split('/').pop() ?? relPath;
  let ignored = false;
  for (const rule of rules) {
    let hit = false;
    if (rule.dirOnly) {
      // git's trailing slash matches DIRECTORIES only: a file named like the
      // directory stays in scope, while anything under an ignored directory
      // is ignored by that ancestor — which is a directory by construction.
      // Test every directory prefix of relPath (the path itself when it is a
      // directory, its ancestors otherwise).
      const parts = relPath.split('/');
      const dirCount = isDir ? parts.length : parts.length - 1;
      for (let end = 1; end <= dirCount && !hit; end += 1) {
        hit = rule.anchored
          ? rule.match(parts.slice(0, end).join('/'))
          : rule.match(parts[end - 1] ?? '');
      }
    } else if (rule.anchored) {
      hit = rule.match(relPath);
    } else {
      hit = rule.match(name);
    }
    if (hit) ignored = !rule.negate;
  }
  return ignored;
}
