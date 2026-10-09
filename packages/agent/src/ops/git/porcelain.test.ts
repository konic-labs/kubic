// The git output parsers over captured output: paths as git prints them,
// spaces included (neither format quotes a path).
import { describe, expect, it } from 'vitest';
import { parseSubmoduleStatus, parseWorktreeList } from './porcelain.js';

const SHA = 'a'.repeat(40);

describe('parseSubmoduleStatus', () => {
  it('reads each state, with and without the describe suffix', () => {
    const out = [
      ` ${SHA} libs/clean (heads/main)`,
      `+${SHA} libs/moved (v1.2-3-gabc)`,
      `-${SHA} libs/new`,
      `U${SHA} libs/torn`,
      '',
    ].join('\n');
    expect(parseSubmoduleStatus(out)).toEqual([
      { path: 'libs/clean', state: 'clean' },
      { path: 'libs/moved', state: 'modified' },
      { path: 'libs/new', state: 'uninitialized' },
      { path: 'libs/torn', state: 'conflict' },
    ]);
  });

  it('keeps a path with spaces whole', () => {
    const out = [
      ` ${SHA} vendor/my lib (heads/main)`,
      `-${SHA} third party/a b`,
      '',
    ].join('\n');
    expect(parseSubmoduleStatus(out).map((row) => row.path)).toEqual([
      'vendor/my lib',
      'third party/a b',
    ]);
  });
});

describe('parseWorktreeList', () => {
  it('reads branch, detached and bare blocks, spaces in paths included', () => {
    const out = [
      '/repo',
      `HEAD ${SHA}`,
      'branch refs/heads/main',
      '',
      '/work trees/feature x',
      `HEAD ${SHA}`,
      'detached',
      '',
      '/bare.git',
      'bare',
      '',
    ]
      .map((line) => (line.startsWith('/') ? `worktree ${line}` : line))
      .join('\n');
    expect(parseWorktreeList(out)).toEqual([
      {
        path: '/repo',
        head: SHA,
        branch: 'main',
        bare: false,
        detached: false,
      },
      {
        path: '/work trees/feature x',
        head: SHA,
        branch: null,
        bare: false,
        detached: true,
      },
      {
        path: '/bare.git',
        head: '',
        branch: null,
        bare: true,
        detached: false,
      },
    ]);
  });
});
