// `kubic diff / undo / log / status` CLI.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliUsageError } from '@kubic/core/cli/exit-codes';
import { createCliTheme } from '@kubic/core/cli/theme';
import { FileJournalStore } from '@kubic/exec/journal';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
} from '@kubic/exec/test-support/git-sandbox';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import {
  colorizeDiffLine,
  type JournalRequest,
  runJournalCommand,
} from './index.js';

afterEach(() => {
  disposeAllGitSandboxes();
});

function setup(): {
  journalDir: string;
  root: string;
  out: { lines: string[]; write: (line: string) => void };
} {
  const journalDir = tempDir('j-');
  const root = tempDir('ws-');
  writeFileSync(join(root, 'a.txt'), 'v1\n');
  const store = new FileJournalStore(journalDir);
  store.append({
    path: 'a.txt',
    op: 'write',
    before: 'v1\n',
    after: 'v2\n',
    bytesDelta: 0,
    sessionId: 's1',
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

// A successful undo is journaled as a `kubic-undo` entry, so
// `diff`/`log` describe the world after the undo instead of the pre-undo
// world, and a second `undo --step` is the redo (undo the undo). A dry run
// appends nothing.
describe('journal CLI undo record + redo', () => {
  it('diff shows the undo as the latest change, attributed to kubic-undo', async () => {
    const { journalDir, root } = setup();
    expect(
      (
        await runJournalCommand(
          { command: 'undo' },
          { journalDir, root, out: () => {} },
        )
      ).exitCode,
    ).toBe(0);
    const lines: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'diff' },
          {
            journalDir,
            root,
            out: (l) => lines.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    // The undo is the newest entry for the path, so its tool-call attribution
    // is the one the diff reports.
    expect(lines.join('\n')).toContain('toolCall=none');
  });

  it('log prints the undo record with no reconciled marker', async () => {
    const { journalDir, root } = setup();
    expect(
      (
        await runJournalCommand(
          { command: 'undo' },
          { journalDir, root, out: () => {} },
        )
      ).exitCode,
    ).toBe(0);
    const lines: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'log' },
          {
            journalDir,
            root,
            out: (l) => lines.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    const undoLine = lines.find((l) => /\bnone\s+write\s+a\.txt\s/.test(l));
    expect(undoLine).toBeDefined();
    // Table columns: TIME TOOL CALL OP PATH BYTES NOTE (no agent column).
    expect(lines.join('\n')).not.toContain('AGENT');
    expect(undoLine ?? '').toMatch(/none\s+write\s+a\.txt\s/);
    // The undo is attributed — not an unattributed reconciliation find.
    expect(undoLine ?? '').not.toContain('reconciled');
  });

  it('redo: undo --step immediately after an undo restores the pre-undo content', async () => {
    const { journalDir, root } = setup();
    expect(
      (
        await runJournalCommand(
          { command: 'undo' },
          { journalDir, root, out: () => {} },
        )
      ).exitCode,
    ).toBe(0);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'undo', step: true },
        {
          journalDir,
          root,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('restored a.txt');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('undo --dry-run appends no record', async () => {
    const { journalDir, root } = setup();
    expect(
      (
        await runJournalCommand(
          { command: 'undo', dryRun: true },
          {
            journalDir,
            root,
            out: () => {},
          },
        )
      ).exitCode,
    ).toBe(0);
    const lines: string[] = [];
    expect(
      (
        await runJournalCommand(
          { command: 'log' },
          {
            journalDir,
            root,
            out: (l) => lines.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(lines.join('\n')).not.toContain('kubic-undo');
    expect(new FileJournalStore(journalDir).entries()).toHaveLength(1);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v2\n');
  });

  it('plain undo twice is idempotent: the second run reports already-undone and appends nothing', async () => {
    const { journalDir, root } = setup();
    expect(
      (
        await runJournalCommand(
          { command: 'undo' },
          { journalDir, root, out: () => {} },
        )
      ).exitCode,
    ).toBe(0);
    const second: string[] = [];
    // Already-undone skips exit 1 (the documented partial-undo code, never
    // the usage code) — and write nothing.
    expect(
      (
        await runJournalCommand(
          { command: 'undo' },
          {
            journalDir,
            root,
            out: (l) => second.push(l),
          },
        )
      ).exitCode,
    ).toBe(1);
    expect(second.join('\n')).toContain('already undone (skipped): a.txt');
    expect(second.join('\n')).not.toContain('restored a.txt');
    expect(new FileJournalStore(journalDir).entries()).toHaveLength(2);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('v1\n');
  });
});

// The status repo line follows a linked worktree's `gitdir:`
// pointer — a linked worktree must not report `(detached)` (or a non-repo)
// for a live branch.
describe('journal CLI worktree status', () => {
  it('status names the worktree branch from the gitdir pointer', async () => {
    const journalDir = tempDir('j-');
    const root = tempDir('wt-');
    const gitdir = tempDir('gd-');
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/wt-feature\n');
    writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`);
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
    expect(lines.join('\n')).toContain('repo: branch wt-feature');
  });

  // On a real repo the status line also names the root (and
  // ahead/behind plus conflicts when they exist). Real git runs
  // through the shared sandbox, never raw execFileSync.
  it('status names the repo root on a real repository', async () => {
    const journalDir = tempDir('j-');
    const repo = createGitSandbox({
      prefix: 'kubic-journal-status-',
      injectProcessEnv: true,
    });
    writeFileSync(join(repo.path, 'a.txt'), 'one\n');
    repo.git(['add', '--', 'a.txt']);
    repo.git(['commit', '-qm', 'first']);
    const lines: string[] = [];
    const code = (
      await runJournalCommand(
        { command: 'status' },
        { journalDir, root: repo.path, out: (l) => lines.push(l) },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain(
      `repo: branch main, dirty: no, root ${repo.path}`,
    );
  });

  // The ahead/behind and conflicts parts of the repo line, rendered from a
  // real repository.
  it('status renders ahead/behind and conflicts on a real repository', async () => {
    const journalDir = tempDir('j-');
    const origin = tempDir('origin-');
    const repo = createGitSandbox({
      prefix: 'kubic-journal-status-',
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
    const code = (
      await runJournalCommand(
        { command: 'status' },
        { journalDir, root: repo.path, out: (l) => lines.push(l) },
      )
    ).exitCode;
    expect(code).toBe(0);
    const text = lines.join('\n');
    // Three main-side commits past the push: second, base file, ours.
    expect(text).toContain('ahead 3, behind 0');
    expect(text).toContain('conflicts: f.txt');
  });
});

// `diff --json` carries full before/after strings, so a session
// that edited a few large files is a multi-megabyte single line with no
// bound and no truncation marker. Default: clip each side at 64 KiB with
// `contentTruncated: true` and a named marker line; `--max-content-bytes 0`
// is the explicit-unlimited escape hatch for scripting. The human diff
// renders hunks, not whole files, and is never clipped.
describe('journal CLI diff --json content bounds', () => {
  const LIMIT = 64 * 1024;
  const MARKER = (bytes: number): string =>
    `\n[kubic: content truncated at ${bytes} bytes]`;

  function seedBig(bytes = 70 * 1024): {
    journalDir: string;
    root: string;
    before: string;
    after: string;
  } {
    const journalDir = tempDir('j-');
    const root = tempDir('ws-');
    const before = `${'a'.repeat(bytes)}\n`;
    const after = `${'b'.repeat(bytes)}\n`;
    new FileJournalStore(journalDir).append({
      path: 'big.txt',
      op: 'write',
      before,
      after,
      bytesDelta: 0,
      sessionId: 's1',
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
    const code = (
      await runJournalCommand(
        { command: 'diff', json: true, maxContentBytes },
        {
          ...deps,
          out: (l) => lines.push(l),
        },
      )
    ).exitCode;
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
    const code = (
      await runJournalCommand(request, {
        ...deps,
        out: (l: string) => lines.push(l),
      })
    ).exitCode;
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
    const root = tempDir('ws-');
    const journalDir = tempDir('j-');
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
      (
        await runJournalCommand(
          { command: 'undo' },
          { journalDir, root, theme: COLOR, out: (l) => lines.push(l) },
        )
      ).exitCode,
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
      'TIME                      TOOL CALL  OP     PATH   BYTES  NOTE',
      '2023-11-14T22:13:20.000Z  call-1     write  a.txt    +0B',
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
    const sessionsRoot = tempDir('sr-');
    const root = tempDir('ws-');
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
    // A colour terminal shows the level as a status mark.
    expect(errs[0]?.startsWith(COLOR.ui.fg('info')('ℹ'))).toBe(true);
  });
});
