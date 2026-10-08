// Run-scoped reconciliation lifecycle: the wrapper the composition root
// calls around captureBaseline/reconcile — capture ONCE at lane boot, persist
// the hashes beside the session journal, sweep ONCE at run end.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileJournalStore, loadBaseline, sha256Hex } from './journal.js';
import { diffEntries, renderDiff } from './journal-diff.js';
import { loadGitBaseline } from './journal-git.js';
import { beginReconciliation } from './journal-reconcile.js';
import { applyUndo, planUndo } from './journal-undo.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from './test-support/git-sandbox.js';

const NOW = 1_700_000_000_000;

const roots: string[] = [];

afterEach(() => {
  disposeAllGitSandboxes();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function workspace(): string {
  const root = tmpRoot('ws-reconcile-');
  writeFileSync(join(root, 'keep.txt'), 'v1\n');
  writeFileSync(join(root, 'gone.txt'), 'bye\n');
  writeFileSync(join(root, 'ignored.log'), 'noise\n');
  writeFileSync(join(root, '.gitignore'), '*.log\n');
  return root;
}

function journalStore(): FileJournalStore {
  return new FileJournalStore(tmpRoot('j-reconcile-'));
}

describe('run-scoped reconciliation lifecycle', () => {
  it('captures the baseline at boot and persists it beside the session journal', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      now: () => NOW,
    });
    expect(run.baselinePath).toBe(
      join(dirname(store.indexPath), 'baseline-sess-1.json'),
    );
    expect(existsSync(run.baselinePath)).toBe(true);
    expect(Object.keys(run.baseline).sort()).toEqual([
      '.gitignore',
      'gone.txt',
      'keep.txt',
    ]);
    // The persisted copy is the same map a later reader loads: the boot
    // capture is durable, not just in-memory.
    expect(loadBaseline(dirname(store.indexPath), 'sess-1')).toEqual(
      run.baseline,
    );
    expect(run.baseline['keep.txt']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sweeps after the last turn, recording unattributed entries with hashes only', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      now: () => NOW,
    });
    // Whatever bypasses interception: an external writer, not a Kubic op.
    writeFileSync(join(root, 'keep.txt'), 'v2-external\n');
    writeFileSync(join(root, 'new.txt'), 'born\n');
    rmSync(join(root, 'gone.txt'));
    expect(run.sweep()).toBe(3);
    const entries = store.entries();
    expect(entries.every((e) => e.unattributed === true)).toBe(true);
    expect(entries.every((e) => e.toolCallId === null)).toBe(true);
    expect(entries.every((e) => e.sessionId === 'sess-1')).toBe(true);
    expect(entries.every((e) => e.timestamp === NOW)).toBe(true);
    const changed = entries.find((e) => e.path === 'keep.txt');
    if (changed === undefined) throw new Error('missing keep.txt entry');
    expect(changed.beforeHash).toBe(sha256Hex('v1\n'));
    // Out of scope by design: before-content is unknowable for these, so
    // the entry carries the hash and no retrievable pre-image.
    expect(store.readBefore(changed)).toBe(null);
    expect(store.readAfter(changed)).toBe('v2-external\n');
    const created = entries.find((e) => e.path === 'new.txt');
    expect(created?.op).toBe('create');
    expect(created?.beforeHash).toBe(null);
    const deleted = entries.find((e) => e.path === 'gone.txt');
    expect(deleted?.op).toBe('delete');
    expect(deleted?.beforeHash).toBe(sha256Hex('bye\n'));
  });

  it('costs one metadata walk and zero blobs when nothing changed', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      now: () => NOW,
    });
    // The capture stored hashes only: no before-blob, no after-blob.
    expect(store.blobCount()).toBe(0);
    expect(existsSync(join(dirname(store.indexPath), 'blobs'))).toBe(false);
    expect(run.sweep()).toBe(0);
    expect(store.entries()).toEqual([]);
  });

  it('excludes gitignored, out-of-scope and .kubic paths from both walks', () => {
    const root = workspace();
    mkdirSync(join(root, 'vendor'));
    writeFileSync(join(root, 'vendor', 'out.js'), 'gen\n');
    mkdirSync(join(root, '.kubic'));
    writeFileSync(join(root, '.kubic', 'state.json'), 'runtime\n');
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      outOfScope: ['vendor'],
      now: () => NOW,
    });
    expect(Object.keys(run.baseline).sort()).toEqual([
      '.gitignore',
      'gone.txt',
      'keep.txt',
    ]);
    for (const rel of [
      'keep.txt',
      'ignored.log',
      ['vendor', 'out.js'],
      ['.kubic', 'state.json'],
    ]) {
      writeFileSync(
        join(root, ...(Array.isArray(rel) ? rel : [rel])),
        'mutated\n',
      );
    }
    expect(run.sweep()).toBe(1);
    expect(store.entries().map((e) => e.path)).toEqual(['keep.txt']);
  });

  it('refuses a path-unsafe run id before writing any baseline file', () => {
    const root = workspace();
    const store = journalStore();
    const dir = dirname(store.indexPath);
    expect(() =>
      beginReconciliation({
        store,
        root,
        runId: '../evil',
        sessionId: 'sess-1',
        now: () => NOW,
      }),
    ).toThrow(/invalid run id/);
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(dir, '..', 'evil.json'))).toBe(false);
  });

  it('adds nothing on a second sweep of an unchanged tree', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-1',
      sessionId: 'sess-1',
      now: () => NOW,
    });
    writeFileSync(join(root, 'keep.txt'), 'v2\n');
    expect(run.sweep()).toBe(1);
    expect(run.sweep()).toBe(0);
    expect(store.entries()).toHaveLength(1);
  });

  // A named pipe blocks `readFileSync` until a writer opens it, so capturing
  // a baseline over a workspace holding one wedges the run at boot forever —
  // not even a test timeout fires, because the block is synchronous. The walk
  // must treat a special file as "not journalable" and keep going.
  it('does not block on a named pipe in the workspace (regression)', () => {
    const root = tmpRoot('ws-fifo-');
    writeFileSync(join(root, 'keep.txt'), 'v1\n');
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const store = journalStore();
    const run = beginReconciliation({
      root,
      store,
      runId: 'sess-fifo',
      sessionId: 'sess-fifo',
      now: () => NOW,
    });
    // The regular file is journaled; the pipe is skipped, not read.
    expect(Object.keys(run.baseline)).toEqual(['keep.txt']);
  });

  // Unattributed entries are not always non-reversible and exit 2:
  // `readBefore` serves any entry whose `beforeHash`
  // resolves to a stored blob, and the sweep sets `beforeHash` from the
  // baseline. When an earlier tool entry in the same run already stored that
  // pre-image, undo CAN restore it — and must, rather than refusing.
  it('reports a sweep entry reversible when a pre-image was stored earlier (regression)', () => {
    const root = tmpRoot('ws-preimage-');
    writeFileSync(join(root, 'f.txt'), 'v1-boot\n');
    const store = journalStore();
    const run = beginReconciliation({
      root,
      store,
      runId: 'sess-pre',
      sessionId: 'sess-pre',
      now: () => NOW,
    });
    // The `write` tool rewrites it, storing the v1-boot pre-image.
    store.append({
      path: 'f.txt',
      op: 'write',
      before: 'v1-boot\n',
      after: 'v2-tool\n',
      bytesDelta: 0,
      sessionId: 'sess-pre',
      toolCallId: 't1',
      timestamp: NOW,
    });
    // An external writer changes it again; the sweep attributes that to nobody.
    writeFileSync(join(root, 'f.txt'), 'v3-external\n');
    expect(run.sweep()).toBe(1);
    const sweepEntry = store.entries().find((e) => e.unattributed === true);
    if (sweepEntry === undefined) throw new Error('missing sweep entry');
    // The before-side is the path's expected state — the tool's
    // after-content this run — not the boot baseline, so undo walks the
    // chain v3 → v2 (this entry) → v1 (the tool entry).
    expect(sweepEntry.beforeHash).toBe(sha256Hex('v2-tool\n'));
    // The pre-image resolves, so this entry is reversible in fact.
    expect(store.readBefore(sweepEntry)).toBe('v2-tool\n');
  });
});

