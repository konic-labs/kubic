// Slice C: baseline capture + end-of-run reconciliation (issue #17; §42.1/42.5).
// RED: captureBaseline/reconcile do not exist yet.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureBaseline, FileJournalStore, reconcile } from './journal.js';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
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
    const root = mkdtempSync(join(tmpdir(), 'ws-anchored-'));
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
    const journal = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
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
    const journal = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
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
    const added = reconcile(journal, baseline, root, {
      sessionId: 's1',
      agentId: 'root',
      timestamp: 2,
    });
    expect(added).toBe(0);
  });
});
