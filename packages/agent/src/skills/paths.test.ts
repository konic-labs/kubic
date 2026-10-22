// The skill path helpers: the project chain a search walks, the confinement
// check, and the joins. The walk ends at the root whatever the cwd looks like
// (a Windows drive path never reaches `/`).
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWithinDir, joinPath, projectChain } from './paths.js';

const none = { exists: () => false };

describe('projectChain', () => {
  it('runs from the repository top level down to the cwd', () => {
    const repo = { exists: (path: string) => path === '/repo/.git' };
    expect(projectChain(repo, '/repo/pkg/sub/')).toEqual([
      '/repo',
      '/repo/pkg',
      '/repo/pkg/sub',
    ]);
  });

  it('is the cwd alone outside a repository', () => {
    expect(projectChain(none, '/tmp/work')).toEqual(['/tmp/work']);
  });

  it('ends the walk at the root, whatever the cwd looks like', () => {
    expect(projectChain(none, 'relative/dir')).toEqual([
      resolve('relative/dir'),
    ]);
    const rooted = { exists: (path: string) => path === '/.git' };
    expect(projectChain(rooted, '/a/b')).toEqual(['/', '/a', '/a/b']);
  });
});

describe('isWithinDir', () => {
  it('holds a directory and what is under it, nothing beside it', () => {
    expect(isWithinDir('/repo/pkg', '/repo/pkg')).toBe(true);
    expect(isWithinDir('/repo/pkg/skills/a', '/repo/pkg/')).toBe(true);
    expect(isWithinDir('/repo/pkg-evil/a', '/repo/pkg')).toBe(false);
    expect(isWithinDir('/repo/pkg/../sibling', '/repo/pkg')).toBe(false);
    expect(isWithinDir('/repo/..hidden', '/repo')).toBe(true);
    expect(isWithinDir('/anything', '/')).toBe(true);
  });
});

describe('joinPath', () => {
  it('joins and folds, anchored at the root', () => {
    expect(joinPath('/a//b', 'c/')).toBe('/a/b/c');
    expect(joinPath('/a', '/b')).toBe('/a/b');
    expect(joinPath('a', '..', '..', 'b')).toBe('/b');
    expect(joinPath()).toBe('/');
  });
});