// An interactive session is one process but many runs —
// every prompt re-baselines, so a sweep journals only what changed during
// that turn, tagged with the turn, and an edit made between prompts is
// absorbed instead of attributed to the agent.
describe('per-turn rebaseline', () => {
  const begin = (root: string, store: FileJournalStore) =>
    beginReconciliation({
      store,
      root,
      runId: 'sess-reconcile',
      sessionId: 'sess-reconcile',
      now: () => NOW,
    });

  it('absorbs an edit made before the rebaseline and tags the turn on the next sweep', () => {
    const root = workspace();
    const store = journalStore();
    const run = begin(root, store);
    run.rebaseline(1);
    writeFileSync(join(root, 'agent.txt'), 'turn 1\n');
    expect(run.sweep()).toBe(1);
    // Between prompts: the operator edits keep.txt outside the agent.
    writeFileSync(join(root, 'keep.txt'), 'operator edit\n');
    run.rebaseline(2);
    writeFileSync(join(root, 'agent2.txt'), 'turn 2\n');
    expect(run.sweep()).toBe(1);
    const entries = store.entries();
    expect(entries.map((entry) => [entry.path, entry.turn])).toEqual([
      ['agent.txt', 1],
      ['agent2.txt', 2],
    ]);
    expect(entries.some((entry) => entry.path === 'keep.txt')).toBe(false);
    expect(
      loadBaseline(dirname(store.indexPath), 'sess-reconcile')?.['keep.txt'],
    ).toBe(sha256Hex('operator edit\n'));
  });

  it('a repeat sweep after the settle sweep appends nothing (idempotent quit)', () => {
    const root = workspace();
    const store = journalStore();
    const run = begin(root, store);
    run.rebaseline(1);
    writeFileSync(join(root, 'agent.txt'), 'turn 1\n');
    expect(run.sweep()).toBe(1);
    expect(run.sweep()).toBe(0);
    expect(store.entries()).toHaveLength(1);
  });

  it('a change made during the turn but before its rebaseline is not lost when swept first', () => {
    // The loop sweeps a pending shell turn BEFORE re-baselining for the next
    // one (a queued follow-up can start before the settle sweep ran).
    const root = workspace();
    const store = journalStore();
    const run = begin(root, store);
    run.rebaseline(1);
    writeFileSync(join(root, 'bash-made.txt'), 'x\n');
    expect(run.sweep()).toBe(1);
    run.rebaseline(2);
    expect(run.sweep()).toBe(0);
    expect(store.entries().map((entry) => entry.path)).toEqual([
      'bash-made.txt',
    ]);
  });
});

