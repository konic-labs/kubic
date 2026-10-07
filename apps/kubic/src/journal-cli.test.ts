// Slice D: `kubic diff / undo / log / status` CLI (issue #18; §42.2, §78).
// RED: runJournalCommand does not exist yet.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliUsageError } from '../../../packages/core/src/cli/exit-codes.js';
import { createCliTheme } from '../../../packages/core/src/cli/theme.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import {
  colorizeDiffLine,
  type JournalRequest,
  runJournalCommand,
} from '../../../packages/host/src/journal-cli.js';
import {
  auditLedgerDirFor,
  readAuditLedger,
} from '../../../packages/host/src/policy/audit-ledger.js';
import {
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  disposeAllGitSandboxes();
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
    expect(await runJournalCommand({ command: 'diff' }, deps)).toBe(0);
    expect(out.lines.join('\n')).toContain('agent=root toolCall=call-1');
    const none: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff', agent: 'nobody' },
        {
          ...deps,
          out: (l: string) => none.push(l),
        },
      ),
    ).toBe(0);
    expect(none).toEqual(['no changes']);
    const json: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff', json: true },
        {
          ...deps,
          out: (l) => json.push(l),
        },
      ),
    ).toBe(0);
    const parsed = JSON.parse(json.join('\n')) as {
      session: string | null;
      root: string | null;
      changes: Array<{ path: string }>;
    };
    // Issue #362: the document names the resolved store.
    expect(parsed.session).toBe(null);
    expect(parsed.root).toBe(root);
    expect(parsed.changes[0]?.path).toBe('a.txt');
  });

  it('undoes to pre-run content, dry-runs cleanly, and logs the timeline', async () => {
    const { journalDir, root, out } = setup();
    const deps = { journalDir, root, out: out.write };
    const dry: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'undo', dryRun: true },
        {
          ...deps,
          out: (l) => dry.push(l),
        },
      ),
    ).toBe(0);
    expect(dry.join('\n')).toContain('would restore');
    expect(await runJournalCommand({ command: 'undo' }, deps)).toBe(0);
    const log: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'log' },
        { ...deps, out: (l) => log.push(l) },
      ),
    ).toBe(0);
    expect(log.join('\n')).toContain('a.txt');
    const status: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'status' },
        {
          ...deps,
          out: (l) => status.push(l),
        },
      ),
    ).toBe(0);
    expect(status.join('\n')).toContain('non-repo');
  });

  it('records one undo-restore ledger row per real undo, none for dry-run (issue #284)', async () => {
    const { journalDir, root, out } = setup();
    const deps = { journalDir, root, out: out.write };
    expect(
      await runJournalCommand({ command: 'undo', dryRun: true }, deps),
    ).toBe(0);
    expect(readAuditLedger(auditLedgerDirFor(root))).toEqual([]);
    expect(await runJournalCommand({ command: 'undo' }, deps)).toBe(0);
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
    'a failed ledger append surfaces on stderr and never fails the undo (issue #284)',
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
        expect(await runJournalCommand({ command: 'undo' }, deps)).toBe(0);
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
      agentId: 'root',
      toolCallId: null,
      timestamp: 2,
      unattributed: true,
    });
    const lines: string[] = [];
    const deps = { journalDir, root, out: (l: string) => lines.push(l) };
    expect(await runJournalCommand({ command: 'undo' }, deps)).toBe(1);
    expect(lines.join('\n')).toContain('non-reversible');
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

  it('skips stale steps with a named reason and exits 1, disk untouched', async () => {
    const { journalDir, root } = seedStale();
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'undo' },
      {
        journalDir,
        root,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('stale (skipped): stale.txt');
    expect(text).toContain('undo: 0 restored, 1 skipped (1 stale)');
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
  });

  it('--force restores past the staleness refusal', async () => {
    const { journalDir, root } = seedStale();
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'undo', force: true },
      {
        journalDir,
        root,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('restored stale.txt');
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v1\n');
  });

  it('--dry-run reports the stale split without writing', async () => {
    const { journalDir, root } = seedStale();
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'undo', dryRun: true },
      {
        journalDir,
        root,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('would restore 0 step(s)');
    expect(text).toContain('skip 1 (1 stale): stale.txt');
    expect(readFileSync(join(root, 'stale.txt'), 'utf8')).toBe('v3\n');
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
    const code = await runJournalCommand(
      { command: 'diff' },
      {
        journalDir,
        root,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('# [corrupt journal content]');
  });

  it('status counts a corrupt: line', async () => {
    const { journalDir, root } = seedTornDelta();
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'status' },
      {
        journalDir,
        root,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('corrupt: 1');
  });
});

