// Read-time journal self-heal (issue #119, AC "aged journal entries pruned
// on `kubic log --session <id>` when config sets retentionDays"): with
// `session.retentionDays` set, the log path prunes entries older than the
// window from a SESSION journal as it reads it; with retention off (unset or
// 0) the read path writes nothing. Driven through the real config seam
// (`loadCliConfig` + `sessionRetentionDays`), the same way sessions-prune
// is. Hermetic: tmp dirs only, zero network.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadCliConfig,
  sessionRetentionDays,
} from '../../../apps/kubic/src/config-runtime.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import { runJournalCommand } from './journal-cli.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

// A home whose global layer sets `[session] retentionDays` (or nothing when
// `retention` is undefined), loaded through the composition root's config
// seam — the same load `main.ts` hands the journal dispatch.
function loadedWithRetention(
  retention?: string,
): ReturnType<typeof loadCliConfig> {
  const home = tmpRoot('home-');
  mkdirSync(join(home, '.kubic'), { recursive: true });
  if (retention !== undefined) {
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      `[session]\nretentionDays = ${retention}\n`,
    );
  }
  const loaded = loadCliConfig({ home, cwd: tmpRoot('cwd-'), env: {} });
  expect(loaded.error).toBeUndefined();
  return loaded;
}

// One aged entry (30 days back — older than every window these tests set)
// plus one fresh entry: the two fates the self-heal must tell apart.
function seedAgedAndFresh(journalDir: string, sessionId: string): void {
  const store = new FileJournalStore(journalDir);
  store.append({
    path: 'aged.txt',
    op: 'write',
    before: 'old\n',
    after: 'older\n',
    bytesDelta: 0,
    sessionId,
    agentId: 'root',
    toolCallId: 'call-aged',
    timestamp: Date.now() - 30 * DAY_MS,
  });
  store.append({
    path: 'fresh.txt',
    op: 'write',
    before: 'new\n',
    after: 'newer\n',
    bytesDelta: 0,
    sessionId,
    agentId: 'root',
    toolCallId: 'call-fresh',
    timestamp: Date.now(),
  });
}

function indexPath(journalDir: string): string {
  return join(journalDir, 'index.jsonl');
}

