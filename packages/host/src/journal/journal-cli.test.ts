// `kubic diff / undo / log / status` CLI.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { FileJournalStore } from '@kubic/exec/journal';
import { disposeAllGitSandboxes } from '@kubic/exec/test-support/git-sandbox';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { auditLedgerDirFor, readAuditLedger } from '../audit/index.js';
import { setup } from '../test-support/journal-cli.js';
import { runJournalCommand } from './index.js';

afterEach(() => {
  disposeAllGitSandboxes();
});

describe('journal CLI', () => {
  it('diffs with attribution and filters, --json parses', async () => {
    const { journalDir, root, out } = setup();
    const deps = { journalDir, root, out: out.write };
    expect((await runJournalCommand({ command: 'diff' }, deps)).exitCode).toBe(
      0,
    );
    expect(out.lines.join('\n')).toContain('toolCall=call-1');
    expect(out.lines.join('\n')).not.toContain('agent=');
    const none: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'diff', path: 'no-such-file.txt' },
          {
            ...deps,
            out: (l: string) => none.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(none).toEqual(['no changes']);
    const json: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'diff', json: true },
          {
            ...deps,
            out: (l) => json.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    const parsed = JSON.parse(json.join('\n')) as {
      session: string | null;
      root: string | null;
      changes: Array<{ path: string }>;
    };
    // The document names the resolved store.
    expect(parsed.session).toBe(null);
    expect(parsed.root).toBe(root);
    expect(parsed.changes[0]?.path).toBe('a.txt');
  });

  it('undoes to pre-run content, dry-runs cleanly, and logs the timeline', async () => {
    const { journalDir, root, out } = setup();
    const deps = { journalDir, root, out: out.write };
    const dry: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'undo', dryRun: true },
          {
            ...deps,
            out: (l) => dry.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(dry.join('\n')).toContain('would restore');
    expect((await runJournalCommand({ command: 'undo' }, deps)).exitCode).toBe(
      0,
    );
    const log: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'log' },
          { ...deps, out: (l) => log.push(l) },
        )
      ).exitCode,
    ).toBe(0);
    expect(log.join('\n')).toContain('a.txt');
    const status: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'status' },
          {
            ...deps,
            out: (l) => status.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(status.join('\n')).toContain('non-repo');
  });

  it('records one undo-restore ledger row per real undo, none for dry-run', async () => {
    const { journalDir, root, out } = setup();
    const deps = { journalDir, root, out: out.write };
    expect(
      (await runJournalCommand({ command: 'undo', dryRun: true }, deps))
        .exitCode,
    ).toBe(0);
    expect(readAuditLedger(auditLedgerDirFor(root))).toEqual([]);
    expect((await runJournalCommand({ command: 'undo' }, deps)).exitCode).toBe(
      0,
    );
    const rows = readAuditLedger(auditLedgerDirFor(root));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.what).toBe('undo-restore');
    expect(rows[0]?.result).toBe('ok');
    expect(rows[0]?.reason).toContain('a.txt');
  });

  // POSIX-only: the failure is an unwritable ledger dir (root ignores
  // modes, win32 has none) — like the chmod-skipped audit tests.
  const posixOnly =
    process.platform === 'win32' ||
    (typeof process.getuid === 'function' && process.getuid() === 0);
  it.skipIf(posixOnly)(
    'a failed ledger append surfaces on stderr and never fails the undo',
    async () => {
      const { journalDir, root, out } = setup();
      const errs: string[] = [];
      const deps = {
        journalDir,
        root,
        out: out.write,
        err: (line: string): void => {
          errs.push(line);
        },
      };
      const ledgerDir = auditLedgerDirFor(root);
      mkdirSync(ledgerDir, { recursive: true });
      chmodSync(ledgerDir, 0o555);
      try {
        expect(
          (await runJournalCommand({ command: 'undo' }, deps)).exitCode,
        ).toBe(0);
      } finally {
        chmodSync(ledgerDir, 0o755);
      }
      // Nothing recorded, the undo still landed, the failure is named.
      expect(readAuditLedger(ledgerDir)).toEqual([]);
      expect(errs.join('\n')).toContain('audit: undo-restore not recorded');
    },
  );

  it('exits 1 on partial undo (skips never reuse the usage code)', async () => {
    const { journalDir, root, out } = setup();
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'ghost.txt',
      op: 'write',
      before: null,
      after: 'm\n',
      bytesDelta: 1,
      sessionId: 's1',
      toolCallId: null,
      timestamp: 2,
      unattributed: true,
    });
    const lines: string[] = [];
    const deps = { journalDir, root, out: (l: string) => lines.push(l) };
    expect((await runJournalCommand({ command: 'undo' }, deps)).exitCode).toBe(
      1,
    );
    expect(lines.join('\n')).toContain('non-reversible');
    void out;
  });
});

