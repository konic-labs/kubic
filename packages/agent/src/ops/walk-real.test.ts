// Real-filesystem walk behavior: .git exclusion, .gitignore
// support, the default node_modules ignore, symlink safety, and honest caps.
// mkdtemp trees driven through NodeExecutionEnv — the binding production
// actually runs — with every directory removed in afterEach.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import { withReadRoots } from '../../../exec/src/read-roots.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';
import { WALK_MAX_DEPTH, WALK_MAX_ENTRIES } from './walk.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function ctx(root: string): OpContext {
  return { env: new NodeExecutionEnv(root), sessionId: 's1', agentId: 'a1' };
}

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('walk ignore rules on the node seam', () => {
  it('skips node_modules so a repo-root grep does not spend the cap there', {
    timeout: 30_000,
  }, async () => {
    const root = tmp('walk-nm-');
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'src', 'a.ts'), 'const needle = 1;\n');
    for (let i = 0; i <= WALK_MAX_ENTRIES; i += 1) {
      writeFileSync(
        join(root, 'node_modules', `dep-${i}.js`),
        'module.exports = 1;\n',
      );
    }
    const out = await callOperation(
      'grep',
      { pattern: 'needle', root: '.' },
      inv(),
      ctx(root),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.matches.map((m) => m.path)).toEqual(['src/a.ts']);
    expect(out.result.truncated).toBe(false);
  });

  it('matches an anchored root rule against the walk-root-relative path', async () => {
    const root = tmp('walk-anchored-');
    writeFileSync(join(root, '.gitignore'), '/only-at-root.txt\n');
    writeFileSync(join(root, 'only-at-root.txt'), 'x\n');
    mkdirSync(join(root, 'sub'));
    // A leading slash anchors to the walk root: the same name one level down
    // is a different path and stays in scope.
    writeFileSync(join(root, 'sub', 'only-at-root.txt'), 'x\n');
    const out = await callOperation(
      'find',
      { root: '.', type: 'file' },
      inv(),
      ctx(root),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.paths.sort()).toEqual([
      '.gitignore',
      'sub/only-at-root.txt',
    ]);
  });

  it('stops at the depth bound on a hostile tree and says so', async () => {
    const root = tmp('walk-depth-');
    let dir = root;
    for (let i = 0; i <= WALK_MAX_DEPTH + 2; i += 1) dir = join(dir, `d${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'deep.txt'), 'needle\n');
    const out = await callOperation(
      'grep',
      { pattern: 'needle', root: '.' },
      inv(),
      ctx(root),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.matches).toEqual([]);
    // The depth cap pruned a subtree: the result says so rather than
    // looking like an empty file set.
    expect(out.result.truncated).toBe(true);
    expect(out.result.notice).toContain(String(WALK_MAX_DEPTH));
  });

  it('never walks .git and honors .gitignore rules per subtree', async () => {
    const root = tmp('walk-ignore-');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'needle = 1\n');
    writeFileSync(join(root, '.gitignore'), '*.log\n');
    writeFileSync(join(root, 'kept.ts'), 'const needle = 1;\n');
    writeFileSync(join(root, 'noise.log'), 'needle = 1\n');
    mkdirSync(join(root, 'sub'));
    // Nested rules are scoped to their own subtree: `secret.txt` is ignored
    // only here, and the negation overrides the root `*.log` only here.
    writeFileSync(join(root, 'sub', '.gitignore'), 'secret.txt\n!keep.log\n');
    writeFileSync(join(root, 'sub', 'secret.txt'), 'needle = 1\n');
    writeFileSync(join(root, 'sub', 'keep.log'), 'needle = 1\n');
    mkdirSync(join(root, 'other'));
    writeFileSync(join(root, 'other', 'secret.txt'), 'needle = 1\n');
    writeFileSync(join(root, 'other', 'keep.log'), 'needle = 1\n');

    const found = await callOperation(
      'find',
      { root: '.', type: 'file' },
      inv(),
      ctx(root),
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.result.paths.sort()).toEqual([
      '.gitignore',
      'kept.ts',
      'other/secret.txt',
      'sub/.gitignore',
      'sub/keep.log',
    ]);
    expect(found.result.paths.some((p) => p.startsWith('.git/'))).toBe(false);

    const hits = await callOperation(
      'grep',
      { pattern: 'needle', root: '.' },
      inv(),
      ctx(root),
    );
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    expect(hits.result.matches.map((m) => m.path).sort()).toEqual([
      'kept.ts',
      'other/secret.txt',
      'sub/keep.log',
    ]);
  });

  it('never follows symlinks: a loop yields exactly one match per real file', async () => {
    const root = tmp('walk-symlink-');
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'one.txt'), 'needle\n');
    // Three routes to the same content: a directory cycle, a second link to
    // the same directory, and a link to the file itself.
    symlinkSync(join(root, 'a'), join(root, 'a', 'loop'));
    symlinkSync(join(root, 'a'), join(root, 'linked'));
    symlinkSync(join(root, 'a', 'one.txt'), join(root, 'linked-file.txt'));

    const hits = await callOperation(
      'grep',
      { pattern: 'needle', root: '.' },
      inv(),
      ctx(root),
    );
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    expect(hits.result.matches).toEqual([
      { path: 'a/one.txt', line: 1, text: 'needle' },
    ]);

    const dirs = await callOperation(
      'find',
      { root: '.', type: 'dir' },
      inv(),
      ctx(root),
    );
    expect(dirs.ok).toBe(true);
    if (!dirs.ok) return;
    // A symlinked directory is not a real directory for the filter.
    expect(dirs.result.paths.sort()).toEqual(['a']);

    const files = await callOperation(
      'find',
      { root: '.', type: 'file' },
      inv(),
      ctx(root),
    );
    expect(files.ok).toBe(true);
    if (!files.ok) return;
    expect(files.result.paths.sort()).toEqual(['a/one.txt']);
  });

  it('keeps symlink-loop protection when the env is wrapped with skill read roots', async () => {
    // bootLane applies withReadRoots whenever a skill lives outside the
    // workspace (every user with global skills). The wrapper once built an fs
    // WITHOUT lstat, so the walk fell back to stat() and followed `loop`.
    const root = tmp('walk-roots-ws-');
    const skills = tmp('walk-roots-skill-');
    writeFileSync(join(root, 'a.txt'), 'needle\n');
    symlinkSync('.', join(root, 'loop'));
    const wrapped = {
      env: withReadRoots(new NodeExecutionEnv(root), [skills]),
      sessionId: 's1',
      agentId: 'a1',
    };
    const plain = await callOperation(
      'grep',
      { pattern: 'needle' },
      inv(),
      ctx(root),
    );
    const viaRoots = await callOperation(
      'grep',
      { pattern: 'needle' },
      inv(),
      wrapped,
    );
    expect(plain.ok && viaRoots.ok).toBe(true);
    if (!plain.ok || !viaRoots.ok) return;
    expect(plain.result.matches).toEqual([
      { path: 'a.txt', line: 1, text: 'needle' },
    ]);
    expect(viaRoots.result).toEqual(plain.result);
    const found = await callOperation('find', {}, inv(), wrapped);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.result.paths).toEqual(['a.txt']);
  });

  it('survives a dangling symlink: find skips it and ls lists the real entries', async () => {
    const root = tmp('walk-dangling-');
    writeFileSync(join(root, 'real.txt'), 'hello\n');
    symlinkSync(join(root, 'missing-target'), join(root, 'dangling'));

    const ls = await callOperation('ls', { path: '.' }, inv(), ctx(root));
    expect(ls.ok).toBe(true);
    if (!ls.ok) return;
    expect(ls.result.entries.map((e) => e.name)).toEqual(['real.txt']);

    const found = await callOperation(
      'find',
      { root: '.', type: 'file' },
      inv(),
      ctx(root),
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.result.paths).toEqual(['real.txt']);
  });

  it('names the entry cap in a notice instead of truncating silently', {
    timeout: 30_000,
  }, async () => {
    const root = tmp('walk-cap-');
    mkdirSync(join(root, 'deps'));
    for (let i = 0; i <= WALK_MAX_ENTRIES; i += 1) {
      writeFileSync(join(root, 'deps', `f-${i}.txt`), 'x\n');
    }
    const out = await callOperation('find', { root: 'deps' }, inv(), ctx(root));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.notice).toContain(String(WALK_MAX_ENTRIES));
    expect(out.result.notice).toContain('deps');
  });

  it('names the result cap when find or grep stops at its limit', async () => {
    const root = tmp('walk-resultcap-');
    // Two matching lines in ONE file: the grep cap must stop inside the file,
    // not only after it.
    writeFileSync(join(root, 'a.txt'), 'needle\nneedle\n');
    writeFileSync(join(root, 'b.txt'), 'needle\nneedle\n');
    const found = await callOperation(
      'find',
      { root: '.', maxResults: 1 },
      inv(),
      ctx(root),
    );
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.result.paths).toHaveLength(1);
    expect(found.result.truncated).toBe(true);
    expect(found.result.notice).toContain('maxResults');

    const hits = await callOperation(
      'grep',
      { pattern: 'needle', root: '.', maxMatches: 1 },
      inv(),
      ctx(root),
    );
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    expect(hits.result.matches).toHaveLength(1);
    expect(hits.result.truncated).toBe(true);
    expect(hits.result.notice).toContain('maxMatches');
  });

  it('does not call a match set truncated just because it filled the cap', async () => {
    const root = tmp('walk-exactcap-');
    // Exactly the cap in matches, and nothing else in the tree: the search
    // proved there is no further match, so the result is complete.
    writeFileSync(join(root, 'a.txt'), 'needle\nneedle\n');
    writeFileSync(join(root, 'b.txt'), 'other\n');
    const hits = await callOperation(
      'grep',
      { pattern: 'needle', root: '.', maxMatches: 2 },
      inv(),
      ctx(root),
    );
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    expect(hits.result.matches).toHaveLength(2);
    expect(hits.result.truncated).toBe(false);
    expect(hits.result.notice).toBeUndefined();
  });
});