function indexLines(journalDir: string): string[] {
  return readFileSync(indexPath(journalDir), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

// Every file under `dir` with size, mtime and content: the read-only pin —
// an index rewrite, a leftover tmp file, or a blob sweep all show up as a
// diff against the pre-read snapshot.
function treeSnapshot(dir: string): string {
  const rows: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel === '' ? dir : join(dir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = join(dir, childRel);
      if (entry.isDirectory()) {
        walk(childRel);
      } else {
        const st = statSync(childAbs);
        rows.push(
          `${childRel} ${st.size} ${st.mtimeMs} ${readFileSync(childAbs, 'utf8')}`,
        );
      }
    }
  };
  walk('');
  return rows.sort().join('\n');
}

function seedCase(): {
  sessionsRoot: string;
  root: string;
  journalDir: string;
} {
  const sessionsRoot = tmpRoot('sess-root-');
  const root = tmpRoot('ws-');
  const journalDir = join(sessionsRoot, 'sess-1', 'journal');
  seedAgedAndFresh(journalDir, 'sess-1');
  return { sessionsRoot, root, journalDir };
}

describe('read-time journal self-heal (issue #119)', () => {
  it('log --session prunes aged entries and keeps the fresh one when config sets retentionDays', async () => {
    const { sessionsRoot, root, journalDir } = seedCase();
    // Fixture sanity: both entries are on disk before the read.
    expect(indexLines(journalDir)).toHaveLength(2);

    const loaded = loadedWithRetention('7');
    const o = out();
    const code = await runJournalCommand(
      { command: 'log', session: 'sess-1' },
      {
        root,
        sessionsRoot,
        retentionDays: sessionRetentionDays(loaded),
        out: o.write,
      },
    );

    expect(code).toBe(0);
    const lines = indexLines(journalDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fresh.txt');
    const text = o.lines.join('\n');
    expect(text).toContain('fresh.txt');
    expect(text).not.toContain('aged.txt');
  });

  it('the latest-session fallback (no --session) self-heals the same way', async () => {
    const sessionsRoot = tmpRoot('sess-root-');
    const root = tmpRoot('ws-');
    // Older session: a fresh entry only.
    const oldDir = join(sessionsRoot, 'sess-old', 'journal');
    new FileJournalStore(oldDir).append({
      path: 'old.txt',
      op: 'write',
      before: 'o1\n',
      after: 'o2\n',
      bytesDelta: 0,
      sessionId: 'sess-old',
      agentId: 'root',
      toolCallId: 'call-old',
      timestamp: Date.now(),
    });
    // Newer session: aged + fresh. Ordering pinned by index mtime (append
    // order can tie at wall-clock resolution).
    const newDir = join(sessionsRoot, 'sess-new', 'journal');
    seedAgedAndFresh(newDir, 'sess-new');
    utimesSync(
      indexPath(oldDir),
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
    );
    utimesSync(
      indexPath(newDir),
      new Date('2026-01-02T00:00:00Z'),
      new Date('2026-01-02T00:00:00Z'),
    );

    const loaded = loadedWithRetention('7');
    const o = out();
    const code = await runJournalCommand(
      { command: 'log' },
      {
        root,
        sessionsRoot,
        retentionDays: sessionRetentionDays(loaded),
        out: o.write,
      },
    );

    expect(code).toBe(0);
    // No `err` channel given: the fallback note lands on `out`.
    expect(o.lines[0]).toBe('info: session: sess-new (latest session journal)');
    const healed = indexLines(newDir);
    expect(healed).toHaveLength(1);
    expect(healed[0]).toContain('fresh.txt');
    // The other session's store is untouched: the heal is scoped to the
    // store this read resolved.
    const untouched = indexLines(oldDir);
    expect(untouched).toHaveLength(1);
    expect(untouched[0]).toContain('old.txt');
  });

  it('with retention unset, log --session never writes (read is not a mutation)', async () => {
    const { sessionsRoot, root, journalDir } = seedCase();
    const before = treeSnapshot(journalDir);
    const loaded = loadedWithRetention();
    expect(sessionRetentionDays(loaded)).toBeUndefined();

    const o = out();
    const code = await runJournalCommand(
      { command: 'log', session: 'sess-1' },
      {
        root,
        sessionsRoot,
        out: o.write,
      },
    );

    expect(code).toBe(0);
    expect(treeSnapshot(journalDir)).toBe(before);
    expect(indexLines(journalDir)).toHaveLength(2);
    expect(o.lines.join('\n')).toContain('aged.txt');
  });

  it('with retentionDays = 0 (retention off), log --session never writes either', async () => {
    const { sessionsRoot, root, journalDir } = seedCase();
    const before = treeSnapshot(journalDir);
    const loaded = loadedWithRetention('0');
    expect(sessionRetentionDays(loaded)).toBe(0);

    const o = out();
    const code = await runJournalCommand(
      { command: 'log', session: 'sess-1' },
      {
        root,
        sessionsRoot,
        retentionDays: sessionRetentionDays(loaded),
        out: o.write,
      },
    );

    expect(code).toBe(0);
    expect(treeSnapshot(journalDir)).toBe(before);
    expect(indexLines(journalDir)).toHaveLength(2);
    expect(o.lines.join('\n')).toContain('aged.txt');
  });

  it('session retention never prunes a pinned workspace store (session-scoped only)', async () => {
    const journalDir = tmpRoot('j-');
    const root = tmpRoot('ws-');
    seedAgedAndFresh(journalDir, 'ws');
    const before = treeSnapshot(journalDir);
    const loaded = loadedWithRetention('7');

    const o = out();
    const code = await runJournalCommand(
      { command: 'log' },
      {
        journalDir,
        root,
        retentionDays: sessionRetentionDays(loaded),
        out: o.write,
      },
    );

    expect(code).toBe(0);
    expect(treeSnapshot(journalDir)).toBe(before);
    expect(indexLines(journalDir)).toHaveLength(2);
  });

  it('a missing session journal stays a pure read and invalid ids stay refused', async () => {
    const sessionsRoot = tmpRoot('sess-root-');
    const root = tmpRoot('ws-');
    const loaded = loadedWithRetention('7');

    const o = out();
    const code = await runJournalCommand(
      { command: 'log', session: 'ghost' },
      {
        root,
        sessionsRoot,
        retentionDays: sessionRetentionDays(loaded),
        out: o.write,
      },
    );
    expect(code).toBe(0);
    expect(o.lines).toContain('journal is empty');
    // Enforcement on a store with no index writes nothing — not even the dir.
    expect(existsSync(join(sessionsRoot, 'ghost'))).toBe(false);

    const bad = out();
    await expect(
      runJournalCommand(
        { command: 'log', session: '../evil' },
        {
          root,
          sessionsRoot,
          retentionDays: sessionRetentionDays(loaded),
          out: bad.write,
        },
      ),
    ).rejects.toThrow(/invalid --session/);
    expect(bad.lines).toEqual([]);
    // The rejected join could only have escaped here: prove it never did.
    expect(existsSync(join(sessionsRoot, '..', 'evil'))).toBe(false);
  });
});