// `kubic undo` refuses to overwrite files that changed after
// the journaled entry (staleness check on afterHash); `--force` overrides.
describe('journal CLI undo staleness', () => {
  function seedStale(): {
    journalDir: string;
    root: string;
  } {
    const journalDir = tempDir('j-');
    const root = tempDir('ws-');
    // Journaled v1→v2, then a manual edit landed v3 after the fact.
    writeFileSync(join(root, 'stale.txt'), 'v3\n');
    new FileJournalStore(journalDir).append({
      path: 'stale.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\n',
      bytesDelta: 0,
      sessionId: 's1',
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });
    return { journalDir, root };
  }

  it('skips stale steps with a named reason and exits 1, disk untouched', async () => {
    const { journalDir, root } = seedStale();
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'undo' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('stale (skipped): stale.txt');
    expect(text).toContain('undo: 0 restored, 1 skipped (1 stale)');
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
  });

  it('--force restores past the staleness refusal', async () => {
    const { journalDir, root } = seedStale();
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'undo', force: true },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('restored stale.txt');
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v1\n');
  });

  it('--dry-run reports the stale split without writing', async () => {
    const { journalDir, root } = seedStale();
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'undo', dryRun: true },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('would restore 0 step(s)');
    expect(text).toContain('skip 1 (1 stale): stale.txt');
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
  });
});

