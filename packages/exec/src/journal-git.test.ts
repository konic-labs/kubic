// Git pre-images for the reconcile sweep (issue #371).
//
// The baseline walk holds sha256 hashes, not content, so a bash `rm` or
// `sed -i` on a tracked file could never be undone even though its pre-image
// sits in the git object store. This module is the git plumbing: which calls
// the baseline makes, how their output parses, and how a pre-image blob is
// read back. RED: the module does not exist yet.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureGitBaseline,
  captureHeadState,
  type GitCommand,
  type GitCommandResult,
  loadGitBaseline,
  loadHeadState,
  readGitBlob,
  saveGitBaseline,
  saveHeadState,
} from './journal-git.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'journal-git-'));
  roots.push(root);
  return root;
}

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);

// Fake git: scripted outputs per subcommand, recording every invocation so
// the baseline-cost bound ("metadata only, never a blob read") is observed,
// not assumed.
function fakeGit(outputs: {
  lsFiles: string;
  status: string;
  blobs?: Record<string, Buffer>;
}): { run: GitCommand; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitCommand = (args: string[]): GitCommandResult => {
    calls.push(args);
    const sub = args[0];
    if (sub === 'ls-files')
      return { status: 0, stdout: Buffer.from(outputs.lsFiles, 'utf8') };
    if (sub === 'status')
      return { status: 0, stdout: Buffer.from(outputs.status, 'utf8') };
    if (sub === 'cat-file' && args.includes('-s')) {
      const oid = args[args.length - 1] ?? '';
      const blob = outputs.blobs?.[oid];
      if (blob === undefined) return { status: 1, stdout: Buffer.alloc(0) };
      return { status: 0, stdout: Buffer.from(`${blob.length}\n`, 'utf8') };
    }
    if (sub === 'cat-file') {
      const oid = args[args.length - 1] ?? '';
      const blob = outputs.blobs?.[oid];
      if (blob === undefined) return { status: 1, stdout: Buffer.alloc(0) };
      return { status: 0, stdout: blob };
    }
    return { status: 1, stdout: Buffer.alloc(0) };
  };
  return { run, calls };
}

const LS = [
  `100644 ${OID_A} 0\ttracked.ts`,
  `100644 ${OID_B} 0\tdirty.ts`,
  `100644 ${OID_C} 0\tuntracked-baseline-miss.ts`,
  `120000 ${OID_A} 0\tlink.ts`,
  `160000 ${OID_A} 0\tvendor/sub`,
  `100644 ${OID_A} 1\tconflicted.ts`,
].join('\0');

describe('captureGitBaseline (issue #371)', () => {
  it('records index OIDs for stat-clean tracked files in the baseline', () => {
    const { run } = fakeGit({ lsFiles: `${LS}\0`, status: ' M dirty.ts\0' });
    const out = captureGitBaseline(
      '/repo',
      { 'tracked.ts': 'h1', 'dirty.ts': 'h2', 'walk-only.ts': 'h3' },
      run,
    );
    // Clean and in the walk: recorded. Dirty: no pre-image (restoring the
    // committed version would clobber uncommitted work). Not in the walk
    // (ignored/.git/.kubic): never a candidate. Staged-conflict, submodule
    // and symlink rows never qualify either.
    expect(out).toEqual({ 'tracked.ts': OID_A });
  });

  it('costs two metadata calls and no blob reads', () => {
    const { run, calls } = fakeGit({ lsFiles: `${LS}\0`, status: '' });
    captureGitBaseline('/repo', { 'tracked.ts': 'h1' }, run);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['ls-files', '-s', '-z']);
    expect(calls[1]).toEqual([
      'status',
      '--porcelain=v1',
      '--untracked-files=no',
      '--no-renames',
      '-z',
    ]);
    expect(calls.some((c) => c.includes('cat-file'))).toBe(false);
  });

  it('returns null when either git call fails (non-repo, fail-open)', () => {
    const failing: GitCommand = () => ({
      status: 128,
      stdout: Buffer.alloc(0),
    });
    expect(captureGitBaseline('/repo', { 'a.ts': 'h' }, failing)).toBe(null);
    const half = fakeGit({ lsFiles: `${LS}\0`, status: '' });
    const statusFails: GitCommand = (args: string[], root: string) =>
      args.includes('status')
        ? { status: 128, stdout: Buffer.alloc(0) }
        : half.run(args, root);
    expect(
      captureGitBaseline('/repo', { 'tracked.ts': 'h1' }, statusFails),
    ).toBe(null);
  });

  it('returns null outside a git repo with the production runner', () => {
    expect(captureGitBaseline(tmpRoot(), { 'a.ts': 'h' })).toBe(null);
  });

  it('treats staged modifications as dirty too', () => {
    const { run } = fakeGit({ lsFiles: `${LS}\0`, status: 'M  dirty.ts\0' });
    expect(
      captureGitBaseline(
        '/repo',
        { 'tracked.ts': 'h1', 'dirty.ts': 'h2' },
        run,
      ),
    ).toEqual({ 'tracked.ts': OID_A });
  });
});

