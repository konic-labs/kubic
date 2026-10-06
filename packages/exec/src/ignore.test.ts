// Shared .gitignore-subset matcher (issues #116, #172). The journal baseline
// and the find/grep walk both call `isIgnored`, so these pin the semantics
// they share — plus the adversarial-pattern bound the old regex compiler
// lacked (a wildcard-heavy .gitignore must not cost exponential time).
import { describe, expect, it } from 'vitest';
import { isIgnored, parseIgnoreFile } from './ignore.js';

function ignored(pattern: string, path: string, isDir = false): boolean {
  return isIgnored(parseIgnoreFile(pattern), path, isDir);
}

describe('gitignore-subset matcher (issues #116, #172)', () => {
  it('matches *, ?, ** and negation with last-match-wins', () => {
    expect(ignored('*.log\n', 'a.log')).toBe(true);
    expect(ignored('*.log\n', 'sub/a.log')).toBe(true);
    expect(ignored('*.log\n', 'a.txt')).toBe(false);
    expect(ignored('a?c.txt\n', 'abc.txt')).toBe(true);
    expect(ignored('helper?.txt\n', 'sub/helper1.txt')).toBe(true);
    expect(ignored('*.log\n!keep.log\n', 'keep.log')).toBe(false);
    expect(ignored('!keep.log\n*.log\n', 'keep.log')).toBe(true);
  });

  it('treats a leading **/ as zero or more directories', () => {
    expect(ignored('**/foo.txt\n', 'foo.txt')).toBe(true);
    expect(ignored('**/foo.txt\n', 'a/foo.txt')).toBe(true);
    expect(ignored('**/foo.txt\n', 'a/b/foo.txt')).toBe(true);
    expect(ignored('**/foo.txt\n', 'a/foo.txt.bak')).toBe(false);
  });

  it('applies a dirOnly rule to directories, never to a file of the same name', () => {
    expect(ignored('build/\n', 'build', true)).toBe(true);
    expect(ignored('build/\n', 'build', false)).toBe(false);
    expect(ignored('build/\n', 'sub/build', true)).toBe(true);
    expect(ignored('build/\n', 'sub/build', false)).toBe(false);
    // A path INSIDE an ignored directory is ignored by its ancestor, which
    // is a directory by construction — the file's own isDir does not matter.
    expect(ignored('build/\n', 'build/out.js', false)).toBe(true);
    expect(ignored('build/\n', 'sub/build/out.js', false)).toBe(true);
  });

  // Issue #353 (widening half): a glob dir rule matches directories by
  // its compiled glob, per segment — `*.egg-info/` must hide the whole
  // subtree, not hash it on every boot and sweep.
  it('matches a glob dir rule against each directory segment', () => {
    expect(ignored('*.egg-info/\n', 'pkg.egg-info', true)).toBe(true);
    expect(ignored('*.egg-info/\n', 'pkg.egg-info/PKG-INFO')).toBe(true);
    expect(ignored('*.egg-info/\n', 'sub/pkg.egg-info/PKG-INFO')).toBe(true);
    expect(ignored('*.egg-info/\n', 'pkg.egg-info.txt')).toBe(false);
    expect(ignored('.venv*/\n', '.venv/bin/python')).toBe(true);
  });

  it('keeps anchored and bare-name rules distinct', () => {
    expect(ignored('/only-root.txt\n', 'only-root.txt')).toBe(true);
    expect(ignored('/only-root.txt\n', 'sub/only-root.txt')).toBe(false);
    expect(ignored('sub/only-root.txt\n', 'sub/only-root.txt')).toBe(true);
    expect(ignored('sub/only-root.txt\n', 'other/sub/only-root.txt')).toBe(
      false,
    );
    expect(ignored('only-root.txt\n', 'sub/only-root.txt')).toBe(true);
  });

  it('matches a wildcard-heavy pattern without regex backtracking', () => {
    // `*a*a*a*a*a*a` against 'a'*80+'c': the old compiler emitted nested
    // `[^/]*` runs and explored them exponentially (~1.6s for this input,
    // minutes for a handful more a's). The linear matcher answers in
    // microseconds; the ceiling is a complexity bound, not a benchmark.
    const rules = parseIgnoreFile('*a*a*a*a*a*a\n');
    const name = `${'a'.repeat(80)}c`;
    const start = performance.now();
    expect(isIgnored(rules, name, false)).toBe(false);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