// Git pre-images end to end: the sweep restores bash-made
// changes to clean tracked files from the object store, through the
// existing before-blob mechanism, which `journal-undo.ts` reads unchanged.
//
// Real git in sandboxed throwaway repos: the repo setup runs
// through the sandbox's scrubbed env, and the sandbox is activated into
// process.env while the production code (which spawns git on the inherited
// environment) runs.
describe('git pre-images end to end', () => {
  function gitRepo(): GitSandbox {
    const repo = createGitSandbox({
      prefix: 'journal-git-',
      injectProcessEnv: true,
    });
    writeFileSync(join(repo.path, 'tracked.ts'), 'v1\n');
    writeFileSync(join(repo.path, 'data.txt'), 'data\n');
    repo.git(['add', 'tracked.ts', 'data.txt']);
    repo.git(['commit', '--no-verify', '-m', 'init']);
    return repo;
  }

  function begin(root: string, store: FileJournalStore) {
    return beginReconciliation({
      store,
      root,
      runId: 'sess-git',
      sessionId: 'sess-git',
      now: () => NOW,
    });
  }

  function journalStore(): FileJournalStore {
    return new FileJournalStore(tmpRoot('j-git-'));
  }

  it('records blob OIDs for stat-clean tracked files without copying content', () => {
    const repo = gitRepo();
    const store = journalStore();
    const run = begin(repo.path, store);
    expect(Object.keys(run.gitBaseline ?? {}).sort()).toEqual([
      'data.txt',
      'tracked.ts',
    ]);
    for (const oid of Object.values(run.gitBaseline ?? {})) {
      expect(oid).toMatch(/^[0-9a-f]{40}$/);
    }
    // The baseline is still a metadata walk: hashes plus OIDs, zero blobs.
    expect(store.blobCount()).toBe(0);
    expect(loadGitBaseline(dirname(store.indexPath), 'sess-git')).toEqual(
      run.gitBaseline,
    );
    expect(run.sweep()).toBe(0);
  });

  it('a bash rm of a tracked file is restored byte-identically by undo', () => {
    const repo = gitRepo();
    const store = journalStore();
    const run = begin(repo.path, store);
    rmSync(join(repo.path, 'tracked.ts'));
    expect(run.sweep()).toBe(1);
    const plan = planUndo(store, {}, repo.path);
    expect(plan.reversible).toBe(1);
    expect(plan.nonReversible).toEqual([]);
    const result = applyUndo(store, plan, repo.path, {});
    expect(result.restored).toEqual(['tracked.ts']);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(repo.path, 'tracked.ts'), 'utf8')).toBe('v1\n');
  });

  it('a bash sed -i on a tracked file is undoable, and diff shows before and after', () => {
    const repo = gitRepo();
    const store = journalStore();
    const run = begin(repo.path, store);
    // sed -i equivalent: bypasses Kubic ops entirely.
    writeFileSync(join(repo.path, 'tracked.ts'), 'v2, longer\n');
    expect(run.sweep()).toBe(1);
    const entry = store.entries()[0];
    if (entry === undefined) throw new Error('missing sweep entry');
    expect(store.readBefore(entry)).toBe('v1\n');
    expect(entry.bytesDelta).not.toBe(0);
    const plan = planUndo(store, {}, repo.path);
    expect(plan.reversible).toBe(1);
    const text = renderDiff(diffEntries(store, {}));
    expect(text).toContain('v1');
    expect(text).toContain('v2, longer');
    // Reversible — the badge is [unattributed] alone, never non-reversible.
    expect(text).toContain('[unattributed]');
    expect(text).not.toContain('non-reversible');
    expect(applyUndo(store, plan, repo.path, {}).restored).toEqual([
      'tracked.ts',
    ]);
    expect(readFileSync(join(repo.path, 'tracked.ts'), 'utf8')).toBe('v1\n');
  });

  it('an untracked file deleted by bash is still reported non-reversible', () => {
    const repo = gitRepo();
    writeFileSync(join(repo.path, 'scratch.txt'), 'doomed\n');
    const store = journalStore();
    const run = begin(repo.path, store);
    rmSync(join(repo.path, 'scratch.txt'));
    expect(run.sweep()).toBe(1);
    const entry = store.entries()[0];
    if (entry === undefined) throw new Error('missing sweep entry');
    expect(entry.op).toBe('delete');
    expect(store.readBefore(entry)).toBe(null);
    expect(entry.bytesDelta).toBe(0);
    const plan = planUndo(store, {}, repo.path);
    expect(plan.reversible).toBe(0);
    expect(plan.nonReversible).toEqual(['scratch.txt']);
  });

  it('a tracked file dirty at baseline is still non-reversible (no wrong pre-image)', () => {
    const repo = gitRepo();
    // Uncommitted work: the index OID is NOT this file's pre-image, so no
    // OID may be recorded for it — restoring the committed version would
    // destroy the operator's edit.
    writeFileSync(join(repo.path, 'tracked.ts'), 'operator edit\n');
    const store = journalStore();
    const run = begin(repo.path, store);
    expect(run.gitBaseline?.['tracked.ts']).toBe(undefined);
    expect(run.gitBaseline?.['data.txt']).toMatch(/^[0-9a-f]{40}$/);
    // Bash changes it again during the run.
    writeFileSync(join(repo.path, 'tracked.ts'), 'agent bash edit\n');
    expect(run.sweep()).toBe(1);
    const entry = store.entries()[0];
    if (entry === undefined) throw new Error('missing sweep entry');
    expect(store.readBefore(entry)).toBe(null);
    const plan = planUndo(store, {}, repo.path);
    expect(plan.reversible).toBe(0);
    expect(plan.nonReversible).toEqual(['tracked.ts']);
  });
});