// Blob integrity: a torn delta blob must print the corrupt
// marker and exit 0 — a readable journal is worth more than a crash.
describe('journal CLI corrupt content', () => {
  function seedTornDelta(): { journalDir: string; root: string } {
    const journalDir = tempDir('j-');
    const root = tempDir('ws-');
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
    const code = (
      await runJournalCommand(
        { command: 'diff' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('# [corrupt journal content]');
  });

  it('status counts a corrupt: line', async () => {
    const { journalDir, root } = seedTornDelta();
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'status' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('corrupt: 1');
  });
});

// Torn index lines: a fragment left by a crash or a full disk
// is dropped from the read, and `status` names the count so an operator
// does not read the loss as an empty journal.
describe('journal CLI corrupt index lines', () => {
  function seed(seedTorn: boolean): { journalDir: string; root: string } {
    const journalDir = tempDir('j-');
    const root = tempDir('ws-');
    new FileJournalStore(journalDir).append({
      path: 'a.txt',
      op: 'create',
      before: null,
      after: 'x\n',
      bytesDelta: 2,
      sessionId: 's1',
      toolCallId: 'call-1',
      timestamp: 100,
    });
    if (seedTorn) {
      appendFileSync(join(journalDir, 'index.jsonl'), '{"path":"torn\n');
    }
    return { journalDir, root };
  }

  it('status counts the dropped index lines', async () => {
    const { journalDir, root } = seed(true);
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'status' },
        { journalDir, root, out: (l) => lines.push(l) },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('corrupt index lines: 1');
    // The dropped line is not content corruption: the two counts are
    // separate lines with separate meanings.
    expect(lines.join('\n')).toContain('corrupt: 0');
  });

  it('status prints the count as 0 for a clean index', async () => {
    const { journalDir, root } = seed(false);
    const lines: string[] = [];
    await runJournalCommand(
      { command: 'status' },
      { journalDir, root, out: (l) => lines.push(l) },
    );
    expect(lines).toContain('corrupt index lines: 0');
  });
});

// The bare journal CLI resolves `<root>/.kubic/journal` — a
// store no runtime path writes (runs journal under
// `<sessions-root>/<id>/journal`), so `kubic diff` after `kubic run` printed
// `no changes` from a dead store. With no workspace store, bare commands
// fall back to the latest session journal recorded for this workspace
// and name it first (`session: <id>`)
// so the fallback is never silent; `--json` keeps its parseable envelope.
describe('journal CLI default store fallback', () => {
  function seedSessions(): {
    root: string;
    sessionsRoot: string;
    oldId: string;
    newId: string;
  } {
    const sessionsRoot = tempDir('sr-');
    const root = tempDir('ws-');
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

  // Both sessions were recorded for `root` (the fallback only
  // considers sessions recorded for the current workspace).
  const recordedAt = (root: string) => async (): Promise<Map<string, string>> =>
    new Map([
      ['sess-old', root],
      ['sess-new', root],
    ]);

  it('bare diff falls back to the latest session journal and names it first', async () => {
    const { root, sessionsRoot, newId } = seedSessions();
    const lines: string[] = [];
    const errs: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'diff' },
        {
          root,
          sessionsRoot,
          sessionWorkspaces: recordedAt(root),
          out: (l) => lines.push(l),
          err: (l) => errs.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    // The note is a diagnostic: stderr, before any report line.
    expect(errs).toEqual([
      `info: session: ${newId} (latest session journal for this workspace) — workspace ${root}`,
    ]);
    expect(lines[0]).toBe('--- a/new.txt');
    const text = lines.join('\n');
    expect(text).toContain('new.txt');
    expect(text).not.toContain('old.txt');
  });

  it('bare log and status read the fallback store too', async () => {
    const { root, sessionsRoot, newId } = seedSessions();
    const log: string[] = [];
    const errs: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'log' },
          {
            root,
            sessionsRoot,
            sessionWorkspaces: recordedAt(root),
            out: (l) => log.push(l),
            err: (l) => errs.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(errs).toEqual([
      `info: session: ${newId} (latest session journal for this workspace) — workspace ${root}`,
    ]);
    expect(log.join('\n')).toContain('new.txt');
    const status: string[] = [];
    errs.length = 0;
    expect(
      (
        await runJournalCommand(
          { command: 'status' },
          {
            root,
            sessionsRoot,
            sessionWorkspaces: recordedAt(root),
            out: (l) => status.push(l),
            err: (l) => errs.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(errs).toEqual([
      `info: session: ${newId} (latest session journal for this workspace) — workspace ${root}`,
    ]);
    expect(status[0]).toBe('entries: 1 (reversible: 1, non-reversible: 0)');
    expect(status.join('\n')).toContain('entries: 1');
  });

  it('--json keeps the parseable envelope and prints no session line', async () => {
    const { root, sessionsRoot } = seedSessions();
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'diff', json: true },
        {
          root,
          sessionsRoot,
          sessionWorkspaces: recordedAt(root),
          out: (l) => lines.push(l),
          err: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as {
      session: string;
      changes: Array<{ path: string }>;
    };
    expect(parsed.session).toBe('sess-new');
    expect(parsed.changes.map((c) => c.path)).toEqual(['new.txt']);
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
      toolCallId: 'call-9',
      timestamp: 1700000000000,
    });
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'diff' },
        {
          root,
          sessionsRoot,
          sessionWorkspaces: recordedAt(root),
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
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
        (
          await runJournalCommand(
            { command: 'diff', session: ref },
            {
              root,
              sessionsRoot,
              sessionWorkspaces: recordedAt(root),
              out: (l) => lines.push(l),
            },
          )
        ).exitCode,
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
    const errs: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'undo', dryRun: true },
        {
          root,
          sessionsRoot,
          sessionWorkspaces: recordedAt(root),
          out: (l) => lines.push(l),
          err: (l) => errs.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(errs).toEqual([
      `info: session: ${newId} (latest session journal for this workspace) — workspace ${root}`,
    ]);
    expect(lines.join('\n')).toContain('would restore 1 step(s)');
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('n2\n');
  });

  it('empty everywhere prints the nothing-anywhere hint and exits 0', async () => {
    const sessionsRoot = tempDir('sr-');
    const root = tempDir('ws-');
    const lines: string[] = [];
    const errs: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'diff' },
        {
          root,
          sessionsRoot,
          sessionWorkspaces: recordedAt(root),
          out: (l) => lines.push(l),
          err: (l) => errs.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines).toEqual(['no changes']);
    expect(errs).toEqual([
      `info: no journal under ${join(root, '.kubic', 'journal')} and none under the sessions root (${sessionsRoot}) — start a run or pass --session`,
    ]);
    // --json stays one parseable envelope, hint included nowhere.
    const json: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'diff', json: true },
          {
            root,
            sessionsRoot,
            out: (l) => json.push(l),
            err: (l) => json.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(JSON.parse(json.join('\n'))).toEqual({
      session: null,
      root,
      changes: [],
    });
  });

  it('a missing sessions root is the same empty path, no throw', async () => {
    const sessionsRoot = join(tempDir('sr-'), 'absent');
    const root = tempDir('ws-');
    const lines: string[] = [];
    const errs: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'diff' },
        {
          root,
          sessionsRoot,
          out: (l) => lines.push(l),
          err: (l) => errs.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines).toEqual(['no changes']);
    expect(errs).toEqual([
      `info: no journal under ${join(root, '.kubic', 'journal')} and none under the sessions root (${sessionsRoot}) — start a run or pass --session`,
    ]);
  });
});
