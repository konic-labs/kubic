// Slice D: `kubic diff / undo / log / status` CLI (issue #18; §42.2, §78).
// RED: runJournalCommand does not exist yet.
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore } from '../../exec/src/journal.js';
import { runJournalCommand } from './journal-cli.js';

function setup(): {
  journalDir: string;
  root: string;
  out: { lines: string[]; write: (line: string) => void };
} {
  const journalDir = mkdtempSync(join(tmpdir(), 'j-'));
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  writeFileSync(join(root, 'a.txt'), 'v1\n');
  const store = new FileJournalStore(journalDir);
  store.append({
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
  writeFileSync(join(root, 'a.txt'), 'v2\n');
  const lines: string[] = [];
  return {
    journalDir,
    root,
    out: { lines, write: (line) => lines.push(line) },
  };
}

describe('journal CLI (issue #18, slice D)', () => {
  it('diffs with attribution and filters, --json parses', async () => {
    const { journalDir, root, out } = setup();
    const deps = { journalDir, root, out: out.write };
    expect(await runJournalCommand(['diff'], deps)).toBe(0);
    expect(out.lines.join('\n')).toContain('agent=root toolCall=call-1');
    const none: string[] = [];
    expect(
      await runJournalCommand(['diff', '--agent', 'nobody'], {
        ...deps,
        out: (l: string) => none.push(l),
      }),
    ).toBe(0);
    expect(none).toEqual(['no changes']);
    const json: string[] = [];
    expect(
      await runJournalCommand(['diff', '--json'], {
        ...deps,
        out: (l) => json.push(l),
      }),
    ).toBe(0);
    const parsed = JSON.parse(json.join('\n')) as Array<{ path: string }>;
    expect(parsed[0]?.path).toBe('a.txt');
  });

  it('undoes to pre-run content, dry-runs cleanly, and logs the timeline', async () => {
    const { journalDir, root, out } = setup();
    const deps = { journalDir, root, out: out.write };
    const dry: string[] = [];
    expect(
      await runJournalCommand(['undo', '--dry-run'], {
        ...deps,
        out: (l) => dry.push(l),
      }),
    ).toBe(0);
    expect(dry.join('\n')).toContain('would restore');
    expect(await runJournalCommand(['undo'], deps)).toBe(0);
    const log: string[] = [];
    expect(
      await runJournalCommand(['log'], { ...deps, out: (l) => log.push(l) }),
    ).toBe(0);
    expect(log.join('\n')).toContain('a.txt');
    const status: string[] = [];
    expect(
      await runJournalCommand(['status'], {
        ...deps,
        out: (l) => status.push(l),
      }),
    ).toBe(0);
    expect(status.join('\n')).toContain('non-repo');
  });

  it('exits 2 on partial undo and 1 on bad usage', async () => {
    const { journalDir, root, out } = setup();
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'ghost.txt',
      op: 'write',
      before: null,
      after: 'm\n',
      bytesDelta: 1,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: null,
      timestamp: 2,
      unattributed: true,
    });
    const lines: string[] = [];
    const deps = { journalDir, root, out: (l: string) => lines.push(l) };
    expect(await runJournalCommand(['undo'], deps)).toBe(2);
    expect(lines.join('\n')).toContain('non-reversible');
    expect(await runJournalCommand(['frobnicate'], deps)).toBe(1);
    expect(await runJournalCommand(['diff', '--agent'], deps)).toBe(1);
    void out;
  });
});

