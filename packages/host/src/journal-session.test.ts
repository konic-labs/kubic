// Session-journal reachability: `kubic diff/undo` reach the
// headless-run session journal under <sessionsRoot>/<id>/journal via
// --session or the printed `journal:<id>` ref.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliUsageError } from '../../core/src/cli/exit-codes.js';
import { FileJournalStore } from '../../exec/src/journal.js';
import { runJournalCommand } from './journal-cli.js';

const made: string[] = [];

function tmpDir(prefix: string): string {
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

function seedSessionJournal(
  sessionsRoot: string,
  id: string,
  root: string,
): void {
  const store = new FileJournalStore(join(sessionsRoot, id, 'journal'));
  store.append({
    path: 'a.txt',
    op: 'write',
    before: 'v1\n',
    after: 'v2\n',
    bytesDelta: 0,
    sessionId: id,
    toolCallId: 'call-1',
    timestamp: 1700000000000,
  });
  void root;
}

describe('session journal reachability', () => {
  it('diff --session <id> shows the session journal effects from the cwd', async () => {
    const sessionsRoot = tmpDir('sess-root-');
    const root = tmpDir('ws-');
    seedSessionJournal(sessionsRoot, 'sess-1', root);
    const o = out();
    const code = (
      await runJournalCommand(
        { command: 'diff', session: 'sess-1' },
        {
          root,
          sessionsRoot,
          out: o.write,
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(o.lines.join('\n')).toContain('a.txt');
  });

  it('undo --dry-run plans against the same session store diff reads', async () => {
    const sessionsRoot = tmpDir('sess-root-');
    const root = tmpDir('ws-');
    seedSessionJournal(sessionsRoot, 'sess-1', root);
    // The session recorded `root` as its workspace — undo
    // plans against that, whatever the invocation cwd.
    const deps = {
      root,
      sessionsRoot,
      sessionWorkspaces: async () => new Map([['sess-1', root]]),
    };
    const diffOut = out();
    expect(
      (
        await runJournalCommand(
          { command: 'diff', session: 'sess-1' },
          {
            ...deps,
            out: diffOut.write,
          },
        )
      ).exitCode,
    ).toBe(0);
    const undoOut = out();
    expect(
      (
        await runJournalCommand(
          { command: 'undo', dryRun: true, session: 'sess-1' },
          {
            ...deps,
            out: undoOut.write,
          },
        )
      ).exitCode,
    ).toBe(0);
    // Same store: diff shows the session's file, dry-run plans its restore.
    expect(diffOut.lines.join('\n')).toContain('a.txt');
    expect(undoOut.lines.join('\n')).toContain('would restore 1 step(s)');
    // The session value is a store selector, never a path scope: the plan
    // is not narrowed to a path literally named after the session.
    expect(undoOut.lines.join('\n')).not.toContain('nothing to undo');
  });

  it('accepts the printed journal:<id> ref verbatim as --session', async () => {
    const sessionsRoot = tmpDir('sess-root-');
    const root = tmpDir('ws-');
    seedSessionJournal(sessionsRoot, 'sess-1', root);
    const o = out();
    const code = (
      await runJournalCommand(
        { command: 'diff', session: 'journal:sess-1' },
        { root, sessionsRoot, out: o.write },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(o.lines.join('\n')).toContain('a.txt');
  });

  it.each([
    '../evil',
    '..',
    'journal:../evil',
    '/abs',
    'journal:/abs',
    'a/b',
    '',
    'journal:',
  ])(
    'refuses session id %s as a usage error (exit 2) and never escapes',
    async (id) => {
      const sessionsRoot = tmpDir('sess-root-');
      const root = tmpDir('ws-');
      seedSessionJournal(sessionsRoot, 'sess-1', root);
      const o = out();
      const error = await runJournalCommand(
        { command: 'diff', session: id },
        { root, sessionsRoot, out: o.write },
      ).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(CliUsageError);
      expect((error as CliUsageError).exitCode).toBe(2);
      expect((error as CliUsageError).message).toMatch(/invalid --session/);
      expect(o.lines).toEqual([]);
      // The rejected join could only have escaped here: prove it never did.
      expect(existsSync(join(sessionsRoot, '..', 'evil', 'journal'))).toBe(
        false,
      );
      expect(existsSync(join(sessionsRoot, '..', 'abs'))).toBe(false);
    },
  );

  it('refuses --session combined with a configured journal dir (explicit precedence)', async () => {
    const sessionsRoot = tmpDir('sess-root-');
    const root = tmpDir('ws-');
    seedSessionJournal(sessionsRoot, 'sess-1', root);
    const o = out();
    await expect(
      runJournalCommand(
        { command: 'diff', session: 'sess-1' },
        {
          root,
          sessionsRoot,
          journalDir: join(root, '.kubic', 'journal'),
          out: o.write,
        },
      ),
    ).rejects.toThrow(
      new CliUsageError(
        '--session "sess-1" conflicts with a configured journal dir (use one store per invocation)',
      ),
    );
    expect(o.lines).toEqual([]);
  });
});
