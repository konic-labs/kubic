// Slice D: `kubic diff / undo / log / status` CLI (issue #18; §42.2, §78).
// RED: runJournalCommand does not exist yet.
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileJournalStore } from '../../exec/src/journal.js';
import { runJournalCommand } from './journal-cli.js';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup(): {
  journalDir: string;
  root: string;
  out: { lines: string[]; write: (line: string) => void };
} {
  const journalDir = mkTmp('j-');
  const root = mkTmp('ws-');
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
    const journalDir = mkTmp('j-');
    const root = mkTmp('ws-');
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
    const journalDir = mkTmp('j-');
    const root = mkTmp('ws-');
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
    const sessionsRoot = mkTmp('sr-');
    const root = mkTmp('ws-');
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
    const sessionsRoot = mkTmp('sr-');
    const root = mkTmp('ws-');
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
    const sessionsRoot = join(mkTmp('sr-'), 'absent');
    const root = mkTmp('ws-');
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

  it('plain undo twice is idempotent: the second run reports already-undone and appends nothing', async () => {
    const { journalDir, root } = setup();
    expect(
      await runJournalCommand(['undo'], { journalDir, root, out: () => {} }),
    ).toBe(0);
    const second: string[] = [];
    // Already-undone skips exit 2 (main's semantics) — and write nothing.
    expect(
      await runJournalCommand(['undo'], {
        journalDir,
        root,
        out: (l) => second.push(l),
      }),
    ).toBe(2);
    expect(second.join('\n')).toContain('already undone (skipped): a.txt');
    expect(second.join('\n')).not.toContain('restored a.txt');
    expect(new FileJournalStore(journalDir).entries()).toHaveLength(2);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
  });
});

