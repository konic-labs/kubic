// `kubic journal prune`: the explicit deleter of the journal `kubic log`
// reads. A dry run lists the entries older than the keep window and deletes
// nothing; `--yes` deletes them. The window comes from --keep-days or
// `journal.retentionDays` (never invented), 0 turns retention off, and a
// session attached to a live run is refused. Driven through the real config
// seam (`loadCliConfig` + `journalRetentionDays`). Hermetic: tmp dirs only,
// zero network.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliUsageError } from '../../../packages/core/src/cli/exit-codes.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import { runJournalCommand } from '../../../packages/host/src/journal-cli.js';
import { journalRetentionDays, loadCliConfig } from './config-runtime.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function channel(): {
  lines: string[];
  errs: string[];
  out: (line: string) => void;
  err: (line: string) => void;
} {
  const lines: string[] = [];
  const errs: string[] = [];
  return {
    lines,
    errs,
    out: (line: string) => lines.push(line),
    err: (line: string) => errs.push(line),
  };
}

// A home whose global layer sets `[journal] retentionDays` (or nothing when
// `retention` is undefined), loaded through the composition root's config seam.
function loadedWithJournalRetention(
  retention?: string,
): ReturnType<typeof loadCliConfig> {
  const home = tmpRoot('home-');
  mkdirSync(join(home, '.kubic'), { recursive: true });
  if (retention !== undefined) {
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      `[journal]\nretentionDays = ${retention}\n`,
    );
  }
  const loaded = loadCliConfig({ home, cwd: tmpRoot('cwd-'), env: {} });
  expect(loaded.error).toBeUndefined();
  return loaded;
}

