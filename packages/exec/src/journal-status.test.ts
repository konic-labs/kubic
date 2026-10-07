// Log timeline + status.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileJournalStore } from './journal.js';
import {
  journalStatus,
  reconciliationSummary,
  renderLog,
} from './journal-status.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
} from './test-support/git-sandbox.js';

const roots: string[] = [];

afterEach(() => {
  // Sandbox disposal restores process.env when a repo was activated.
  disposeAllGitSandboxes();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function seed(): FileJournalStore {
  const store = new FileJournalStore(tmpRoot('j-'));
  store.append({
    path: 'a.txt',
    op: 'edit',
    before: 'x\n',
    after: 'y\n',
    bytesDelta: 0,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 1700000000000,
  });
  store.append({
    path: 'b.txt',
    op: 'write',
    before: null,
    beforeHash: 'abc',
    after: 'm\n',
    bytesDelta: 2,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: null,
    timestamp: 1700000001000,
    unattributed: true,
  });
  return store;
}

describe('journal log + status', () => {
  it('renders the timeline with timestamp/agent/toolCall/op/path/bytes', () => {
    const lines = renderLog(seed());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('edit');
    expect(lines[0]).toContain('a.txt');
    expect(lines[0]).toContain('root');
    expect(lines[0]).toContain('call-1');
    expect(lines[0]).toContain('2023-11-14T22:13:20.000Z');
    expect(lines[1]).toContain('reconciled');
  });

  it('reports non-repo status outside a repository', () => {
    const root = tmpRoot('ws-');
    const status = journalStatus(seed(), root);
    expect(status.entries).toBe(2);
    expect(status.reversible).toBe(1);
    expect(status.nonReversible).toBe(1);
    expect(status.repo).toBe(null);
  });

  it('reports branch state inside a repository without running naive git', () => {
    const root = tmpRoot('ws-');
    mkdirSync(join(root, '.git'));
    writeFileSync(
      join(root, '.git', 'HEAD'),
      'ref: refs/heads/feature/nested\n',
    );
    const status = journalStatus(seed(), root);
    expect(status.repo?.branch).toBe('feature/nested');
  });
});

// Inside a linked worktree `.git` is a FILE holding a
// `gitdir: <path>` pointer, so reading `.git/HEAD` says nothing about the
// branch — the real HEAD lives in the pointed-at git dir. Pure file reads
// (no git invocation): a dangling or malformed pointer is named
// `(unknown)`, never a throw, and a genuinely detached HEAD stays
// `(detached)`.
describe('worktree HEAD resolution', () => {
  function linkedWorktree(head: string): { root: string; gitdir: string } {
    const gitdir = tmpRoot('gd-');
    writeFileSync(join(gitdir, 'HEAD'), head);
    const root = tmpRoot('wt-');
    writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`);
    return { root, gitdir };
  }

  it('follows the gitdir pointer to the worktree branch, not (detached)', () => {
    const { root } = linkedWorktree('ref: refs/heads/wt-feature\n');
    expect(journalStatus(seed(), root).repo?.branch).toBe('wt-feature');
  });

  it('resolves a relative gitdir pointer against the worktree root', () => {
    const root = tmpRoot('wt-');
    const gitdir = join(root, '.git-worktrees', 'wt');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/relative-branch\n');
    writeFileSync(join(root, '.git'), 'gitdir: .git-worktrees/wt\n');
    expect(journalStatus(seed(), root).repo?.branch).toBe('relative-branch');
  });

  it('a genuinely detached worktree HEAD still reports (detached)', () => {
    const { root } = linkedWorktree(`${'a'.repeat(40)}\n`);
    expect(journalStatus(seed(), root).repo?.branch).toBe('(detached)');
  });

  it('a dangling pointer degrades to (unknown), no throw', () => {
    const root = tmpRoot('wt-');
    writeFileSync(
      join(root, '.git'),
      `gitdir: ${join(root, 'absent-gitdir')}\n`,
    );
    const status = journalStatus(seed(), root);
    expect(status.repo?.branch).toBe('(unknown)');
  });

  it('a malformed pointer degrades to (unknown), no throw', () => {
    const root = tmpRoot('wt-');
    writeFileSync(join(root, '.git'), 'not a gitdir pointer\n');
    expect(journalStatus(seed(), root).repo?.branch).toBe('(unknown)');
  });

  it('the classic .git-directory layout stays byte-for-byte behavior', () => {
    const root = tmpRoot('ws-');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/classic\n');
    expect(journalStatus(seed(), root).repo?.branch).toBe('classic');
  });
});

describe('unattributed count', () => {
  it('counts reconciliation finds separately in status', () => {
    const status = journalStatus(seed(), tmpRoot('ws-'));
    expect(status.entries).toBe(2);
    expect(status.unattributed).toBe(1);
  });

  it('renders the count as a log summary line, keeping per-entry lines', () => {
    const lines = renderLog(seed());
    expect(lines).toHaveLength(2);
    expect(reconciliationSummary(seed())).toBe(
      'unattributed: 1 of 2 entr(ies) reconciled at run end',
    );
  });

  it('summarizes an empty journal without inventing entries', () => {
    const empty = new FileJournalStore(tmpRoot('j-'));
    expect(journalStatus(empty, tmpRoot('ws-'))).toEqual({
      entries: 0,
      reversible: 0,
      nonReversible: 0,
      unattributed: 0,
      corrupt: 0,
      corruptLines: 0,
      // No moves in an empty journal — the field is always
      // present so `--json` keeps a stable shape.
      headMoves: [],
      repo: null,
    });
    expect(reconciliationSummary(empty)).toBe(
      'unattributed: 0 of 0 entr(ies) reconciled at run end',
    );
  });
});

// Torn index lines: a fragment left by a crash or a full disk
// is dropped from the read — it must never poison the journal — but the
// drop is named in the status instead of staying silent, so an operator can
// tell an empty journal from an unreadable one.
describe('corrupt index lines', () => {
  it('counts unparsable index lines and keeps the readable entries', () => {
    const dir = tmpRoot('j-');
    const store = new FileJournalStore(dir);
    store.append({
      path: 'a.txt',
      op: 'create',
      before: null,
      after: 'x\n',
      bytesDelta: 2,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });
    appendFileSync(join(dir, 'index.jsonl'), '{"path":"torn\n');
    const status = journalStatus(store, tmpRoot('ws-'));
    expect(status.corruptLines).toBe(1);
    // A dropped line is not content corruption: no entry claims that
    // content, so the blob-integrity count stays where it was.
    expect(status.corrupt).toBe(0);
    expect(status.entries).toBe(1);
    expect(status.reversible).toBe(1);
  });

  it('reports zero for a clean index', () => {
    expect(journalStatus(seed(), tmpRoot('ws-')).corruptLines).toBe(0);
  });
});

// Blob integrity: status names lost content instead of
// letting it hide behind reversibility counts.
describe('corrupt count', () => {
  it('counts entries whose content is unexpectedly missing under a recorded hash', () => {
    const dir = tmpRoot('j-');
    const store = new FileJournalStore(dir);
    const recorded = store.append({
      path: 'a.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });
    writeFileSync(join(dir, 'blobs', recorded.afterHash ?? ''), 'tampered\n');
    const status = journalStatus(store, tmpRoot('ws-'));
    expect(status.corrupt).toBe(1);
  });

  it('does not count designed absences as corrupt', () => {
    // seed()'s unattributed entry records a hash-only pre-image — no
    // before-blob exists by design, and that is not corruption.
    const status = journalStatus(seed(), tmpRoot('ws-'));
    expect(status.corrupt).toBe(0);
  });
});

describe('HEAD-move markers in log + status', () => {
  const MOVE_A = { head: 'a'.repeat(40), branch: 'main', stash: 0 };
  const MOVE_B = { head: 'b'.repeat(40), branch: 'feature', stash: 0 };

  function withMarker(): FileJournalStore {
    const store = seed();
    store.append({
      path: '',
      op: 'marker',
      before: null,
      after: null,
      bytesDelta: 0,
      headFrom: MOVE_A,
      headTo: MOVE_B,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: 1700000002000,
      unattributed: true,
    });
    return store;
  }

  it('renders the marker as one greppable log line, never a diff hunk', () => {
    const lines = renderLog(withMarker());
    expect(lines).toHaveLength(3);
    const marker = lines[2] ?? '';
    expect(marker).toContain('marker');
    expect(marker).toContain('head-moved');
    expect(marker).toContain(`main@${'a'.repeat(12)}`);
    expect(marker).toContain(`feature@${'b'.repeat(12)}`);
  });

  it('counts the marker as unattributed work and reports the move', () => {
    const root = tmpRoot('ws-head-status-');
    const status = journalStatus(withMarker(), root);
    expect(status.entries).toBe(3);
    expect(status.unattributed).toBe(2);
    // The marker has nothing to restore: non-reversible, never corrupt.
    expect(status.reversible + status.nonReversible).toBe(status.entries);
    expect(status.corrupt).toBe(0);
    expect(status.headMoves).toEqual([{ from: MOVE_A, to: MOVE_B }]);
    expect(status.repo).toBe(null);
  });
});

// Repo root, ahead/behind and conflicts on `kubic status`.
// RepoState is only branch and dirty.
describe('status repo ahead/behind, root and conflicts', () => {
  function commitFile(
    repo: { path: string; git(args: readonly string[]): string },
    name: string,
    content: string,
  ): void {
    writeFileSync(join(repo.path, name), content);
    repo.git(['add', '--', name]);
    repo.git(['commit', '-q', '-m', `add ${name}`]);
  }

  it('reports the repo root and zero ahead/behind on a plain repo', () => {
    const repo = createGitSandbox({ prefix: 'kubic-status-380-' });
    repo.activate();
    commitFile(repo, 'a.txt', 'one\n');
    const state = journalStatus(seed(), repo.path).repo;
    expect(state?.branch).toBe('main');
    expect(state?.repoRoot).toBe(repo.path);
    expect(state?.ahead).toBe(null);
    expect(state?.behind).toBe(null);
    expect(state?.conflicts).toEqual([]);
  });

  it('reports ahead/behind against a local upstream', () => {
    const repo = createGitSandbox({ prefix: 'kubic-status-380-' });
    repo.activate();
    const origin = tmpRoot('origin-');
    repo.git(['init', '--bare', '-q', origin]);
    commitFile(repo, 'a.txt', 'one\n');
    repo.git(['remote', 'add', 'origin', origin]);
    repo.git(['push', '-qu', 'origin', 'main']);
    commitFile(repo, 'b.txt', 'two\n');
    const state = journalStatus(seed(), repo.path).repo;
    expect(state?.ahead).toBe(1);
    expect(state?.behind).toBe(0);
  });

  it('reports conflicted paths after a conflicting merge', () => {
    const repo = createGitSandbox({ prefix: 'kubic-status-380-' });
    repo.activate();
    commitFile(repo, 'f.txt', 'base\n');
    repo.git(['checkout', '-qb', 'feature']);
    commitFile(repo, 'f.txt', 'theirs\n');
    repo.git(['checkout', '-q', 'main']);
    commitFile(repo, 'f.txt', 'ours\n');
    repo.gitResult(['merge', 'feature']);
    const state = journalStatus(seed(), repo.path).repo;
    expect(state?.conflicts).toEqual(['f.txt']);
    expect(state?.dirty).toBe(true);
  });
});