// Torn index lines (issue #343): a fragment left by a crash or a full disk
// is dropped from the read, and `status` names the count so an operator
// does not read the loss as an empty journal.
describe('journal CLI corrupt index lines (issue #343)', () => {
  function seed(seedTorn: boolean): { journalDir: string; root: string } {
    const journalDir = mkTmp('j-');
    const root = mkTmp('ws-');
    new FileJournalStore(journalDir).append({
      path: 'a.txt',
      op: 'create',
      before: null,
      after: 'x\n',
      bytesDelta: 2,
      sessionId: 's1',
      agentId: 'root',
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
    const code = await runJournalCommand(
      { command: 'status' },
      { journalDir, root, out: (l) => lines.push(l) },
    );
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

// Issue #125: the bare journal CLI resolves `<root>/.kubic/journal` — a
// store no runtime path writes (runs journal under
// `<sessions-root>/<id>/journal`), so `kubic diff` after `kubic run` printed
// `no changes` from a dead store. With no workspace store, bare commands
// fall back to the latest session journal recorded for this workspace (#362)
// and name it first (`session: <id>`)
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

  // Issue #362: both sessions were recorded for `root` (the fallback only
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
    const code = await runJournalCommand(
      { command: 'diff' },
      {
        root,
        sessionsRoot,
        sessionWorkspaces: recordedAt(root),
        out: (l) => lines.push(l),
        err: (l) => errs.push(l),
      },
    );
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
      await runJournalCommand(
        { command: 'log' },
        {
          root,
          sessionsRoot,
          sessionWorkspaces: recordedAt(root),
          out: (l) => log.push(l),
          err: (l) => errs.push(l),
        },
      ),
    ).toBe(0);
    expect(errs).toEqual([
      `info: session: ${newId} (latest session journal for this workspace) — workspace ${root}`,
    ]);
    expect(log.join('\n')).toContain('new.txt');
    const status: string[] = [];
    errs.length = 0;
    expect(
      await runJournalCommand(
        { command: 'status' },
        {
          root,
          sessionsRoot,
          sessionWorkspaces: recordedAt(root),
          out: (l) => status.push(l),
          err: (l) => errs.push(l),
        },
      ),
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
    const code = await runJournalCommand(
      { command: 'diff', json: true },
      {
        root,
        sessionsRoot,
        sessionWorkspaces: recordedAt(root),
        out: (l) => lines.push(l),
        err: (l) => lines.push(l),
      },
    );
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
      agentId: 'root',
      toolCallId: 'call-9',
      timestamp: 1700000000000,
    });
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'diff' },
      {
        root,
        sessionsRoot,
        sessionWorkspaces: recordedAt(root),
        out: (l) => lines.push(l),
      },
    );
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
        await runJournalCommand(
          { command: 'diff', session: ref },
          {
            root,
            sessionsRoot,
            sessionWorkspaces: recordedAt(root),
            out: (l) => lines.push(l),
          },
        ),
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
    const code = await runJournalCommand(
      { command: 'undo', dryRun: true },
      {
        root,
        sessionsRoot,
        sessionWorkspaces: recordedAt(root),
        out: (l) => lines.push(l),
        err: (l) => errs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(errs).toEqual([
      `info: session: ${newId} (latest session journal for this workspace) — workspace ${root}`,
    ]);
    expect(lines.join('\n')).toContain('would restore 1 step(s)');
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('n2\n');
  });

  it('empty everywhere prints the nothing-anywhere hint and exits 0', async () => {
    const sessionsRoot = mkTmp('sr-');
    const root = mkTmp('ws-');
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runJournalCommand(
      { command: 'diff' },
      {
        root,
        sessionsRoot,
        sessionWorkspaces: recordedAt(root),
        out: (l) => lines.push(l),
        err: (l) => errs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(lines).toEqual(['no changes']);
    expect(errs).toEqual([
      `info: no journal under ${join(root, '.kubic', 'journal')} and none under the sessions root (${sessionsRoot}) — start a run or pass --session`,
    ]);
    // --json stays one parseable envelope, hint included nowhere.
    const json: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff', json: true },
        {
          root,
          sessionsRoot,
          out: (l) => json.push(l),
          err: (l) => json.push(l),
        },
      ),
    ).toBe(0);
    expect(JSON.parse(json.join('\n'))).toEqual({
      session: null,
      root,
      changes: [],
    });
  });

  it('a missing sessions root is the same empty path, no throw', async () => {
    const sessionsRoot = join(mkTmp('sr-'), 'absent');
    const root = mkTmp('ws-');
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runJournalCommand(
      { command: 'diff' },
      {
        root,
        sessionsRoot,
        out: (l) => lines.push(l),
        err: (l) => errs.push(l),
      },
    );
    expect(code).toBe(0);
    expect(lines).toEqual(['no changes']);
    expect(errs).toEqual([
      `info: no journal under ${join(root, '.kubic', 'journal')} and none under the sessions root (${sessionsRoot}) — start a run or pass --session`,
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
      await runJournalCommand(
        { command: 'undo' },
        { journalDir, root, out: () => {} },
      ),
    ).toBe(0);
    const lines: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      ),
    ).toBe(0);
    // The undo is the newest entry for the path, so its attribution is the
    // one the diff reports.
    expect(lines.join('\n')).toContain('agent=kubic-undo toolCall=none');
  });

  it('log prints the undo record with the kubic-undo attribution and no reconciled marker', async () => {
    const { journalDir, root } = setup();
    expect(
      await runJournalCommand(
        { command: 'undo' },
        { journalDir, root, out: () => {} },
      ),
    ).toBe(0);
    const lines: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'log' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      ),
    ).toBe(0);
    const undoLine = lines.find((l) => l.includes('kubic-undo'));
    expect(undoLine).toBeDefined();
    // Table columns: TIME AGENT TOOL CALL OP PATH BYTES NOTE.
    expect(undoLine ?? '').toMatch(/kubic-undo\s+none\s+write\s+a\.txt\s/);
    // The undo is attributed — not an unattributed reconciliation find.
    expect(undoLine ?? '').not.toContain('reconciled');
  });

  it('redo: undo --step immediately after an undo restores the pre-undo content', async () => {
    const { journalDir, root } = setup();
    expect(
      await runJournalCommand(
        { command: 'undo' },
        { journalDir, root, out: () => {} },
      ),
    ).toBe(0);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'undo', step: true },
      {
        journalDir,
        root,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('restored a.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('undo --dry-run appends no record', async () => {
    const { journalDir, root } = setup();
    expect(
      await runJournalCommand(
        { command: 'undo', dryRun: true },
        {
          journalDir,
          root,
          out: () => {},
        },
      ),
    ).toBe(0);
    const lines: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'log' },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      ),
    ).toBe(0);
    expect(lines.join('\n')).not.toContain('kubic-undo');
    expect(new FileJournalStore(journalDir).entries()).toHaveLength(1);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('plain undo twice is idempotent: the second run reports already-undone and appends nothing', async () => {
    const { journalDir, root } = setup();
    expect(
      await runJournalCommand(
        { command: 'undo' },
        { journalDir, root, out: () => {} },
      ),
    ).toBe(0);
    const second: string[] = [];
    // Already-undone skips exit 1 (the documented partial-undo code, never
    // the usage code) — and write nothing.
    expect(
      await runJournalCommand(
        { command: 'undo' },
        {
          journalDir,
          root,
          out: (l) => second.push(l),
        },
      ),
    ).toBe(1);
    expect(second.join('\n')).toContain('already undone (skipped): a.txt');
    expect(second.join('\n')).not.toContain('restored a.txt');
    expect(new FileJournalStore(journalDir).entries()).toHaveLength(2);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
  });
});