// One entry 30 days old and one fresh: the two fates a 7-day window must
// tell apart.
function seed(journalDir: string, sessionId: string): void {
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

function indexLines(journalDir: string): string[] {
  return readFileSync(join(journalDir, 'index.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function seededSession(): {
  sessionsRoot: string;
  root: string;
  journalDir: string;
} {
  const sessionsRoot = tmpRoot('sess-root-');
  const root = tmpRoot('ws-');
  const journalDir = join(sessionsRoot, 'sess-1', 'journal');
  seed(journalDir, 'sess-1');
  return { sessionsRoot, root, journalDir };
}

describe('journal prune', () => {
  it('lists the aged entry and deletes nothing without --yes', async () => {
    const { sessionsRoot, root, journalDir } = seededSession();
    const before = indexLines(journalDir);
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', keepDays: 7 },
      { root, sessionsRoot, out: c.out, err: c.err },
    );
    expect(code).toBe(0);
    expect(indexLines(journalDir)).toEqual(before);
    const text = c.lines.join('\n');
    expect(text).toContain('would prune');
    expect(text).toContain('aged.txt');
    expect(text).not.toContain('fresh.txt');
    expect(text).toContain(
      'dry run: 1 entry would be pruned (keep window 7 day(s)) — pass --yes to delete',
    );
  });

  it('--yes deletes the aged entry, keeps the fresh one, and reports the count', async () => {
    const { sessionsRoot, root, journalDir } = seededSession();
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', keepDays: 7, yes: true },
      { root, sessionsRoot, out: c.out, err: c.err },
    );
    expect(code).toBe(0);
    const lines = indexLines(journalDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fresh.txt');
    expect(c.lines.join('\n')).toMatch(/pruned 1 entry, \d+B reclaimed/);
  });

  it('takes the keep window from journal.retentionDays when --keep-days is absent', async () => {
    const { sessionsRoot, root, journalDir } = seededSession();
    const loaded = loadedWithJournalRetention('7');
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', yes: true },
      {
        root,
        sessionsRoot,
        journalRetentionDays: journalRetentionDays(loaded),
        out: c.out,
        err: c.err,
      },
    );
    expect(code).toBe(0);
    const lines = indexLines(journalDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fresh.txt');
  });

  it('refuses without a keep window (no flag, no config): exit 1, nothing changed', async () => {
    const { sessionsRoot, root, journalDir } = seededSession();
    const before = indexLines(journalDir);
    const loaded = loadedWithJournalRetention(undefined);
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', yes: true },
      {
        root,
        sessionsRoot,
        journalRetentionDays: journalRetentionDays(loaded),
        out: c.out,
        err: c.err,
      },
    );
    expect(code).toBe(1);
    expect(c.errs.join('\n')).toContain('journal prune needs a keep window');
    expect(indexLines(journalDir)).toEqual(before);
  });

  it('keep-days 0 turns retention off: nothing is listed or deleted', async () => {
    const { sessionsRoot, root, journalDir } = seededSession();
    const before = indexLines(journalDir);
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', keepDays: 0, yes: true },
      { root, sessionsRoot, out: c.out, err: c.err },
    );
    expect(code).toBe(0);
    expect(c.lines.join('\n')).toContain(
      'journal retention is off (keep-days 0) — nothing is pruned',
    );
    expect(indexLines(journalDir)).toEqual(before);
  });

  it('refuses a session attached to a live run (exit 1), touching nothing', async () => {
    const { sessionsRoot, root, journalDir } = seededSession();
    const before = indexLines(journalDir);
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', keepDays: 7, yes: true },
      {
        root,
        sessionsRoot,
        sessionLockHolder: () => ({ pid: 4242 }),
        out: c.out,
        err: c.err,
      },
    );
    expect(code).toBe(1);
    expect(c.errs.join('\n')).toContain(
      "session 'sess-1' is attached by pid 4242 — refusing to prune under a live run",
    );
    expect(indexLines(journalDir)).toEqual(before);
  });

  it('reports nothing to prune when every entry is inside the window', async () => {
    const { sessionsRoot, root, journalDir } = seededSession();
    const before = indexLines(journalDir);
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', keepDays: 60, yes: true },
      { root, sessionsRoot, out: c.out, err: c.err },
    );
    expect(code).toBe(0);
    expect(c.lines).toEqual(['nothing to prune']);
    expect(indexLines(journalDir)).toEqual(before);
  });

  it('prunes a workspace store named by journalDir, with no session lock to check', async () => {
    const root = tmpRoot('ws-');
    const journalDir = join(root, '.kubic', 'journal');
    seed(journalDir, 'ws-session');
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', keepDays: 7, yes: true },
      {
        root,
        journalDir,
        sessionLockHolder: () => ({ pid: 1 }),
        out: c.out,
        err: c.err,
      },
    );
    expect(code).toBe(0);
    const lines = indexLines(journalDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fresh.txt');
  });

  it('--json prints one document: the candidates on a dry run, the pruned count after --yes', async () => {
    const { sessionsRoot, root } = seededSession();
    const dry = channel();
    expect(
      await runJournalCommand(
        { command: 'prune', session: 'sess-1', keepDays: 7, json: true },
        { root, sessionsRoot, out: dry.out, err: dry.err },
      ),
    ).toBe(0);
    expect(dry.errs).toEqual([]);
    const dryDoc = JSON.parse(dry.lines.join('\n')) as {
      dryRun: boolean;
      pruned: number;
      candidates: { path: string }[];
    };
    expect(dryDoc.dryRun).toBe(true);
    expect(dryDoc.pruned).toBe(0);
    expect(dryDoc.candidates.map((candidate) => candidate.path)).toEqual([
      'aged.txt',
    ]);

    const done = channel();
    expect(
      await runJournalCommand(
        {
          command: 'prune',
          session: 'sess-1',
          keepDays: 7,
          yes: true,
          json: true,
        },
        { root, sessionsRoot, out: done.out, err: done.err },
      ),
    ).toBe(0);
    const doneDoc = JSON.parse(done.lines.join('\n')) as {
      dryRun: boolean;
      pruned: number;
    };
    expect(doneDoc).toMatchObject({ dryRun: false, pruned: 1 });
  });
});

