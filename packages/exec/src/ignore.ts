// Shared .gitignore-subset matcher (issues #116, #172).
//
// Extracted from the journal baseline walk so the worker's find/grep walk and
// the journal walk cannot drift into two different notions of "ignored": a
// path that is out of scope for `kubic diff`/`undo` must not be searched
// repo-wide either. The subset is deliberately small and documented in
// docs/packages/exec.md: `*`, `?`, `**`, `dir/` prefixes, `!` negation,
// last match wins. Exotic forms (character classes beyond `?`, rooted
// mid-pattern `**`) are not covered — anything missed only widens the set of
// walked paths, never narrows it.

function globToRegExp(glob: string): RegExp {
  const escapable = new Set([
    '+',
    '.',
    '^',
    '$',
    '{',
    '}',
    '(',
    ')',
    '|',
    '[',
    ']',
    '\\',
  ]);
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (escapable.has(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

export interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
  match: RegExp;
  prefix: string;
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
      match: globToRegExp(
        anchored ? pattern : (pattern.split('/').pop() ?? pattern),
      ),
      // `prefix` is compared against a walk-root-relative path in
      // `isIgnored`, and those never carry a leading `/` — so the anchored
      // form (`/pi/`) must drop it here or the rule can never match. Keep
      // this in step with the `pattern` derivation above.
      prefix: pattern,
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
      hit =
        relPath === rule.prefix ||
        relPath.startsWith(`${rule.prefix}/`) ||
        (!rule.anchored && relPath.split('/').includes(rule.prefix));
    } else if (rule.anchored) {
      hit = rule.match.test(relPath);
    } else {
      hit = rule.match.test(name);
    }
    if (hit) ignored = !rule.negate;
    void isDir;
  }
  return ignored;
}