// Issue #126: the status repo line follows a linked worktree's `gitdir:`
// pointer — the trees `kubic orchestrate` creates and retains must not
// report `(detached)` (or a non-repo) for a live branch.
describe('journal CLI worktree status (issue #126)', () => {
  it('status names the worktree branch from the gitdir pointer', async () => {
    const journalDir = mkTmp('j-');
    const root = mkTmp('wt-');
    const gitdir = mkTmp('gd-');
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/wt-feature\n');
    writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`);
    const lines: string[] = [];
    const code = await runJournalCommand(['status'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('repo: branch wt-feature');
  });
});

// Issue #126: `diff --json` carries full before/after strings, so a session
// that edited a few large files is a multi-megabyte single line with no
// bound and no truncation marker. Default: clip each side at 64 KiB with
// `contentTruncated: true` and a named marker line; `--max-content-bytes 0`
// is the explicit-unlimited escape hatch for scripting. The human diff
// renders hunks, not whole files, and is never clipped.
describe('journal CLI diff --json content bounds (issue #126)', () => {
  const LIMIT = 64 * 1024;
  const MARKER = (bytes: number): string =>
    `\n[kubic: content truncated at ${bytes} bytes]`;

  function seedBig(bytes = 70 * 1024): {
    journalDir: string;
    root: string;
    before: string;
    after: string;
  } {
    const journalDir = mkTmp('j-');
    const root = mkTmp('ws-');
    const before = `${'a'.repeat(bytes)}\n`;
    const after = `${'b'.repeat(bytes)}\n`;
    new FileJournalStore(journalDir).append({
      path: 'big.txt',
      op: 'write',
      before,
      after,
      bytesDelta: 0,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });
    return { journalDir, root, before, after };
  }

  interface JsonChange {
    path: string;
    before: string | null;
    after: string | null;
    contentTruncated?: boolean;
  }

  async function jsonDiff(
    args: string[],
    deps: { journalDir: string; root: string },
  ): Promise<JsonChange[]> {
    const lines: string[] = [];
    const code = await runJournalCommand(['diff', '--json', ...args], {
      ...deps,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    return JSON.parse(lines.join('\n')) as JsonChange[];
  }

  it('clips both sides at exactly 64 KiB by default, with marker and flag', async () => {
    const { journalDir, root, before, after } = seedBig();
    const parsed = await jsonDiff([], { journalDir, root });
    const change = parsed[0];
    expect(change?.contentTruncated).toBe(true);
    const marker = MARKER(LIMIT);
    expect(change?.before?.endsWith(marker)).toBe(true);
    expect(change?.after?.endsWith(marker)).toBe(true);
    const beforePayload = (change?.before ?? '').slice(0, -marker.length);
    const afterPayload = (change?.after ?? '').slice(0, -marker.length);
    expect(Buffer.byteLength(beforePayload, 'utf8')).toBe(LIMIT);
    expect(Buffer.byteLength(afterPayload, 'utf8')).toBe(LIMIT);
    expect(before.startsWith(beforePayload)).toBe(true);
    expect(after.startsWith(afterPayload)).toBe(true);
  });

  it('--max-content-bytes 0 returns the full content byte-identically', async () => {
    const { journalDir, root, before, after } = seedBig();
    const parsed = await jsonDiff(['--max-content-bytes', '0'], {
      journalDir,
      root,
    });
    expect(parsed[0]?.before).toBe(before);
    expect(parsed[0]?.after).toBe(after);
    expect(parsed[0]?.contentTruncated).toBe(false);
  });

  it('--max-content-bytes <n> honors a custom bound', async () => {
    const { journalDir, root } = seedBig();
    const parsed = await jsonDiff(['--max-content-bytes', '100'], {
      journalDir,
      root,
    });
    const marker = MARKER(100);
    expect(parsed[0]?.contentTruncated).toBe(true);
    expect(parsed[0]?.before?.endsWith(marker)).toBe(true);
    expect(
      Buffer.byteLength(
        (parsed[0]?.before ?? '').slice(0, -marker.length),
        'utf8',
      ),
    ).toBe(100);
  });

  it('small content is untouched and contentTruncated is false', async () => {
    const { journalDir, root } = setup();
    const parsed = await jsonDiff([], { journalDir, root });
    expect(parsed[0]?.before).toBe('v1\n');
    expect(parsed[0]?.after).toBe('v2\n');
    expect(parsed[0]?.contentTruncated).toBe(false);
  });

  it('the human diff is never clipped', async () => {
    const { journalDir, root, before, after } = seedBig();
    const lines: string[] = [];
    const code = await runJournalCommand(['diff'], {
      journalDir,
      root,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain(`-${before.split('\n')[0] ?? ''}`);
    expect(text).toContain(`+${after.split('\n')[0] ?? ''}`);
    expect(text).not.toContain('[kubic: content truncated');
  });

  it('a missing or malformed bound exits 1 with a named error', async () => {
    const { journalDir, root } = setup();
    for (const args of [
      ['--max-content-bytes'],
      ['--max-content-bytes', 'nope'],
      ['--max-content-bytes', '-1'],
    ]) {
      const lines: string[] = [];
      expect(
        await runJournalCommand(['diff', '--json', ...args], {
          journalDir,
          root,
          out: (l) => lines.push(l),
        }),
      ).toBe(1);
      expect(lines.join('\n')).toContain('--max-content-bytes');
    }
  });
});

// --json is one contract across the journal subcommands: every line a
// subcommand prints under --json joins to exactly one valid JSON document.
describe('journal CLI --json parity', () => {
  async function runJson(
    args: string[],
    deps: { journalDir: string; root: string },
  ): Promise<{ code: number; doc: unknown }> {
    const lines: string[] = [];
    const code = await runJournalCommand(args, {
      ...deps,
      out: (l: string) => lines.push(l),
    });
    return { code, doc: JSON.parse(lines.join('\n')) };
  }

  it('status --json prints a JSON object', async () => {
    const { journalDir, root } = setup();
    const { code, doc } = await runJson(['status', '--json'], {
      journalDir,
      root,
    });
    expect(code).toBe(0);
    expect(doc).toMatchObject({ entries: 1, reversible: 1, nonReversible: 0 });
  });

  it('undo --json prints restored/skipped as JSON, keeping the exit code', async () => {
    const { journalDir, root } = setup();
    const dry = await runJson(['undo', '--dry-run', '--json'], {
      journalDir,
      root,
    });
    expect(dry.doc).toMatchObject({ dryRun: true, restored: ['a.txt'] });
    const real = await runJson(['undo', '--json', 'a.txt'], {
      journalDir,
      root,
    });
    expect(real.code).toBe(0);
    expect(real.doc).toMatchObject({ restored: ['a.txt'], skipped: [] });
    const again = await runJson(['undo', '--json'], { journalDir, root });
    expect(again.code).toBe(2);
    expect(again.doc).toMatchObject({
      restored: [],
      skipped: [{ path: 'a.txt', kind: 'already-undone' }],
    });
  });

  it('undo --json with nothing to undo is still JSON', async () => {
    const { journalDir, root } = setup();
    const { doc } = await runJson(['undo', '--json', 'nope.txt'], {
      journalDir,
      root,
    });
    expect(doc).toMatchObject({ restored: [], skipped: [] });
  });

  it('diff and log --json on an empty journal are JSON arrays', async () => {
    const root = mkTmp('ws-');
    const journalDir = mkTmp('j-');
    expect(
      (await runJson(['diff', '--json'], { journalDir, root })).doc,
    ).toEqual([]);
    expect(
      (await runJson(['log', '--json'], { journalDir, root })).doc,
    ).toEqual([]);
  });
});