describe('journal prune: the keep window resolves like the runtime', () => {
  it('KUBIC_JOURNAL_RETENTION_DAYS sets the window when no flag or file key does', async () => {
    const { sessionsRoot, root, journalDir } = seededSession();
    const loaded = loadCliConfig({
      home: tmpRoot('home-'),
      cwd: tmpRoot('cwd-'),
      env: { KUBIC_JOURNAL_RETENTION_DAYS: '7' },
    });
    expect(loaded.error).toBeUndefined();
    expect(journalRetentionDays(loaded)).toBe(7);
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', yes: true },
      {
        root,
        sessionsRoot,
        journalRetentionDays: journalRetentionDays(loaded),
        out: c.out,
        err: c.err,
      },
    );
    expect(code).toBe(0);
    const lines = indexLines(journalDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fresh.txt');
  });

  it('the env value beats the file key, and a flag beats both', async () => {
    const home = tmpRoot('home-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[journal]\nretentionDays = 30\n',
    );
    const loaded = loadCliConfig({
      home,
      cwd: tmpRoot('cwd-'),
      env: { KUBIC_JOURNAL_RETENTION_DAYS: '7' },
    });
    expect(journalRetentionDays(loaded)).toBe(7);
    const { sessionsRoot, root, journalDir } = seededSession();
    const deps = {
      root,
      sessionsRoot,
      journalRetentionDays: journalRetentionDays(loaded),
    };
    // A 60-day flag keeps the 30-day-old entry, whatever the env says.
    const flagged = channel();
    expect(
      await runJournalCommand(
        { command: 'prune', session: 'sess-1', keepDays: 60, yes: true },
        { ...deps, out: flagged.out, err: flagged.err },
      ),
    ).toBe(0);
    expect(indexLines(journalDir)).toHaveLength(2);
    // With no flag, the env window (7 days) is the one that prunes.
    const envWindow = channel();
    expect(
      await runJournalCommand(
        { command: 'prune', session: 'sess-1', yes: true },
        { ...deps, out: envWindow.out, err: envWindow.err },
      ),
    ).toBe(0);
    expect(indexLines(journalDir)).toHaveLength(1);
  });

  it('a keep window that is not a non-negative integer is a usage error', async () => {
    const { sessionsRoot, root } = seededSession();
    for (const keepDays of [-1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(
        runJournalCommand(
          { command: 'prune', session: 'sess-1', keepDays },
          { root, sessionsRoot, out: () => {} },
        ),
      ).rejects.toBeInstanceOf(CliUsageError);
    }
    // A configured value gets the same check: the config parser accepts 0.5.
    await expect(
      runJournalCommand(
        { command: 'prune', session: 'sess-1' },
        { root, sessionsRoot, journalRetentionDays: 0.5, out: () => {} },
      ),
    ).rejects.toBeInstanceOf(CliUsageError);
  });

  it('a refused config is named in the no-window refusal', async () => {
    const home = tmpRoot('home-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[journal]\nretentionDays = "seven"\n',
    );
    const loaded = loadCliConfig({ home, cwd: tmpRoot('cwd-'), env: {} });
    expect(loaded.error).toBeDefined();
    const { sessionsRoot, root, journalDir } = seededSession();
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', yes: true },
      {
        root,
        sessionsRoot,
        journalRetentionDays: journalRetentionDays(loaded),
        journalConfigError: loaded.error,
        out: c.out,
        err: c.err,
      },
    );
    expect(code).toBe(1);
    const text = c.errs.join('\n');
    expect(text).toContain('set [journal] retentionDays');
    expect(text).toContain(`the config did not load: ${loaded.error}`);
    expect(indexLines(journalDir)).toHaveLength(2);
  });
});

describe('journal prune: refusals come before any deletion', () => {
  it('an unknown --session is refused like cost --session (exit 1), creating nothing', async () => {
    const sessionsRoot = tmpRoot('sess-root-');
    const root = tmpRoot('ws-');
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'nope', keepDays: 7, yes: true },
      { root, sessionsRoot, out: c.out, err: c.err },
    );
    expect(code).toBe(1);
    expect(c.errs.join('\n')).toContain('unknown session: nope');
    expect(c.lines).toEqual([]);
    expect(existsSync(join(sessionsRoot, 'nope'))).toBe(false);
  });

  it('a live run is refused first: on a dry run, for every window, and with no window at all', async () => {
    const { sessionsRoot, root, journalDir } = seededSession();
    const before = indexLines(journalDir);
    for (const keepDays of [7, 0, undefined]) {
      const c = channel();
      const code = await runJournalCommand(
        {
          command: 'prune',
          session: 'sess-1',
          ...(keepDays === undefined ? {} : { keepDays }),
        },
        {
          root,
          sessionsRoot,
          sessionLockHolder: () => ({ pid: 4242 }),
          out: c.out,
          err: c.err,
        },
      );
      expect(code, String(keepDays)).toBe(1);
      expect(c.errs.join('\n'), String(keepDays)).toContain(
        "session 'sess-1' is attached by pid 4242 — refusing to prune under a live run",
      );
    }
    expect(indexLines(journalDir)).toEqual(before);
  });
});

