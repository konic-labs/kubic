// Shared real-git sandbox: every real-git test in agent and
// exec builds its throwaway repo through `createGitSandbox`, never through
// a bare `git init` on the inherited environment. The sandbox scrubs the
// ambient git state (developer `~/.gitconfig`, `GIT_DIR` leaked from a git
// hook, a hostile `GIT_CONFIG_GLOBAL`) so the suite gives the same result
// on every machine and can never touch the Kubic repo itself.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitSandbox, disposeAllGitSandboxes } from './git-sandbox.js';

afterEach(() => {
  disposeAllGitSandboxes();
});

// A global config no repo should ever honor: signing on (prompts or fails
// without a key), a hooks path with a failing pre-commit, and a template
// dir that plants that hook into every `git init`.
function writeHostileGlobalConfig(dir: string): {
  config: string;
  hooks: string;
} {
  const hooks = join(dir, 'hostile-hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  const templates = join(dir, 'hostile-template');
  mkdirSync(join(templates, 'hooks'), { recursive: true });
  writeFileSync(join(templates, 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(templates, 'hooks', 'pre-commit'), 0o755);
  const config = join(dir, 'hostile-gitconfig');
  writeFileSync(
    config,
    [
      '[commit]',
      '\tgpgsign = true',
      '[core]',
      `\thooksPath = ${hooks}`,
      '[init]',
      `\ttemplateDir = ${templates}`,
      '',
    ].join('\n'),
  );
  return { config, hooks };
}

describe('createGitSandbox', () => {
  it('inits a usable repo: commits work and the log reads back', () => {
    const sb = createGitSandbox();
    writeFileSync(join(sb.path, 'a.txt'), 'one\n');
    sb.git(['add', '--', 'a.txt']);
    sb.git(['commit', '-q', '-m', 'add a.txt']);
    const sha = sb.git(['rev-parse', 'HEAD']).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sb.git(['log', '-1', '--format=%s']).trim()).toBe('add a.txt');
    sb.cleanup();
  });

  it('ignores a hostile global config and ambient GIT_* variables', () => {
    const hostileDir = mkdtempSync(join(tmpdir(), 'kubic-hostile-'));
    const { config } = writeHostileGlobalConfig(hostileDir);
    // What a developer machine (or a git hook running the suite) may hold.
    const polluted: Record<string, string> = {
      GIT_DIR: '/nonexistent',
      GIT_WORK_TREE: '/nonexistent',
      GIT_INDEX_FILE: '/nonexistent-index',
      GIT_OBJECT_DIRECTORY: '/nonexistent-objects',
      GIT_CEILING_DIRECTORIES: '/',
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '0',
    };
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(polluted)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      // Created AFTER the pollution: the sandbox env must be scrubbed.
      const sb = createGitSandbox();
      writeFileSync(join(sb.path, 'a.txt'), 'one\n');
      sb.git(['add', '--', 'a.txt']);
      // Would run the failing pre-commit and ask for a signing key without
      // isolation; succeeds through the sandbox.
      sb.git(['commit', '-q', '-m', 'add a.txt']);
      // The sandbox's own config wins, not the hostile global one.
      expect(sb.git(['config', '--get', 'commit.gpgsign']).trim()).toBe(
        'false',
      );
      sb.cleanup();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(hostileDir, { recursive: true, force: true });
    }
  });

  it('exposes a scrubbed env: no GIT_DIR family, isolated HOME', () => {
    const sb = createGitSandbox();
    try {
      for (const key of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES',
        'GIT_CEILING_DIRECTORIES',
      ]) {
        expect(sb.env[key], key).toBeUndefined();
      }
      expect(sb.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(sb.env.HOME).toBe(sb.home);
      expect(sb.home.startsWith(sb.parent)).toBe(true);
      // The global config override is a real empty file: git reads "no
      // config" from it instead of the developer's ~/.gitconfig.
      expect(existsSync(String(sb.env.GIT_CONFIG_GLOBAL))).toBe(true);
    } finally {
      sb.cleanup();
    }
  });

  it('cleanup removes the temp dir and restores process.env', () => {
    const before = { ...process.env };
    const sb = createGitSandbox({ injectProcessEnv: true });
    expect(process.env.HOME).toBe(sb.home);
    const parent = sb.parent;
    expect(existsSync(parent)).toBe(true);
    sb.cleanup();
    expect(existsSync(parent)).toBe(false);
    expect(process.env).toEqual(before);
  });

  it('disposeAllGitSandboxes cleans every live sandbox (the afterEach path)', () => {
    const before = { ...process.env };
    const first = createGitSandbox({ injectProcessEnv: true });
    const second = createGitSandbox();
    disposeAllGitSandboxes();
    expect(existsSync(first.parent)).toBe(false);
    expect(existsSync(second.parent)).toBe(false);
    expect(process.env).toEqual(before);
    // Idempotent: the file-level afterEach runs it again harmlessly.
    disposeAllGitSandboxes();
    expect(process.env).toEqual(before);
  });
});
