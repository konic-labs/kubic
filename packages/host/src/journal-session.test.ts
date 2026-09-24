// Session-journal reachability (issue #83): `kubic diff/undo` reach the
// headless-run session journal under <sessionsRoot>/<id>/journal via
// --session or the printed `journal:<id>` ref. RED first.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileJournalStore } from '../../exec/src/journal.js';
import { runJournalCommand } from './journal-cli.js';

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 1700000000000,
  });
  void root;
}

describe('session journal reachability (issue #83)', () => {
  it('diff --session <id> shows the session journal effects from the cwd', async () => {
    const sessionsRoot = tmpDir('sess-root-');
    const root = tmpDir('ws-');
    seedSessionJournal(sessionsRoot, 'sess-1', root);
    const o = out();
    const code = await runJournalCommand(['diff', '--session', 'sess-1'], {
      root,
      sessionsRoot,
      out: o.write,
    });
    expect(code).toBe(0);
    expect(o.lines.join('\n')).toContain('a.txt');
  });

  it('undo --dry-run plans against the same session store diff reads', async () => {
    const sessionsRoot = tmpDir('sess-root-');
    const root = tmpDir('ws-');
    seedSessionJournal(sessionsRoot, 'sess-1', root);
    const deps = { root, sessionsRoot };
    const diffOut = out();
    expect(
      await runJournalCommand(['diff', '--session', 'sess-1'], {
        ...deps,
        out: diffOut.write,
      }),
    ).toBe(0);
    const undoOut = out();
    expect(
      await runJournalCommand(['undo', '--dry-run', '--session', 'sess-1'], {
        ...deps,
        out: undoOut.write,
      }),
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
    const code = await runJournalCommand(
      ['diff', '--session', 'journal:sess-1'],
      { root, sessionsRoot, out: o.write },
    );
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
  ])('refuses session id %s with exit 1 and never escapes', async (id) => {
    const sessionsRoot = tmpDir('sess-root-');
    const root = tmpDir('ws-');
    seedSessionJournal(sessionsRoot, 'sess-1', root);
    const o = out();
    const code = await runJournalCommand(['diff', '--session', id], {
      root,
      sessionsRoot,
      out: o.write,
    });
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toMatch(/invalid --session/);
    // The rejected join could only have escaped here: prove it never did.
    expect(existsSync(join(sessionsRoot, '..', 'evil', 'journal'))).toBe(false);
    expect(existsSync(join(sessionsRoot, '..', 'abs'))).toBe(false);
  });

  it('refuses --session combined with a configured journal dir (explicit precedence)', async () => {
    const sessionsRoot = tmpDir('sess-root-');
    const root = tmpDir('ws-');
    seedSessionJournal(sessionsRoot, 'sess-1', root);
    const o = out();
    const code = await runJournalCommand(['diff', '--session', 'sess-1'], {
      root,
      sessionsRoot,
      journalDir: join(root, '.kubic', 'journal'),
      out: o.write,
    });
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toMatch(/conflicts with a configured journal dir/);
  });
});
