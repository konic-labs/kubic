// Role resolution through a symlinked home directory, on the real
// filesystem: the personal roles load through the link, and when the home
// is also the project root (reached by its real path) the same document is
// a personal role and a project role at once — never a fork.
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectRole } from './roles-boot.js';

const SCOUT =
  '---\nrole: scout\ntools: [read, ls, find, grep]\nfilesystem: read\nshell: false\nnetwork: none\ngit: false\ncredentials: none\n---\n\n# scout\n\n## Prompt\n\nScout the tree.\n';

describe('role resolution through a symlinked home', () => {
  let base: string;
  let real: string;
  let link: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'kubic-roles-home-link-'));
    real = join(base, 'real-home');
    link = join(base, 'home-link');
    mkdirSync(join(real, '.kubic', 'roles'), { recursive: true });
    writeFileSync(join(real, '.kubic', 'roles', 'scout.md'), SCOUT);
    symlinkSync(real, link);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('loads a personal role through the link from any project', () => {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    const selected = selectRole({
      bridge: createNodeFileBridge('/'),
      cwd: repo,
      projectRoot: repo,
      home: link,
      role: 'scout',
    });
    expect(selected.source).toBe('global');
    expect(selected.markdown).toContain('Scout the tree.');
  });

  it('keeps the personal copy when the untrusted project root is the home', () => {
    const selected = selectRole({
      bridge: createNodeFileBridge('/'),
      cwd: real,
      projectRoot: real,
      home: link,
      role: 'scout',
    });
    expect(selected.source).toBe('global');
  });

  it('never reads the two names of one document as a fork once trusted', () => {
    const selected = selectRole({
      bridge: createNodeFileBridge('/'),
      cwd: real,
      projectRoot: real,
      home: link,
      trusted: true,
      role: 'scout',
    });
    // The project layer wins by precedence; no duplicate refusal.
    expect(selected.source).toBe('repo');
    expect(selected.markdown).toContain('Scout the tree.');
  });
});
