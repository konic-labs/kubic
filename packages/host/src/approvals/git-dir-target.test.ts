import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isGitDirTarget } from './git-dir-target.js';

describe('isGitDirTarget', () => {
  const ws = join(tmpdir(), 'repo-test-ws');

  it('matches writes under <workspace>/.git', () => {
    expect(isGitDirTarget(ws, '.git/hooks/pre-commit')).toBe(true);
    expect(isGitDirTarget(ws, '.git/config')).toBe(true);
    expect(isGitDirTarget(ws, '.git')).toBe(true);
    expect(isGitDirTarget(ws, join(ws, '.git', 'hooks', 'x'))).toBe(true);
    expect(isGitDirTarget(ws, '".git/config"')).toBe(true);
  });

  it('ignores normal files, .kubic state and escapes', () => {
    expect(isGitDirTarget(ws, 'src/index.ts')).toBe(false);
    expect(isGitDirTarget(ws, '.kubic/journal/x')).toBe(false);
    expect(isGitDirTarget(ws, '.github/workflows/ci.yml')).toBe(false);
    expect(isGitDirTarget(ws, '.git/../src/index.ts')).toBe(false);
    expect(isGitDirTarget(ws, '.gitignore')).toBe(false);
    expect(isGitDirTarget(ws, '')).toBe(false);
  });

  it('flags the repository .git above a workspace in a subdirectory', () => {
    const root = join(tmpdir(), 'repo-test-root');
    const sub = join(root, 'packages', 'app');
    expect(isGitDirTarget(sub, join(root, '.git', 'hooks', 'pre-commit'))).toBe(
      true,
    );
    expect(isGitDirTarget(sub, join(root, '.git', 'config'))).toBe(true);
    expect(isGitDirTarget(sub, join(root, '.git'))).toBe(true);
  });

  it('does not flag an unrelated .git', () => {
    const root = join(tmpdir(), 'repo-test-root');
    const sub = join(root, 'packages', 'app');
    expect(isGitDirTarget(sub, join(root, 'other', '.git', 'x'))).toBe(false);
    expect(
      isGitDirTarget(sub, join(root, 'packages', 'lib', '.git', 'x')),
    ).toBe(false);
  });
});
