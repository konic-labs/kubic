// Project-root resolution (issue #229; §35.1). One derivation for the
// config project layer, the repo role documents and the runtime-exclude
// check, so a run from a subdirectory sees the same project files as a run
// from the root. Pure probe over an injected `exists` — no node:fs here,
// tests drive a set-backed fake.
import { describe, expect, it } from 'vitest';
import { findProjectRoot } from './project-root.js';

function bridgeFor(paths: readonly string[]): {
  exists: (p: string) => boolean;
} {
  const hit = new Set(paths);
  return { exists: (p: string): boolean => hit.has(p) };
}

describe('findProjectRoot (issue #229)', () => {
  it('returns the nearest ancestor holding .kubic', () => {
    const bridge = bridgeFor(['/repo/.kubic', '/repo/.git']);
    expect(findProjectRoot(bridge, '/repo/a/b', '/home/u')).toBe('/repo');
  });

  it('prefers the nearest marker: a nested .kubic beats the outer .git', () => {
    const bridge = bridgeFor(['/repo/.git', '/repo/sub/.kubic']);
    expect(findProjectRoot(bridge, '/repo/sub/deep', '/home/u')).toBe(
      '/repo/sub',
    );
  });

  it('falls back to the git toplevel when no .kubic exists', () => {
    const bridge = bridgeFor(['/repo/.git']);
    expect(findProjectRoot(bridge, '/repo/a/b', '/home/u')).toBe('/repo');
  });

  it('falls back to the cwd outside any repository', () => {
    const bridge = bridgeFor([]);
    expect(findProjectRoot(bridge, '/plain/sub', '/home/u')).toBe('/plain/sub');
  });

  it('ignores a .kubic at home (the global tree), falling back to the cwd', () => {
    const bridge = bridgeFor(['/home/u/.kubic']);
    expect(findProjectRoot(bridge, '/home/u/proj', '/home/u')).toBe(
      '/home/u/proj',
    );
  });

  it('still honours a .git at home (home really is a repo)', () => {
    const bridge = bridgeFor(['/home/u/.git']);
    expect(findProjectRoot(bridge, '/home/u/proj', '/home/u')).toBe('/home/u');
  });

  it('treats an unreadable path as no marker and keeps walking', () => {
    const bridge = {
      exists: (p: string): boolean => {
        if (p === '/repo/a/.git' || p === '/repo/a/.kubic') {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return p === '/repo/.git';
      },
    };
    expect(findProjectRoot(bridge, '/repo/a', '/home/u')).toBe('/repo');
  });

  it('returns the cwd itself when it holds the marker', () => {
    const bridge = bridgeFor(['/repo/.kubic']);
    expect(findProjectRoot(bridge, '/repo', '/home/u')).toBe('/repo');
  });
});