describe('readGitBlob (issue #371)', () => {
  it('reads the blob after a size pre-check', () => {
    const content = Buffer.from('pre-image\n', 'utf8');
    const { run, calls } = fakeGit({
      lsFiles: '',
      status: '',
      blobs: { [OID_A]: content },
    });
    expect(readGitBlob('/repo', OID_A, 4 * 1024 * 1024, run)?.toString()).toBe(
      'pre-image\n',
    );
    expect(calls).toEqual([
      ['cat-file', '-s', OID_A],
      ['cat-file', 'blob', OID_A],
    ]);
  });

  it('refuses non-OID revisions without spawning git', () => {
    const { run, calls } = fakeGit({ lsFiles: '', status: '' });
    for (const bad of [
      'HEAD',
      'a;rm -rf',
      'abc',
      '../x',
      `${OID_A}x`.slice(0, 39),
    ]) {
      expect(readGitBlob('/repo', bad, 1024, run)).toBe(null);
    }
    expect(calls).toHaveLength(0);
  });

  it('returns null above the byte bound without reading the blob', () => {
    const content = Buffer.from('x'.repeat(100), 'utf8');
    const { run, calls } = fakeGit({
      lsFiles: '',
      status: '',
      blobs: { [OID_A]: content },
    });
    expect(readGitBlob('/repo', OID_A, 10, run)).toBe(null);
    expect(calls).toEqual([['cat-file', '-s', OID_A]]);
  });

  it('returns null when git fails', () => {
    const failing: GitCommand = () => ({
      status: 128,
      stdout: Buffer.alloc(0),
    });
    expect(readGitBlob('/repo', OID_A, 1024, failing)).toBe(null);
  });
});

describe('git baseline persistence (issue #371)', () => {
  it('round-trips beside the baseline file and loads null when absent', () => {
    const dir = tmpRoot();
    expect(loadGitBaseline(dir, 'run-1')).toBe(null);
    saveGitBaseline(dir, 'run-1', { 'a.ts': OID_A });
    expect(loadGitBaseline(dir, 'run-1')).toEqual({ 'a.ts': OID_A });
  });

  it('never writes through an unsafe run id', () => {
    const dir = tmpRoot();
    expect(() => saveGitBaseline(dir, '../evil', { 'a.ts': OID_A })).toThrow();
  });
});

describe('captureHeadState (issue #378)', () => {
  function fakeHead(outputs: {
    revParse: string;
    symbolicRef?: { status: number; stdout: string };
    stash?: string;
  }): { run: GitCommand; calls: string[][] } {
    const calls: string[][] = [];
    const run: GitCommand = (args: string[]): GitCommandResult => {
      calls.push(args);
      if (args[0] === 'rev-parse')
        return { status: 0, stdout: Buffer.from(outputs.revParse, 'utf8') };
      if (args[0] === 'symbolic-ref') {
        const s = outputs.symbolicRef ?? { status: 0, stdout: 'main\n' };
        return { status: s.status, stdout: Buffer.from(s.stdout, 'utf8') };
      }
      if (args[0] === 'stash')
        return {
          status: 0,
          stdout: Buffer.from(outputs.stash ?? '', 'utf8'),
        };
      return { status: 1, stdout: Buffer.alloc(0) };
    };
    return { run, calls };
  }

  it('records HEAD sha, branch and stash count', () => {
    const sha = 'd'.repeat(40);
    const { run } = fakeHead({
      revParse: `${sha}\n`,
      stash: `${'e'.repeat(40)}\n${'f'.repeat(40)}\n`,
    });
    expect(captureHeadState('/repo', run)).toEqual({
      head: sha,
      branch: 'main',
      stash: 2,
    });
  });

  it('reads detached HEAD as (detached)', () => {
    const sha = 'd'.repeat(40);
    const { run } = fakeHead({
      revParse: `${sha}\n`,
      symbolicRef: { status: 1, stdout: '' },
    });
    expect(captureHeadState('/repo', run)?.branch).toBe('(detached)');
  });

  it('returns null when HEAD does not resolve (unborn repo, fail-open)', () => {
    const failing: GitCommand = () => ({
      status: 128,
      stdout: Buffer.alloc(0),
    });
    expect(captureHeadState('/repo', failing)).toBe(null);
  });

  it('returns null outside a git repo with the production runner', () => {
    const root = tmpRoot();
    expect(captureHeadState(root)).toBe(null);
  });

  it('round-trips the head sidecar and loads null when absent', () => {
    const dir = tmpRoot();
    expect(loadHeadState(dir, 'run-1')).toBe(null);
    const state = { head: 'd'.repeat(40), branch: 'main', stash: 0 };
    saveHeadState(dir, 'run-1', state);
    expect(loadHeadState(dir, 'run-1')).toEqual(state);
  });
});