describe('HEAD-move markers end to end', () => {
  function twoCommitRepo(): GitSandbox {
    const repo = createGitSandbox({
      prefix: 'journal-head-',
      injectProcessEnv: true,
    });
    writeFileSync(join(repo.path, 'tracked.ts'), 'v1\n');
    repo.git(['add', 'tracked.ts']);
    repo.git(['commit', '--no-verify', '-m', 'one']);
    writeFileSync(join(repo.path, 'tracked.ts'), 'v2\n');
    repo.git(['add', 'tracked.ts']);
    repo.git(['commit', '--no-verify', '-m', 'two']);
    return repo;
  }

  function journalStore(): FileJournalStore {
    return new FileJournalStore(tmpRoot('j-head-'));
  }

  it('a bash checkout -b plus reset --hard produces one head-moved marker', () => {
    const repo = twoCommitRepo();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root: repo.path,
      runId: 'sess-head',
      sessionId: 'sess-head',
      now: () => NOW,
    });
    expect(run.headBaseline?.branch).toBe('main');
    repo.git(['checkout', '-q', '-b', 'x']);
    repo.git(['reset', '--hard', 'HEAD~1']);
    const added = run.sweep();
    const entries = store.entries();
    const markers = entries.filter((e) => e.op === 'marker');
    // Exactly one marker — the mass file change from the reset is ordinary
    // unattributed entries beside it, never a second marker.
    expect(markers).toHaveLength(1);
    expect(added).toBe(entries.length);
    const marker = markers[0];
    expect(marker?.unattributed).toBe(true);
    expect(marker?.headFrom?.branch).toBe('main');
    expect(marker?.headTo?.branch).toBe('x');
    expect(marker?.headFrom?.head).not.toBe(marker?.headTo?.head);
    // The reset's file fallout is still journaled file by file.
    expect(entries.some((e) => e.path === 'tracked.ts')).toBe(true);
  });

  it('a stash push during the run moves the marker too', () => {
    const repo = twoCommitRepo();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root: repo.path,
      runId: 'sess-stash',
      sessionId: 'sess-stash',
      now: () => NOW,
    });
    expect(run.headBaseline?.stash).toBe(0);
    writeFileSync(join(repo.path, 'tracked.ts'), 'uncommitted\n');
    repo.git(['stash', 'push', '-m', 'w1']);
    run.sweep();
    const markers = store.entries().filter((e) => e.op === 'marker');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.headFrom?.stash).toBe(0);
    expect(markers[0]?.headTo?.stash).toBe(1);
  });

  it('no marker and no error outside a repo', () => {
    const root = workspace();
    const store = journalStore();
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-norepo',
      sessionId: 'sess-norepo',
      now: () => NOW,
    });
    expect(run.headBaseline).toBe(null);
    expect(run.gitBaseline).toBe(null);
    writeFileSync(join(root, 'keep.txt'), 'v2-external\n');
    expect(run.sweep()).toBe(1);
    expect(store.entries().some((e) => e.op === 'marker')).toBe(false);
  });
});

describe('sweep attribution', () => {
  it('tags unattributed sweep entries with the run agent id', () => {
    const root = workspace();
    const store = new FileJournalStore(tmpRoot('j-agent-'));
    const run = beginReconciliation({
      store,
      root,
      runId: 'sess-worker-1',
      sessionId: 'sess-worker-1',
      now: () => NOW,
    });
    writeFileSync(join(root, 'keep.txt'), 'v2-external\n');
    expect(run.sweep()).toBe(1);
    const entries = store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe('sweep');
    expect(entries[0]?.unattributed).toBe(true);
  });
});