// Issue #126: the status repo line follows a linked worktree's `gitdir:`
// pointer — a linked worktree must not report `(detached)` (or a non-repo)
// for a live branch.
describe('journal CLI worktree status (issue #126)', () => {
  it('status names the worktree branch from the gitdir pointer', async () => {
    const journalDir = mkTmp('j-');
    const root = mkTmp('wt-');
    const gitdir = mkTmp('gd-');
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/wt-feature\n');
    writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`);
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'status' },
      {
        journalDir,
        root,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('repo: branch wt-feature');
  });

  // Issue #380: on a real repo the status line also names the root (and
  // ahead/behind plus conflicts when they exist). L-D37: real git runs
  // through the shared sandbox, never raw execFileSync.
  it('status names the repo root on a real repository', async () => {
    const journalDir = mkTmp('j-');
    const repo = createGitSandbox({
      prefix: 'kubic-status-380-',
      injectProcessEnv: true,
    });
    writeFileSync(join(repo.path, 'a.txt'), 'one\n');
    repo.git(['add', '--', 'a.txt']);
    repo.git(['commit', '-qm', 'first']);
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'status' },
      { journalDir, root: repo.path, out: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(
      `repo: branch main, dirty: no, root ${repo.path}`,
    );
  });

  // Review gap on issue #380: the ahead/behind and conflicts branches
  // of the repo line need a direct render pin — a mutant deleting those
  // parts.push lines must fail.
  it('status renders ahead/behind and conflicts on a real repository', async () => {
    const journalDir = mkTmp('j-');
    const origin = mkTmp('origin-');
    const repo = createGitSandbox({
      prefix: 'kubic-status-380-',
      injectProcessEnv: true,
    });
    repo.git(['init', '--bare', '-q', origin]);
    const commit = (name: string, content: string, message: string) => {
      writeFileSync(join(repo.path, name), content);
      repo.git(['add', '--', name]);
      repo.git(['commit', '-qm', message]);
    };
    commit('a.txt', 'one\n', 'first');
    repo.git(['remote', 'add', 'origin', origin]);
    repo.git(['push', '-qu', 'origin', 'main']);
    commit('b.txt', 'two\n', 'second');
    commit('f.txt', 'base\n', 'base file');
    repo.git(['checkout', '-qb', 'feature']);
    commit('f.txt', 'theirs\n', 'theirs');
    repo.git(['checkout', '-q', 'main']);
    commit('f.txt', 'ours\n', 'ours');
    // A conflicting merge exits 1: the non-throwing variant.
    repo.gitResult(['merge', 'feature']);
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'status' },
      { journalDir, root: repo.path, out: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    // Three main-side commits past the push: second, base file, ours.
    expect(text).toContain('ahead 3, behind 0');
    expect(text).toContain('conflicts: f.txt');
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
    maxContentBytes: number | undefined,
    deps: { journalDir: string; root: string },
  ): Promise<JsonChange[]> {
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'diff', json: true, maxContentBytes },
      {
        ...deps,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    return (JSON.parse(lines.join('\n')) as { changes: JsonChange[] }).changes;
  }

  it('clips both sides at exactly 64 KiB by default, with marker and flag', async () => {
    const { journalDir, root, before, after } = seedBig();
    const parsed = await jsonDiff(undefined, { journalDir, root });
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
    const parsed = await jsonDiff(0, {
      journalDir,
      root,
    });
    expect(parsed[0]?.before).toBe(before);
    expect(parsed[0]?.after).toBe(after);
    expect(parsed[0]?.contentTruncated).toBe(false);
  });

  it('--max-content-bytes <n> honors a custom bound', async () => {
    const { journalDir, root } = seedBig();
    const parsed = await jsonDiff(100, {
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
    const parsed = await jsonDiff(undefined, { journalDir, root });
    expect(parsed[0]?.before).toBe('v1\n');
    expect(parsed[0]?.after).toBe('v2\n');
    expect(parsed[0]?.contentTruncated).toBe(false);
  });

  it('the human diff is never clipped', async () => {
    const { journalDir, root, before, after } = seedBig();
    const lines: string[] = [];
    const code = await runJournalCommand(
      { command: 'diff' },
      {
        journalDir,
        root,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain(`-${before.split('\n')[0] ?? ''}`);
    expect(text).toContain(`+${after.split('\n')[0] ?? ''}`);
    expect(text).not.toContain('[kubic: content truncated');
  });

  it('a malformed bound is a usage error naming the flag, before any output', async () => {
    // commander refuses a missing or non-numeric value before the handler
    // (apps/kubic/src/commands/journal.test.ts); the handler still refuses
    // a programmatic bound that is not a non-negative integer.
    const { journalDir, root } = setup();
    for (const maxContentBytes of [-1, 1.5, Number.NaN]) {
      const lines: string[] = [];
      await expect(
        runJournalCommand(
          { command: 'diff', json: true, maxContentBytes },
          { journalDir, root, out: (l) => lines.push(l) },
        ),
      ).rejects.toThrow(
        new CliUsageError(
          '--max-content-bytes needs a non-negative integer (0 = unlimited)',
        ),
      );
      expect(lines).toEqual([]);
    }
  });
});

// --json is one contract across the journal subcommands: every line a
// subcommand prints under --json joins to exactly one valid JSON document.
describe('journal CLI --json parity', () => {
  async function runJson(
    request: JournalRequest,
    deps: { journalDir: string; root: string },
  ): Promise<{ code: number; doc: unknown }> {
    const lines: string[] = [];
    const code = await runJournalCommand(request, {
      ...deps,
      out: (l: string) => lines.push(l),
    });
    return { code, doc: JSON.parse(lines.join('\n')) };
  }

  it('status --json prints a JSON object', async () => {
    const { journalDir, root } = setup();
    const { code, doc } = await runJson(
      { command: 'status', json: true },
      {
        journalDir,
        root,
      },
    );
    expect(code).toBe(0);
    expect(doc).toMatchObject({ entries: 1, reversible: 1, nonReversible: 0 });
  });

  it('undo --json prints restored/skipped as JSON, keeping the exit code', async () => {
    const { journalDir, root } = setup();
    const dry = await runJson(
      { command: 'undo', dryRun: true, json: true },
      {
        journalDir,
        root,
      },
    );
    expect(dry.doc).toMatchObject({ dryRun: true, restored: ['a.txt'] });
    const real = await runJson(
      { command: 'undo', json: true, path: 'a.txt' },
      {
        journalDir,
        root,
      },
    );
    expect(real.code).toBe(0);
    expect(real.doc).toMatchObject({ restored: ['a.txt'], skipped: [] });
    const again = await runJson(
      { command: 'undo', json: true },
      { journalDir, root },
    );
    expect(again.code).toBe(1);
    expect(again.doc).toMatchObject({
      restored: [],
      skipped: [{ path: 'a.txt', kind: 'already-undone' }],
    });
  });

  it('undo --json with nothing to undo is still JSON', async () => {
    const { journalDir, root } = setup();
    const { doc } = await runJson(
      { command: 'undo', json: true, path: 'nope.txt' },
      {
        journalDir,
        root,
      },
    );
    expect(doc).toMatchObject({ restored: [], skipped: [] });
  });

  it('diff and log --json on an empty journal carry empty arrays', async () => {
    const root = mkTmp('ws-');
    const journalDir = mkTmp('j-');
    expect(
      (await runJson({ command: 'diff', json: true }, { journalDir, root }))
        .doc,
    ).toEqual({ session: null, root, changes: [] });
    expect(
      (await runJson({ command: 'log', json: true }, { journalDir, root })).doc,
    ).toEqual({ session: null, root, entries: [] });
  });
});

// Presentation on the shared CLI helpers: colour comes only from the
// injected theme (the composition root decides TTY/NO_COLOR), `--json`
// never carries it, and `log` is a table (plain columns off a TTY, the kit
// drawn when fancy).
describe('journal CLI presentation (themes, tables)', () => {
  const ESC = '\u001b[';
  const COLOR = createCliTheme('16');

  it('colorizeDiffLine styles by role and is the identity when plain', () => {
    const plain = createCliTheme('none');
    const lines = [
      '--- a/x.ts',
      '+++ b/x.ts',
      '# agent=root toolCall=c1',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      ' same',
    ];
    for (const line of lines) {
      expect(colorizeDiffLine(line, plain)).toBe(line);
    }
    expect(colorizeDiffLine('+new', COLOR)).toBe(COLOR.success('+new'));
    expect(colorizeDiffLine('-old', COLOR)).toBe(COLOR.accent('-old'));
    expect(colorizeDiffLine('@@ -1 +1 @@', COLOR)).toBe(
      COLOR.warning('@@ -1 +1 @@'),
    );
    expect(colorizeDiffLine('--- a/x.ts', COLOR)).toBe(
      COLOR.bold('--- a/x.ts'),
    );
    expect(colorizeDiffLine('+++ b/x.ts', COLOR)).toBe(
      COLOR.bold('+++ b/x.ts'),
    );
    expect(colorizeDiffLine('# agent=root', COLOR)).toBe(
      COLOR.muted('# agent=root'),
    );
    expect(colorizeDiffLine(' same', COLOR)).toBe(' same');
  });

  it('diff colours hunks with the injected theme; --json ignores it', async () => {
    const { journalDir, root } = setup();
    const human: string[] = [];
    await runJournalCommand(
      { command: 'diff' },
      { journalDir, root, theme: COLOR, out: (l) => human.push(l) },
    );
    expect(human).toContain(COLOR.success('+v2'));
    expect(human).toContain(COLOR.accent('-v1'));
    const json: string[] = [];
    await runJournalCommand(
      { command: 'diff', json: true },
      { journalDir, root, theme: COLOR, out: (l) => json.push(l) },
    );
    expect(json.join('\n')).not.toContain(ESC);
    expect(() => JSON.parse(json.join('\n'))).not.toThrow();
  });

  it('undo colours its verdict words but keeps the text', async () => {
    const { journalDir, root } = setup();
    const lines: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'undo' },
        { journalDir, root, theme: COLOR, out: (l) => lines.push(l) },
      ),
    ).toBe(0);
    expect(lines[0]).toBe(`${COLOR.success('restored')} a.txt`);
  });

  it('log is a plain aligned table off a TTY and the kit table when fancy', async () => {
    const { journalDir, root } = setup();
    const plain: string[] = [];
    await runJournalCommand(
      { command: 'log' },
      { journalDir, root, out: (l) => plain.push(l) },
    );
    expect(plain).toEqual([
      'TIME                      AGENT  TOOL CALL  OP     PATH   BYTES  NOTE',
      '2023-11-14T22:13:20.000Z  root   call-1     write  a.txt    +0B',
      'unattributed: 0 of 1 entr(ies) reconciled at run end',
    ]);
    const fancy: string[] = [];
    await runJournalCommand(
      { command: 'log' },
      { journalDir, root, fancy: true, out: (l) => fancy.push(l) },
    );
    expect(fancy.join('\n')).toMatch(/\n─+\n/);
    expect(fancy.join('\n')).not.toContain('┌');
    expect(fancy.join('\n')).toContain('a.txt');
    expect(fancy.at(-1)).toBe(
      'unattributed: 0 of 1 entr(ies) reconciled at run end',
    );
  });

  it('status stays plain text without a theme', async () => {
    const { journalDir, root } = setup();
    const lines: string[] = [];
    await runJournalCommand(
      { command: 'status' },
      { journalDir, root, out: (l) => lines.push(l) },
    );
    expect(lines.slice(0, 3)).toEqual([
      'entries: 1 (reversible: 1, non-reversible: 0)',
      'unattributed: 0 of 1 (reconciled at run end)',
      'corrupt: 0',
    ]);
    expect(lines.join('\n')).not.toContain(ESC);
  });

  it('diagnostics carry the logger prefix and colour only with errTheme', async () => {
    const sessionsRoot = mkTmp('sr-');
    const root = mkTmp('ws-');
    const errs: string[] = [];
    await runJournalCommand(
      { command: 'diff' },
      {
        root,
        sessionsRoot,
        errTheme: COLOR,
        out: () => {},
        err: (l) => errs.push(l),
      },
    );
    expect(errs).toHaveLength(1);
    // Issue #450: a colour terminal shows the level as a status mark.
    expect(errs[0]?.startsWith(COLOR.ui.fg('info')('ℹ'))).toBe(true);
  });
});

// Issue #400: the default session-workspace lookup reads the durable session
// store's own metadata (`kubic.session` → listing meta), so a real session
// created by the store associates its journal with the workspace it recorded.
describe('journal CLI default session workspaces over the durable store (issue #400)', () => {
  it('finds the latest journal of a session the store recorded for this workspace', async () => {
    const sessionsRoot = mkTmp('sr-');
    const root = mkTmp('ws-');
    // The session ran in a subdirectory but declared the repo as its
    // workspace: `kubic diff` from the repo must still find it.
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const session = await createSession(
      store,
      { cwd: join(root, 'pkg'), workspace: root },
      BACKGROUND_CONTEXT,
    );
    await session.release(BACKGROUND_CONTEXT);
    const journalDir = join(sessionsRoot, session.id, 'journal');
    new FileJournalStore(journalDir).append({
      path: 'durable.txt',
      op: 'write',
      before: 'd1\n',
      after: 'd2\n',
      bytesDelta: 0,
      sessionId: session.id,
      agentId: 'root',
      toolCallId: 'call-1',
      timestamp: 1700000000000,
    });

    // No injected sessionWorkspaces: the default lookup must read the
    // session's recorded cwd out of the durable store.
    const lines: string[] = [];
    const errs: string[] = [];
    const code = await runJournalCommand(
      { command: 'diff' },
      {
        root,
        sessionsRoot,
        out: (line) => lines.push(line),
        err: (line) => errs.push(line),
      },
    );
    expect(code).toBe(0);
    expect(errs[0]).toContain(`session: ${session.id}`);
    expect(lines.join('\n')).toContain('durable.txt');
  });
});

describe('journal CLI HEAD moves (issue #378)', () => {
  const MOVE_A = { head: 'a'.repeat(40), branch: 'main', stash: 0 };
  const MOVE_B = { head: 'b'.repeat(40), branch: 'feature', stash: 0 };

  function movedSetup(): {
    journalDir: string;
    root: string;
    lines: string[];
  } {
    const journalDir = mkTmp('j-');
    const root = mkTmp('ws-');
    writeFileSync(join(root, 'a.txt'), 'v2\n');
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
      timestamp: 1700000001000,
      unattributed: true,
    });
    return { journalDir, root, lines: [] as string[] };
  }

  it('undo refuses without --force and names the HEAD move', async () => {
    const { journalDir, root, lines } = movedSetup();
    const deps = {
      journalDir,
      root,
      out: (l: string) => lines.push(l),
    };
    expect(await runJournalCommand({ command: 'undo' }, deps)).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain('head-moved (skipped):');
    expect(text).toContain('a.txt');
    expect(text).toContain('feature@');
    // Nothing was written for the step.
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('undo proceeds across the marker with --force', async () => {
    const { journalDir, root, lines } = movedSetup();
    const deps = {
      journalDir,
      root,
      out: (l: string) => lines.push(l),
    };
    expect(
      await runJournalCommand({ command: 'undo', force: true }, deps),
    ).toBe(0);
    expect(lines.join('\n')).toContain('restored a.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
  });

  it('status prints the warning; --json carries headMoves', async () => {
    const { journalDir, root, lines } = movedSetup();
    const deps = {
      journalDir,
      root,
      out: (l: string) => lines.push(l),
    };
    expect(await runJournalCommand({ command: 'status' }, deps)).toBe(0);
    expect(lines.join('\n')).toContain('head-moved:');
    const json: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'status', json: true },
        { ...deps, out: (l: string) => json.push(l) },
      ),
    ).toBe(0);
    const parsed = JSON.parse(json.join('\n')) as {
      headMoves: Array<{ from: unknown; to: unknown }>;
    };
    expect(parsed.headMoves).toEqual([{ from: MOVE_A, to: MOVE_B }]);
  });

  it('log renders the marker as a head-moved line', async () => {
    const { journalDir, root, lines } = movedSetup();
    expect(
      await runJournalCommand(
        { command: 'log' },
        { journalDir, root, out: (l: string) => lines.push(l) },
      ),
    ).toBe(0);
    expect(lines.join('\n')).toContain('head-moved');
  });
});

describe('journal CLI diff path scope (issue #271)', () => {
  it('a scoped request shows only that path', async () => {
    const { journalDir, root } = setup();
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'b.txt',
      op: 'write',
      before: null,
      after: 'other\n',
      bytesDelta: 6,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-2',
      timestamp: 1700000000001,
    });
    const lines: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff', path: 'b.txt' },
        { journalDir, root, out: (l: string) => lines.push(l) },
      ),
    ).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('b.txt');
    expect(text).not.toContain('a.txt');
  });
});

describe('journal CLI diff --stat (issue #335)', () => {
  function statSetup(): { journalDir: string; root: string } {
    const journalDir = mkTmp('j-');
    const root = mkTmp('ws-');
    const store = new FileJournalStore(journalDir);
    store.append({
      path: 'a.txt',
      op: 'write',
      before: 'v1\n',
      after: 'v2\ntail\n',
      bytesDelta: 5,
      sessionId: 's1',
      agentId: 'root',
      toolCallId: 'call-1',
      toolName: 'edit',
      turn: 3,
      timestamp: 1700000000000,
    });
    return { journalDir, root };
  }

  it('prints per-file counts with tool and turn instead of hunks', async () => {
    const { journalDir, root } = statSetup();
    const lines: string[] = [];
    expect(
      await runJournalCommand(
        { command: 'diff', stat: true },
        { journalDir, root, out: (l: string) => lines.push(l) },
      ),
    ).toBe(0);
    // before v1\n vs after v2\ntail\n: -v1 +v2 +tail.
    expect(lines).toEqual(['a.txt +2 -1 edit, turn 3']);
  });

  it('diff and log --json carry toolName and turn', async () => {
    const { journalDir, root } = statSetup();
    const diff: string[] = [];
    await runJournalCommand(
      { command: 'diff', json: true },
      { journalDir, root, out: (l: string) => diff.push(l) },
    );
    const changes = (
      JSON.parse(diff.join('\n')) as {
        changes: Array<{ toolName?: string; turn?: number }>;
      }
    ).changes;
    expect(changes.map((c) => [c.toolName, c.turn])).toEqual([['edit', 3]]);
    const log: string[] = [];
    await runJournalCommand(
      { command: 'log', json: true },
      { journalDir, root, out: (l: string) => log.push(l) },
    );
    const entries = (
      JSON.parse(log.join('\n')) as {
        entries: Array<{ toolName?: string; turn?: number }>;
      }
    ).entries;
    expect(entries.map((e) => [e.toolName, e.turn])).toEqual([['edit', 3]]);
  });
});