describe('journal prune reports what the pass actually removed', () => {
  // Two aged entries (30 and 31 days old) and one fresh entry.
  function seedTwoAged(journalDir: string): void {
    const store = new FileJournalStore(journalDir);
    const rows: readonly [string, number][] = [
      ['aged-1.txt', 30],
      ['aged-2.txt', 31],
      ['fresh.txt', 0],
    ];
    for (const [path, ageDays] of rows) {
      store.append({
        path,
        op: 'write',
        before: 'a\n',
        after: 'b\n',
        bytesDelta: 0,
        sessionId: 'sess-1',
        agentId: 'root',
        toolCallId: `call-${path}`,
        timestamp: Date.now() - ageDays * DAY_MS,
      });
    }
  }

  // A concurrent pruner removes aged-1 after this command listed the entries
  // and before the pass runs; the real pass then removes what is left.
  function concurrentPrunerRemovesFirst(journalDir: string): void {
    const original = FileJournalStore.prototype.enforceRetention;
    vi.spyOn(FileJournalStore.prototype, 'enforceRetention').mockImplementation(
      function (this: FileJournalStore, policy) {
        const kept = indexLines(journalDir).filter(
          (line) => !line.includes('aged-1.txt'),
        );
        writeFileSync(join(journalDir, 'index.jsonl'), `${kept.join('\n')}\n`);
        return original.call(this, policy);
      },
    );
  }

  it('reports the actual count and succeeds when fewer entries were removed than listed', async () => {
    const sessionsRoot = tmpRoot('sess-root-');
    const root = tmpRoot('ws-');
    const journalDir = join(sessionsRoot, 'sess-1', 'journal');
    seedTwoAged(journalDir);
    concurrentPrunerRemovesFirst(journalDir);
    const c = channel();
    const code = await runJournalCommand(
      { command: 'prune', session: 'sess-1', keepDays: 7, yes: true },
      { root, sessionsRoot, out: c.out, err: c.err },
    );
    expect(code).toBe(0);
    // The session note (an info line on stderr) is expected; no error is.
    expect(c.errs.join('\n')).not.toMatch(/^error:/m);
    expect(c.lines.join('\n')).toMatch(
      /^pruned 1 entry, \d+B reclaimed \(2 listed: the journal changed while pruning\)$/m,
    );
    const lines = indexLines(journalDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fresh.txt');
  });

  it('--json carries the actual pruned count next to the listed candidates', async () => {
    const sessionsRoot = tmpRoot('sess-root-');
    const root = tmpRoot('ws-');
    const journalDir = join(sessionsRoot, 'sess-1', 'journal');
    seedTwoAged(journalDir);
    concurrentPrunerRemovesFirst(journalDir);
    const c = channel();
    const code = await runJournalCommand(
      {
        command: 'prune',
        session: 'sess-1',
        keepDays: 7,
        yes: true,
        json: true,
      },
      { root, sessionsRoot, out: c.out, err: c.err },
    );
    expect(code).toBe(0);
    const doc = JSON.parse(c.lines.join('\n')) as {
      dryRun: boolean;
      pruned: number;
      candidates: unknown[];
    };
    expect(doc).toMatchObject({ dryRun: false, pruned: 1 });
    expect(doc.candidates).toHaveLength(2);
  });

  it('a pass that removes nothing fails (exit 1) and says so, in text and JSON', async () => {
    const sessionsRoot = tmpRoot('sess-root-');
    const root = tmpRoot('ws-');
    const journalDir = join(sessionsRoot, 'sess-1', 'journal');
    seedTwoAged(journalDir);
    const before = indexLines(journalDir);
    vi.spyOn(FileJournalStore.prototype, 'enforceRetention').mockReturnValue({
      entries: 0,
      bytes: 0,
      overBound: 0,
    });
    const text = channel();
    expect(
      await runJournalCommand(
        { command: 'prune', session: 'sess-1', keepDays: 7, yes: true },
        { root, sessionsRoot, out: text.out, err: text.err },
      ),
    ).toBe(1);
    expect(text.errs.join('\n')).toContain(
      'the journal changed while pruning and this run removed nothing',
    );
    expect(text.lines).toEqual([]);
    const json = channel();
    expect(
      await runJournalCommand(
        {
          command: 'prune',
          session: 'sess-1',
          keepDays: 7,
          yes: true,
          json: true,
        },
        { root, sessionsRoot, out: json.out, err: json.err },
      ),
    ).toBe(1);
    expect(JSON.parse(json.lines.join('\n'))).toMatchObject({
      dryRun: false,
      pruned: 0,
    });
    expect(indexLines(journalDir)).toEqual(before);
  });
});