// Issue #108: `kubic undo` refuses to overwrite files that changed after
// the journaled entry (staleness check on afterHash); `--force` overrides.
describe('journal CLI undo staleness (issue #108)', () => {
  function seedStale(): {
    journalDir: string;
    root: string;
  } {
    const journalDir = mkdtempSync(join(tmpdir(), 'j-'));
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    // Journaled v1→v2, then a manual edit landed v3 after the fact.
    writeFileSync(join(root, 'stale.txt'), 'v3\n');
    new FileJournalStore(journalDir).append({
      path: 'stale.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });
    return { journalDir, root };
  }

  it('skips stale steps with a named reason and exits 2, disk untouched', async () => {
    const { journalDir, root } = seedStale();
    const lines: string[] = [];
    const code = await runJournalCommand(['undo'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    const text = lines.join('\n');
    expect(text).toContain('stale (skipped): stale.txt');
    expect(text).toContain('undo: 0 restored, 1 skipped (1 stale)');
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
  });

  it('--force restores past the staleness refusal', async () => {
    const { journalDir, root } = seedStale();
    const lines: string[] = [];
    const code = await runJournalCommand(['undo', '--force'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('restored stale.txt');
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v1\n');
  });

  it('--dry-run reports the stale split without writing, and usage names --force', async () => {
    const { journalDir, root } = seedStale();
    const lines: string[] = [];
    const code = await runJournalCommand(['undo', '--dry-run'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('would restore 0 step(s)');
    expect(text).toContain('skip 1 (1 stale): stale.txt');
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
    const usageLines: string[] = [];
    expect(
      await runJournalCommand(['undo', '--help'], {
        journalDir,
        root,
        out: (l) => usageLines.push(l),
      }),
    ).toBe(0);
    expect(usageLines.join('\n')).toContain('--force');
  });
});

// Blob integrity (issue #111): a torn delta blob must print the corrupt
// marker and exit 0 — a readable journal is worth more than a crash.
describe('journal CLI corrupt content (issue #111)', () => {
  function seedTornDelta(): { journalDir: string; root: string } {
    const journalDir = mkdtempSync(join(tmpdir(), 'j-'));
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const store = new FileJournalStore(journalDir);
    const before = 'b\n'.repeat(40_000);
    const after = 'c\n'.repeat(40_000);
    const recorded = store.append({
      path: 'big.txt',
      op: 'write',
      before,
      after,
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 100,
    });
    writeFileSync(join(journalDir, 'blobs', recorded.deltaHash ?? ''), '{torn');
    return { journalDir, root };
  }

  it('diff prints the corrupt marker and exits 0 over a torn delta blob', async () => {
    // Today: uncaught SyntaxError kills `kubic diff` with a raw stack.
    const { journalDir, root } = seedTornDelta();
    const lines: string[] = [];
    const code = await runJournalCommand(['diff'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('# [corrupt journal content]');
  });

  it('status counts a corrupt: line', async () => {
    const { journalDir, root } = seedTornDelta();
    const lines: string[] = [];
    const code = await runJournalCommand(['status'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('corrupt: 1');
  });
});

// Issue #125: the bare journal CLI resolves `<root>/.kubic/journal` — a
// store no runtime path writes (runs journal under
// `<sessions-root>/<id>/journal`), so `kubic diff` after `kubic run` printed
// `no changes` from a dead store. With no workspace store, bare commands
// fall back to the latest session journal and name it first (`session: <id>`)
// so the fallback is never silent; `--json` keeps its parseable envelope.
describe('journal CLI default store fallback (issue #125)', () => {
  function seedSessions(): {
    root: string;
    sessionsRoot: string;
    oldId: string;
    newId: string;
  } {
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'sr-'));
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const oldId = 'sess-old';
    const newId = 'sess-new';
    const seed = (
      id: string,
      path: string,
      before: string,
      after: string,
      mtime: Date,
    ): void => {
      const dir = join(sessionsRoot, id, 'journal');
      new FileJournalStore(dir).append({
        path,
        op: 'write',
        before,
        after,
        bytesDelta: 0,
        sessionId: id,
        agentId: 'root',
        toolCallId: 'call-1',
        timestamp: 1700000000000,
      });
      // Pin newest-journal ordering explicitly — append order can tie at
      // wall-clock resolution, and "latest" is defined by index mtime.
      utimesSync(join(dir, 'index.jsonl'), mtime, mtime);
    };
    seed(oldId, 'old.txt', 'o1\n', 'o2\n', new Date('2026-01-01T00:00:00Z'));
    seed(newId, 'new.txt', 'n1\n', 'n2\n', new Date('2026-01-02T00:00:00Z'));
    return { root, sessionsRoot, oldId, newId };
  }

  it('bare diff falls back to the latest session journal and names it first', async () => {
    const { root, sessionsRoot, newId } = seedSessions();
    const lines: string[] = [];
    const code = await runJournalCommand(['diff'], {
      root,
      sessionsRoot,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines[0]).toBe(`session: ${newId}`);
    const text = lines.join('\n');
    expect(text).toContain('new.txt');
    expect(text).not.toContain('old.txt');
  });

  it('bare log and status read the fallback store too', async () => {
    const { root, sessionsRoot, newId } = seedSessions();
    const log: string[] = [];
    expect(
      await runJournalCommand(['log'], {
        root,
        sessionsRoot,
        out: (l) => log.push(l),
      }),
    ).toBe(0);
    expect(log[0]).toBe(`session: ${newId}`);
    expect(log.join('\n')).toContain('new.txt');
    const status: string[] = [];
    expect(
      await runJournalCommand(['status'], {
        root,
        sessionsRoot,
        out: (l) => status.push(l),
      }),
    ).toBe(0);
    expect(status[0]).toBe(`session: ${newId}`);
    expect(status.join('\n')).toContain('entries: 1');
  });

  it('--json keeps the parseable envelope and prints no session line', async () => {
    const { root, sessionsRoot } = seedSessions();
    const lines: string[] = [];
    const code = await runJournalCommand(['diff', '--json'], {
      root,
      sessionsRoot,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as Array<{ path: string }>;
    expect(parsed.map((c) => c.path)).toEqual(['new.txt']);
    expect(lines.some((l) => l.startsWith('session: '))).toBe(false);
  });

  it('a non-empty workspace store wins over newer session journals, with no session line', async () => {
    const { root, sessionsRoot } = seedSessions();
    new FileJournalStore(join(root, '.kubic', 'journal')).append({
      path: 'ws.txt',
      op: 'write',
      before: 'w1\n',
      after: 'w2\n',
      bytesDelta: 0,
      sessionId: 'ws1',
      agentId: 'root',
      toolCallId: 'call-9',
      timestamp: 1700000000000,
    });
    const lines: string[] = [];
    const code = await runJournalCommand(['diff'], {
      root,
      sessionsRoot,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith('session: '))).toBe(false);
    const text = lines.join('\n');
    expect(text).toContain('ws.txt');
    expect(text).not.toContain('new.txt');
  });

  it('explicit --session (id or journal:<id> ref) always wins over every default', async () => {
    const { root, sessionsRoot, oldId, newId } = seedSessions();
    // A workspace store too: --session must beat it and the fallback alike.
    new FileJournalStore(join(root, '.kubic', 'journal')).append({
      path: 'ws.txt',
      op: 'write',
      before: 'w1\n',
      after: 'w2\n',
      bytesDelta: 0,
      sessionId: 'ws1',
      agentId: 'root',
      toolCallId: 'call-9',
      timestamp: 1700000000000,
    });
    for (const [ref, want, other] of [
      [oldId, 'old.txt', 'new.txt'],
      [`journal:${oldId}`, 'old.txt', 'new.txt'],
      [newId, 'new.txt', 'old.txt'],
    ] as const) {
      const lines: string[] = [];
      expect(
        await runJournalCommand(['diff', '--session', ref], {
          root,
          sessionsRoot,
          out: (l) => lines.push(l),
        }),
      ).toBe(0);
      expect(lines.some((l) => l.startsWith('session: '))).toBe(false);
      const text = lines.join('\n');
      expect(text).toContain(want);
      expect(text).not.toContain(other);
      expect(text).not.toContain('ws.txt');
    }
  });

  it('undo --dry-run plans against the fallback store relative to the workspace root', async () => {
    const { root, sessionsRoot, newId } = seedSessions();
    // The journaled after-state is what sits in the workspace: the plan
    // must resolve the path against root, not the session's own cwd.
    writeFileSync(join(root, 'new.txt'), 'n2\n');
    const lines: string[] = [];
    const code = await runJournalCommand(['undo', '--dry-run'], {
      root,
      sessionsRoot,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines[0]).toBe(`session: ${newId}`);
    expect(lines.join('\n')).toContain('would restore 1 step(s)');
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('n2\n');
  });

  it('empty everywhere prints the nothing-anywhere hint and exits 0', async () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), 'sr-'));
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const lines: string[] = [];
    const code = await runJournalCommand(['diff'], {
      root,
      sessionsRoot,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      'no changes',
      `hint: no journal under ${join(root, '.kubic', 'journal')} and none under the sessions root (${sessionsRoot}) — start a run or pass --session`,
    ]);
    // --json stays one parseable envelope, hint included nowhere.
    const json: string[] = [];
    expect(
      await runJournalCommand(['diff', '--json'], {
        root,
        sessionsRoot,
        out: (l) => json.push(l),
      }),
    ).toBe(0);
    expect(json).toEqual(['[]']);
  });

  it('a missing sessions root is the same empty path, no throw', async () => {
    const sessionsRoot = join(mkdtempSync(join(tmpdir(), 'sr-')), 'absent');
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const lines: string[] = [];
    const code = await runJournalCommand(['diff'], {
      root,
      sessionsRoot,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      'no changes',
      `hint: no journal under ${join(root, '.kubic', 'journal')} and none under the sessions root (${sessionsRoot}) — start a run or pass --session`,
    ]);
  });
});

// Issue #117: a successful undo is journaled as a `kubic-undo` entry, so
// `diff`/`log` describe the world after the undo instead of the pre-undo
// world, and a second `undo --step` is the redo (undo the undo). A dry run
// appends nothing.
describe('journal CLI undo record + redo (issue #117)', () => {
  it('diff shows the undo as the latest change, attributed to kubic-undo', async () => {
    const { journalDir, root } = setup();
    expect(
      await runJournalCommand(['undo'], { journalDir, root, out: () => {} }),
    ).toBe(0);
    const lines: string[] = [];
    expect(
      await runJournalCommand(['diff'], {
        journalDir,
        root,
        out: (l) => lines.push(l),
      }),
    ).toBe(0);
    // The undo is the newest entry for the path, so its attribution is the
    // one the diff reports.
    expect(lines.join('\n')).toContain('agent=kubic-undo toolCall=none');
  });

  it('log prints the undo record with the kubic-undo attribution and no reconciled marker', async () => {
    const { journalDir, root } = setup();
    expect(
      await runJournalCommand(['undo'], { journalDir, root, out: () => {} }),
    ).toBe(0);
    const lines: string[] = [];
    expect(
      await runJournalCommand(['log'], {
        journalDir,
        root,
        out: (l) => lines.push(l),
      }),
    ).toBe(0);
    const undoLine = lines.find((l) => l.includes('kubic-undo'));
    expect(undoLine).toBeDefined();
    expect(undoLine ?? '').toContain('none write a.txt');
    // The undo is attributed — not an unattributed reconciliation find.
    expect(undoLine ?? '').not.toContain('reconciled');
  });

  it('redo: undo --step immediately after an undo restores the pre-undo content', async () => {
    const { journalDir, root } = setup();
    expect(
      await runJournalCommand(['undo'], { journalDir, root, out: () => {} }),
    ).toBe(0);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
    const lines: string[] = [];
    const code = await runJournalCommand(['undo', '--step'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('restored a.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('undo --dry-run appends no record', async () => {
    const { journalDir, root } = setup();
    expect(
      await runJournalCommand(['undo', '--dry-run'], {
        journalDir,
        root,
        out: () => {},
      }),
    ).toBe(0);
    const lines: string[] = [];
    expect(
      await runJournalCommand(['log'], {
        journalDir,
        root,
        out: (l) => lines.push(l),
      }),
    ).toBe(0);
    expect(lines.join('\n')).not.toContain('kubic-undo');
    expect(new FileJournalStore(journalDir).entries()).toHaveLength(1);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });
});
