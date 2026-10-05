// Slice C: baseline capture + end-of-run reconciliation (issue #17; §42.1/42.5).
// RED: captureBaseline/reconcile do not exist yet.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureBaseline,
  FileJournalStore,
  MAX_SWEEP_CONTENT_BYTES,
  reconcile,
} from './journal.js';
import {
  captureHeadState,
  type GitBaseline,
  type GitCommand,
} from './journal-git.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function workspace(): string {
  const root = tmpRoot('ws-');
  writeFileSync(join(root, 'keep.txt'), 'keep\n');
  writeFileSync(join(root, 'change.txt'), 'before\n');
  writeFileSync(join(root, 'skip.log'), 'noise\n');
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'build', 'out.js'), 'gen\n');
  writeFileSync(join(root, '.gitignore'), 'skip.log\nbuild/\n');
  return root;
}

describe('journal baseline + reconciliation (issue #17, slice C)', () => {
  it('captures hashes and excludes gitignored, out-of-scope, and .kubic paths', () => {
    const root = workspace();
    mkdirSync(join(root, '.kubic'));
    writeFileSync(join(root, '.kubic', 'state.json'), '{}\n');
    const baseline = captureBaseline(root, { outOfScope: ['change.txt'] });
    expect(Object.keys(baseline).sort()).toEqual(['.gitignore', 'keep.txt']);
    expect(baseline['keep.txt']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honours ANCHORED gitignore dir rules (regression: /pi/ was not excluded)', () => {
    // The matcher built `prefix: stripped` (leading `/` intact) but
    // `isIgnored` compares it against a relPath that never carries one, so
    // any anchored dir rule silently never matched: a repo whose .gitignore
    // says `/pi/` walked that whole tree into the baseline (measured on the
    // Kubic repo root: 2688 hashed files in ~12s, 2196 of them under pi/).
    // Only unanchored rules (skip.log, build/) were covered before this test.
    const root = tmpRoot('ws-anchored-');
    writeFileSync(join(root, 'keep.txt'), 'keep\n');
    mkdirSync(join(root, 'pi'));
    writeFileSync(join(root, 'pi', 'upstream.ts'), 'vendored\n');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'out.js'), 'built\n');
    mkdirSync(join(root, 'sub'));
    mkdirSync(join(root, 'sub', 'pi'));
    writeFileSync(join(root, 'sub', 'pi', 'inner.ts'), 'nested\n');
    writeFileSync(join(root, '.gitignore'), '/pi/\n/dist/\n');

    const baseline = captureBaseline(root);
    // Anchored rules are root-relative: both root dirs are excluded...
    expect(Object.keys(baseline).sort()).toEqual([
      '.gitignore',
      'keep.txt',
      'sub/pi/inner.ts',
    ]);
    // ...and crucially the anchored `/pi/` must NOT over-match the nested
    // same-named dir: `sub/pi/inner.ts` survives, which is the difference
    // between an anchored rule and an unanchored one. (Its presence above is
    // itself the proof, so this second call pins the complement.)
    expect(
      Object.keys(captureBaseline(root, { outOfScope: ['sub'] })).sort(),
    ).toEqual(['.gitignore', 'keep.txt']);
  });

  it('marks externally changed files unattributed with after-content', () => {
    const root = workspace();
    const journal = new FileJournalStore(tmpRoot('j-'));
    const baseline = captureBaseline(root, { outOfScope: [] });
    // sed -i equivalent: bypasses Kubic ops entirely.
    writeFileSync(join(root, 'change.txt'), 'after\n');
    writeFileSync(join(root, 'dropped.txt'), 'new\n');
    const added = reconcile(journal, baseline, root, {
      sessionId: 's1',
      agentId: 'root',
      timestamp: 1700000000000,
    });
    expect(added).toBe(2);
    const entries = journal.entries();
    expect(entries.every((e) => e.unattributed === true)).toBe(true);
    expect(entries.map((e) => e.path).sort()).toEqual([
      'change.txt',
      'dropped.txt',
    ]);
    const changed = entries.find((e) => e.path === 'change.txt');
    if (changed === undefined) throw new Error('missing change.txt entry');
    expect(journal.readAfter(changed)).toBe('after\n');
    expect(changed?.beforeHash).toBe(baseline['change.txt']);
  });

  it('adds nothing for intercepted-then-unmodified files, and reports deletes', () => {
    const root = workspace();
    const journal = new FileJournalStore(tmpRoot('j-'));
    const baseline = captureBaseline(root, { outOfScope: [] });
    journal.append({
      path: 'change.txt',
      op: 'write',
      before: 'before\n',
      after: 'before\n',
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1,
    });
    writeFileSync(join(root, 'change.txt'), 'before\n');
    rmSync(join(root, 'keep.txt'));
    const added = reconcile(journal, baseline, root, {
      sessionId: 's1',
      agentId: 'root',
      timestamp: 2,
    });
    // Only the external delete is new; the intercepted no-op write adds none.
    expect(added).toBe(1);
    const swept = journal.entries().slice(1);
    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({
      path: 'keep.txt',
      op: 'delete',
      unattributed: true,
      beforeHash: baseline['keep.txt'],
      afterHash: null,
    });
  });
});

