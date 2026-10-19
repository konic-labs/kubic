// Read-time journal self-heal (AC "aged journal entries pruned
// on `kubic log --session <id>` when config sets retentionDays"): with
// `session.retentionDays` set, the log path prunes entries older than the
// window from a SESSION journal as it reads it; with retention off (unset or
// 0) the read path writes nothing. Driven through the real config seam
// (`loadCliConfig` + `sessionRetentionDays`), the same way sessions-prune
// is. Hermetic: tmp dirs only, zero network.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { FileJournalStore } from '@kubic/exec/journal';
import { runJournalCommand } from '@kubic/host/journal';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { loadCliConfig } from '../../src/config/load.js';
import { sessionRetentionDays } from '../../src/config/projections.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
  const home = tempDir('home-');
  mkdirSync(join(home, '.kubic'), { recursive: true });
  if (retention !== undefined) {
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      `[session]\nretentionDays = ${retention}\n`,
    );
  }
  const loaded = loadCliConfig({ home, cwd: tempDir('cwd-'), env: {} });
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
  const sessionsRoot = tempDir('sess-root-');
  const root = tempDir('ws-');
  const journalDir = join(sessionsRoot, 'sess-1', 'journal');
  seedAgedAndFresh(journalDir, 'sess-1');
  return { sessionsRoot, root, journalDir };
}

describe('read-time journal self-heal', () => {
  it('log --session prunes aged entries and keeps the fresh one when config sets retentionDays', async () => {
    const { sessionsRoot, root, journalDir } = seedCase();
    // Fixture sanity: both entries are on disk before the read.
    expect(indexLines(journalDir)).toHaveLength(2);

    const loaded = loadedWithRetention('7');
    const o = out();
    const code = (
      await runJournalCommand(
        { command: 'log', session: 'sess-1' },
        {
          root,
          sessionsRoot,
          retentionDays: sessionRetentionDays(loaded),
          out: o.write,
        },
      )
    ).exitCode;

    expect(code).toBe(0);
    const lines = indexLines(journalDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fresh.txt');
    const text = o.lines.join('\n');
    expect(text).toContain('fresh.txt');
    expect(text).not.toContain('aged.txt');
  });

  it('the latest-session fallback (no --session) self-heals the same way', async () => {
    const sessionsRoot = tempDir('sess-root-');
    const root = tempDir('ws-');
    // Older session: a fresh entry only.
    const oldDir = join(sessionsRoot, 'sess-old', 'journal');
    new FileJournalStore(oldDir).append({
      path: 'old.txt',
      op: 'write',
      before: 'o1\n',
      after: 'o2\n',
      bytesDelta: 0,
      sessionId: 'sess-old',
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
    const code = (
      await runJournalCommand(
        { command: 'log' },
        {
          root,
          sessionsRoot,
          // Both sessions were recorded for this workspace.
          sessionWorkspaces: async () =>
            new Map([
              ['sess-old', root],
              ['sess-new', root],
            ]),
          retentionDays: sessionRetentionDays(loaded),
          out: o.write,
        },
      )
    ).exitCode;

    expect(code).toBe(0);
    // No `err` channel given: the fallback note lands on `out`.
    expect(o.lines[0]).toBe(
      `info: session: sess-new (latest session journal for this workspace; also here: sess-old — pass --session <id> to pick another) — workspace ${root}`,
    );
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
    const code = (
      await runJournalCommand(
        { command: 'log', session: 'sess-1' },
        {
          root,
          sessionsRoot,
          out: o.write,
        },
      )
    ).exitCode;

    expect(code).toBe(0);
    expect(treeSnapshot(journalDir)).toBe(before);
    expect(indexLines(journalDir)).toHaveLength(2);
    expect(o.lines.join('\n')).toContain('aged.txt');
  });

  it('a refused config leaves no window either: log --session never writes', async () => {
    // A typo refuses the whole load, so the read path has no window —
    // exactly like the unset case — and writes nothing.
    const { sessionsRoot, root, journalDir } = seedCase();
    const before = treeSnapshot(journalDir);
    const home = tempDir('home-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[session]\nretentionDays = 30\n[nope]\nkey = 1\n',
    );
    const loaded = loadCliConfig({ home, cwd: tempDir('cwd-'), env: {} });
    expect(loaded.runtime).toBeUndefined();
    expect(loaded.error).toContain('nope');
    expect(sessionRetentionDays(loaded)).toBeUndefined();

    const o = out();
    const code = (
      await runJournalCommand(
        { command: 'log', session: 'sess-1' },
        {
          root,
          sessionsRoot,
          out: o.write,
        },
      )
    ).exitCode;

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
    const code = (
      await runJournalCommand(
        { command: 'log', session: 'sess-1' },
        {
          root,
          sessionsRoot,
          retentionDays: sessionRetentionDays(loaded),
          out: o.write,
        },
      )
    ).exitCode;

    expect(code).toBe(0);
    expect(treeSnapshot(journalDir)).toBe(before);
    expect(indexLines(journalDir)).toHaveLength(2);
    expect(o.lines.join('\n')).toContain('aged.txt');
  });

  it('session retention never prunes a pinned store (session-scoped only)', async () => {
    const journalDir = tempDir('j-');
    const root = tempDir('ws-');
    seedAgedAndFresh(journalDir, 'ws');
    const before = treeSnapshot(journalDir);
    const loaded = loadedWithRetention('7');

    const o = out();
    const code = (
      await runJournalCommand(
        { command: 'log' },
        {
          journalDir,
          root,
          retentionDays: sessionRetentionDays(loaded),
          out: o.write,
        },
      )
    ).exitCode;

    expect(code).toBe(0);
    expect(treeSnapshot(journalDir)).toBe(before);
    expect(indexLines(journalDir)).toHaveLength(2);
  });

  it('an unknown session is refused without a write, and invalid ids stay refused', async () => {
    const sessionsRoot = tempDir('sess-root-');
    const root = tempDir('ws-');
    const loaded = loadedWithRetention('7');

    const o = out();
    const code = (
      await runJournalCommand(
        { command: 'log', session: 'ghost' },
        {
          root,
          sessionsRoot,
          retentionDays: sessionRetentionDays(loaded),
          out: o.write,
        },
      )
    ).exitCode;
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toContain('unknown session: ghost');
    // Refused before any store is opened: nothing is written, not the dir.
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
