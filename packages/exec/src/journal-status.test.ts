// Slice C: log timeline + status (issue #18; §42.2).
// RED: renderLog/journalStatus do not exist yet.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore } from './journal.js';
import {
  journalStatus,
  reconciliationSummary,
  renderLog,
} from './journal-status.js';

function seed(): FileJournalStore {
  const store = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
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

describe('journal log + status (issue #18, slice C)', () => {
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
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const status = journalStatus(seed(), root);
    expect(status.entries).toBe(2);
    expect(status.reversible).toBe(1);
    expect(status.nonReversible).toBe(1);
    expect(status.repo).toBe(null);
  });

  it('reports branch state inside a repository without running naive git', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(root, '.git'));
    writeFileSync(
      join(root, '.git', 'HEAD'),
      'ref: refs/heads/feature/nested\n',
    );
    const status = journalStatus(seed(), root);
    expect(status.repo?.branch).toBe('feature/nested');
  });
});

// Issue #126: inside a linked worktree `.git` is a FILE holding a
// `gitdir: <path>` pointer, so reading `.git/HEAD` says nothing about the
// branch — the real HEAD lives in the pointed-at git dir. Pure file reads
// (no git invocation): a dangling or malformed pointer is named
// `(unknown)`, never a throw, and a genuinely detached HEAD stays
// `(detached)`.
describe('worktree HEAD resolution (issue #126)', () => {
  function linkedWorktree(head: string): { root: string; gitdir: string } {
    const gitdir = mkdtempSync(join(tmpdir(), 'gd-'));
    writeFileSync(join(gitdir, 'HEAD'), head);
    const root = mkdtempSync(join(tmpdir(), 'wt-'));
    writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`);
    return { root, gitdir };
  }

  it('follows the gitdir pointer to the worktree branch, not (detached)', () => {
    const { root } = linkedWorktree('ref: refs/heads/wt-feature\n');
    expect(journalStatus(seed(), root).repo?.branch).toBe('wt-feature');
  });

  it('resolves a relative gitdir pointer against the worktree root', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-'));
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
    const root = mkdtempSync(join(tmpdir(), 'wt-'));
    writeFileSync(
      join(root, '.git'),
      `gitdir: ${join(root, 'absent-gitdir')}\n`,
    );
    const status = journalStatus(seed(), root);
    expect(status.repo?.branch).toBe('(unknown)');
  });

  it('a malformed pointer degrades to (unknown), no throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-'));
    writeFileSync(join(root, '.git'), 'not a gitdir pointer\n');
    expect(journalStatus(seed(), root).repo?.branch).toBe('(unknown)');
  });

  it('the classic .git-directory layout stays byte-for-byte behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/classic\n');
    expect(journalStatus(seed(), root).repo?.branch).toBe('classic');
  });
});

describe('unattributed count (issue #87)', () => {
  it('counts reconciliation finds separately in status', () => {
    const status = journalStatus(seed(), mkdtempSync(join(tmpdir(), 'ws-')));
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
    const empty = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
    expect(journalStatus(empty, mkdtempSync(join(tmpdir(), 'ws-')))).toEqual({
      entries: 0,
      reversible: 0,
      nonReversible: 0,
      unattributed: 0,
      corrupt: 0,
      repo: null,
    });
    expect(reconciliationSummary(empty)).toBe(
      'unattributed: 0 of 0 entr(ies) reconciled at run end',
    );
  });
});

// Blob integrity (issue #111): status names lost content instead of
// letting it hide behind reversibility counts.
describe('corrupt count (issue #111)', () => {
  it('counts entries whose content is unexpectedly missing under a recorded hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'j-'));
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
    const status = journalStatus(store, mkdtempSync(join(tmpdir(), 'ws-')));
    expect(status.corrupt).toBe(1);
  });

  it('does not count designed absences as corrupt', () => {
    // seed()'s unattributed entry records a hash-only pre-image — no
    // before-blob exists by design, and that is not corruption.
    const status = journalStatus(seed(), mkdtempSync(join(tmpdir(), 'ws-')));
    expect(status.corrupt).toBe(0);
  });
});