describe('git pre-images for sweep entries (issue #371)', () => {
  const OID = 'a'.repeat(40);
  const CTX = { sessionId: 's1', agentId: 'root', timestamp: 2 };

  // Scripted object store: OID → blob bytes, recording blob reads so the
  // "only for changed files" bound is observed, not assumed.
  function fakeGit(blobs: Record<string, Buffer>): {
    run: GitCommand;
    blobReads: string[];
  } {
    const blobReads: string[] = [];
    const run: GitCommand = (args: string[]) => {
      if (args[0] === 'cat-file' && args[1] === '-s') {
        const blob = blobs[args[2] ?? ''];
        if (blob === undefined) return { status: 1, stdout: Buffer.alloc(0) };
        return { status: 0, stdout: Buffer.from(`${blob.length}\n`, 'utf8') };
      }
      if (args[0] === 'cat-file') {
        const oid = args[args.length - 1] ?? '';
        blobReads.push(oid);
        const blob = blobs[oid];
        if (blob === undefined) return { status: 1, stdout: Buffer.alloc(0) };
        return { status: 0, stdout: blob };
      }
      return { status: 1, stdout: Buffer.alloc(0) };
    };
    return { run, blobReads };
  }

  function trackedRoot(): { root: string; journal: FileJournalStore } {
    const root = tmpRoot('ws-git-');
    writeFileSync(join(root, 'tracked.ts'), 'before\n');
    writeFileSync(join(root, 'keep.ts'), 'same\n');
    return { root, journal: new FileJournalStore(tmpRoot('j-git-')) };
  }

  it('stores the git pre-image as the before-blob for a bash-changed tracked file', () => {
    const { root, journal } = trackedRoot();
    const baseline = captureBaseline(root);
    const git: GitBaseline = { 'tracked.ts': OID };
    const { run } = fakeGit({ [OID]: Buffer.from('before\n', 'utf8') });
    writeFileSync(join(root, 'tracked.ts'), 'after, longer\n');
    expect(
      reconcile(journal, baseline, root, CTX, {
        gitBaseline: git,
        gitRun: run,
      }),
    ).toBe(1);
    const entry = journal.entries()[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(entry.op).toBe('write');
    expect(journal.readBefore(entry)).toBe('before\n');
    expect(entry.bytesDelta).toBe(
      Buffer.byteLength('after, longer\n', 'utf8') -
        Buffer.byteLength('before\n', 'utf8'),
    );
    expect(entry.bytesDelta).not.toBe(0);
  });

  it('restores a bash-deleted tracked file entry with its pre-image and a negative delta', () => {
    const { root, journal } = trackedRoot();
    const baseline = captureBaseline(root);
    const git: GitBaseline = { 'tracked.ts': OID, 'keep.ts': OID };
    rmSync(join(root, 'tracked.ts'));
    // keep.ts is unchanged: its OID must never be read (no blob reads for
    // files the sweep did not find changed).
    const { run: run2, blobReads } = fakeGit({
      [OID]: Buffer.from('before\n', 'utf8'),
    });
    expect(
      reconcile(journal, baseline, root, CTX, {
        gitBaseline: git,
        gitRun: run2,
      }),
    ).toBe(1);
    const entry = journal.entries()[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(entry.op).toBe('delete');
    expect(journal.readBefore(entry)).toBe('before\n');
    expect(entry.bytesDelta).toBe(-Buffer.byteLength('before\n', 'utf8'));
    expect(blobReads).toEqual([OID]);
  });

  it('keeps the tool chain when a tool touched the path this run (never the git blob)', () => {
    const { root, journal } = trackedRoot();
    const baseline = captureBaseline(root);
    // The run started before the tool wrote: its entry scopes the sweep's
    // expected state (issue #341).
    const runStart = { count: 0, last: null as null };
    journal.append({
      path: 'tracked.ts',
      op: 'write',
      before: 'before\n',
      after: 'mid\n',
      bytesDelta: -3,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 't1',
      timestamp: 1,
    });
    writeFileSync(join(root, 'tracked.ts'), 'final\n');
    const git: GitBaseline = { 'tracked.ts': OID };
    const { run, blobReads } = fakeGit({
      [OID]: Buffer.from('before\n', 'utf8'),
    });
    expect(
      reconcile(
        journal,
        baseline,
        root,
        { ...CTX, runStart },
        { gitBaseline: git, gitRun: run },
      ),
    ).toBe(1);
    const sweep = journal.entries()[1];
    if (sweep === undefined) throw new Error('missing sweep entry');
    // The chain is v-final → v-mid (the tool entry) → v-before: the sweep's
    // before-side is the tool's after-content, exactly as issue #341 pins.
    expect(journal.readBefore(sweep)).toBe('mid\n');
    expect(blobReads).toEqual([]);
  });

  it('falls back to hash-only when the blob does not match the baseline hash', () => {
    const { root, journal } = trackedRoot();
    const baseline = captureBaseline(root);
    // A stale or filter-mangled OID: the object store answers, but with
    // bytes that are not what the baseline saw. Inventing them as the
    // pre-image would restore the wrong content — keep today's shape.
    const git: GitBaseline = { 'tracked.ts': OID };
    const { run } = fakeGit({ [OID]: Buffer.from('something else\n', 'utf8') });
    writeFileSync(join(root, 'tracked.ts'), 'after\n');
    reconcile(journal, baseline, root, CTX, { gitBaseline: git, gitRun: run });
    const entry = journal.entries()[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(journal.readBefore(entry)).toBe(null);
    expect(entry.beforeHash).toBe(baseline['tracked.ts']);
    expect(entry.bytesDelta).toBe(0);
  });

  it('falls back to hash-only for binary and over-bound pre-images', () => {
    const { root, journal } = trackedRoot();
    const baseline = captureBaseline(root);
    const git: GitBaseline = { 'tracked.ts': OID };
    const binary = Buffer.from([0x61, 0xff, 0xfe, 0x00]);
    const { run, blobReads } = fakeGit({ [OID]: binary });
    writeFileSync(join(root, 'tracked.ts'), 'after\n');
    reconcile(journal, baseline, root, CTX, { gitBaseline: git, gitRun: run });
    const entry = journal.entries()[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(journal.readBefore(entry)).toBe(null);
    expect(blobReads).toEqual([OID]);
  });

  it('never reads a pre-image above the sweep content bound', () => {
    const { root, journal } = trackedRoot();
    const baseline = captureBaseline(root);
    const git: GitBaseline = { 'tracked.ts': OID };
    // The blob the OID names is large: the -s pre-check refuses it before
    // any content is read, so the exit path never pays its size in memory.
    const big = Buffer.alloc(MAX_SWEEP_CONTENT_BYTES + 1, 0x61);
    const { run, blobReads } = fakeGit({ [OID]: big });
    writeFileSync(join(root, 'tracked.ts'), 'after\n');
    reconcile(journal, baseline, root, CTX, { gitBaseline: git, gitRun: run });
    const entry = journal.entries()[0];
    if (entry === undefined) throw new Error('missing entry');
    expect(journal.readBefore(entry)).toBe(null);
    expect(blobReads).toEqual([]);
  });

  it('records a positive delta for a sweep create and zero when git is absent', () => {
    const { root, journal } = trackedRoot();
    const baseline = captureBaseline(root);
    writeFileSync(join(root, 'new.ts'), 'born\n');
    reconcile(journal, baseline, root, CTX);
    const created = journal.entries().find((e) => e.path === 'new.ts');
    if (created === undefined) throw new Error('missing create entry');
    expect(journal.readBefore(created)).toBe(null);
    expect(created.bytesDelta).toBe(Buffer.byteLength('born\n', 'utf8'));
  });
});

describe('HEAD-move markers (issue #378)', () => {
  const CTX = { sessionId: 's1', agentId: 'root', timestamp: 3 };
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);

  // Mutable script: the repo's HEAD as the fake git reports it, so a test
  // can move HEAD between baseline and sweep.
  function headRepo(state: { head: string; branch: string; stash: number }): {
    run: GitCommand;
  } {
    const run: GitCommand = (args: string[]) => {
      if (args[0] === 'rev-parse')
        return { status: 0, stdout: Buffer.from(`${state.head}\n`, 'utf8') };
      if (args[0] === 'symbolic-ref')
        return { status: 0, stdout: Buffer.from(`${state.branch}\n`, 'utf8') };
      if (args[0] === 'stash')
        return {
          status: 0,
          stdout: Buffer.from(
            Array.from({ length: state.stash }, (_, i) => `${i}\n`).join(''),
            'utf8',
          ),
        };
      return { status: 1, stdout: Buffer.alloc(0) };
    };
    return { run };
  }

  function ws(): { root: string; journal: FileJournalStore } {
    const root = tmpRoot('ws-head-');
    writeFileSync(join(root, 'f.txt'), 'v1\n');
    return { root, journal: new FileJournalStore(tmpRoot('j-head-')) };
  }

  it('appends one marker when the run moved HEAD', () => {
    const { root, journal } = ws();
    const baseline = captureBaseline(root);
    const state = { head: SHA_A, branch: 'main', stash: 0 };
    const { run } = headRepo(state);
    const boot = captureHeadState(root, run);
    state.head = SHA_B;
    state.branch = 'feature';
    expect(
      reconcile(journal, baseline, root, CTX, {
        headBaseline: boot,
        gitRun: run,
      }),
    ).toBe(1);
    const entries = journal.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      op: 'marker',
      unattributed: true,
      headFrom: { head: SHA_A, branch: 'main', stash: 0 },
      headTo: { head: SHA_B, branch: 'feature', stash: 0 },
    });
  });

  it('appends nothing when HEAD did not move, and never twice for one move', () => {
    const { root, journal } = ws();
    const baseline = captureBaseline(root);
    const state = { head: SHA_A, branch: 'main', stash: 0 };
    const { run } = headRepo(state);
    const boot = captureHeadState(root, run);
    expect(
      reconcile(journal, baseline, root, CTX, {
        headBaseline: boot,
        gitRun: run,
      }),
    ).toBe(0);
    state.stash = 1;
    expect(
      reconcile(journal, baseline, root, CTX, {
        headBaseline: boot,
        gitRun: run,
      }),
    ).toBe(1);
    // The repeat sweep sees the same move and appends nothing.
    expect(
      reconcile(journal, baseline, root, CTX, {
        headBaseline: boot,
        gitRun: run,
      }),
    ).toBe(0);
    expect(journal.entries()).toHaveLength(1);
  });

  it('emits no marker without a boot snapshot or when HEAD is unresolvable', () => {
    const { root, journal } = ws();
    const baseline = captureBaseline(root);
    const { run } = headRepo({ head: SHA_A, branch: 'main', stash: 0 });
    expect(reconcile(journal, baseline, root, CTX, { gitRun: run })).toBe(0);
    const failing: GitCommand = () => ({
      status: 128,
      stdout: Buffer.alloc(0),
    });
    expect(
      reconcile(journal, baseline, root, CTX, {
        headBaseline: { head: SHA_A, branch: 'main', stash: 0 },
        gitRun: failing,
      }),
    ).toBe(0);
    expect(journal.entries()).toHaveLength(0);
  });
});
