// Which sessions belong to the invoking project: the recorded workspace
// against the invoking one, nested either way.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { touchesWorkspace } from './session-read.js';

describe('touchesWorkspace', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kubic-session-read-'));
    mkdirSync(join(root, 'repo', 'pkg'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('matches the same workspace and one nested in it, either way', () => {
    const repo = join(root, 'repo');
    const pkg = join(repo, 'pkg');
    expect(touchesWorkspace(repo, repo)).toBe(true);
    expect(touchesWorkspace(repo, pkg)).toBe(true);
    expect(touchesWorkspace(pkg, repo)).toBe(true);
    expect(touchesWorkspace(join(root, 'other'), repo)).toBe(false);
  });

  it('never matches a workspace recorded as a relative path', () => {
    // A relative record has no anchor: resolving it against the filesystem
    // root could land on a real directory that happens to share its name.
    const repo = join(root, 'repo');
    expect(touchesWorkspace('repo', repo)).toBe(false);
    expect(touchesWorkspace('tmp', '/tmp')).toBe(false);
    expect(touchesWorkspace('.', repo)).toBe(false);
  });

  it('never matches an empty or missing record', () => {
    expect(touchesWorkspace(undefined, root)).toBe(false);
    expect(touchesWorkspace('', root)).toBe(false);
  });
});
