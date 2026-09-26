// Session-state retention: `kubic sessions prune` (issue #119; §21, §42.4).
//
// The rails are the contract, so this file pins them behaviourally through
// the CLI surface: dry-run is the DEFAULT (deletion needs --yes), a session
// held by a LIVE lock is never a candidate, non-session-shaped entries in
// the root are never touched, and a keep window must be supplied (flag or
// config) — never invented. Hermetic: tmp dirs only, liveness is stubbed
// (`process.kill`, fake pids), zero network.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSessionsCommand } from './sessions-cli.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FAKE_PID = 424243;

function tmpRoot(prefix = 'prune-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function out(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

// A session state dir holding 15 bytes over three files, with the session
// dir's mtime aged by `ageMs`.
function sessionDir(root: string, id: string, ageMs: number): string {
  const dir = join(root, id);
  mkdirSync(join(dir, 'journal'), { recursive: true });
  writeFileSync(join(dir, 'journal', 'index.jsonl'), 'index!!');
  writeFileSync(join(dir, 'journal', 'blob'), 'abc');
  writeFileSync(join(dir, 'spans.jsonl'), 'spans');
  const secs = (Date.now() - ageMs) / 1000;
  utimesSync(dir, secs, secs);
  return dir;
}

function stubKill(alive: boolean): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'kill').mockImplementation((() => {
    if (!alive) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }
    return 0;
  }) as never);
}

function lockFile(root: string, id: string, pid: number, ageMs: number): void {
  writeFileSync(
    join(root, id, 'lock.json'),
    JSON.stringify({ pid, startedAt: Date.now() - ageMs }),
  );
}

function prune(
  root: string,
  args: string[],
  extra: { retentionDays?: number; now?: () => number } = {},
): Promise<{ code: number; lines: string[] }> {
  const o = out();
  return runSessionsCommand(['prune', ...args], {
    sessionsRoot: root,
    out: o.write,
    ...extra,
  }).then((code) => ({ code, lines: o.lines }));
}

describe('sessions prune, dry-run default (issue #119)', () => {
  it('lists candidates and deletes nothing without --yes', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-one', 31 * DAY_MS);
    sessionDir(root, 'fresh-one', 60 * 60 * 1000);
    const { code, lines } = await prune(root, ['--keep-days', '30']);
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-one'))).toBe(true);
    expect(existsSync(join(root, 'fresh-one'))).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain('would prune aged-one (15B)');
    expect(text).not.toContain('fresh-one (');
    expect(text).toContain('--yes');
  });

  it('--dry-run is the explicit synonym: nothing removed, ids + bytes listed', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 40 * DAY_MS);
    sessionDir(root, 'aged-b', 90 * DAY_MS);
    const { code, lines } = await prune(root, [
      '--dry-run',
      '--keep-days',
      '30',
    ]);
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('would prune aged-a (15B)');
    expect(text).toContain('would prune aged-b (15B)');
    expect(text).toContain('would be pruned');
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
    expect(existsSync(join(root, 'aged-b'))).toBe(true);
  });

  it('--yes deletes exactly the listed set', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 40 * DAY_MS);
    sessionDir(root, 'aged-b', 90 * DAY_MS);
    sessionDir(root, 'fresh-one', 0);
    const dry = await prune(root, ['--keep-days', '30']);
    const listed = dry.lines
      .filter((line) => line.startsWith('would prune '))
      .map((line) => line.split(' ')[2] as string);
    expect(listed.sort()).toEqual(['aged-a', 'aged-b']);
    const { code } = await prune(root, ['--keep-days', '30', '--yes']);
    expect(code).toBe(0);
    for (const id of listed) {
      expect(existsSync(join(root, id))).toBe(false);
    }
    expect(existsSync(join(root, 'fresh-one'))).toBe(true);
  });

  it('--dry-run and --yes contradict: refused by name, nothing deleted', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 40 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      ['prune', '--keep-days', '30', '--yes', '--dry-run'],
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toContain('--dry-run');
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
  });
});

describe('sessions prune, age window (issue #119)', () => {
  it('the boundary is exact: at the cutoff is eligible, past it is not', async () => {
    const root = tmpRoot();
    const now = Date.UTC(2026, 0, 15);
    const cutoff = now - 30 * DAY_MS;
    sessionDir(root, 'at-cutoff', 0);
    sessionDir(root, 'just-used', 0);
    utimesSync(join(root, 'at-cutoff'), cutoff / 1000, cutoff / 1000);
    utimesSync(
      join(root, 'just-used'),
      (cutoff + 1000) / 1000,
      (cutoff + 1000) / 1000,
    );
    const { code } = await prune(root, ['--keep-days', '30', '--yes'], {
      now: () => now,
    });
    expect(code).toBe(0);
    expect(existsSync(join(root, 'at-cutoff'))).toBe(false);
    expect(existsSync(join(root, 'just-used'))).toBe(true);
  });

  it('a session whose dir mtime is recent survives even with aged content', async () => {
    const root = tmpRoot();
    const dir = sessionDir(root, 'recently-attached', 0);
    const old = (Date.now() - 90 * DAY_MS) / 1000;
    utimesSync(join(dir, 'spans.jsonl'), old, old);
    utimesSync(join(dir, 'journal'), old, old);
    const o = out();
    const code = await runSessionsCommand(
      ['prune', '--keep-days', '30', '--yes'],
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(0);
    expect(existsSync(dir)).toBe(true);
    expect(o.lines.join('\n')).toContain('nothing to prune');
  });

  it('a missing sessions root is a fresh machine: nothing to prune, exit 0', async () => {
    const root = join(tmpRoot(), 'not-created-yet');
    const o = out();
    const code = await runSessionsCommand(['prune', '--keep-days', '30'], {
      sessionsRoot: root,
      out: o.write,
    });
    expect(code).toBe(0);
    expect(o.lines.join('\n')).toContain('nothing to prune');
  });

  it('a malformed sessions root refuses by name, exit 1', async () => {
    const root = tmpRoot();
    const notADir = join(root, 'sessions');
    writeFileSync(notADir, 'not a directory');
    const o = out();
    const code = await runSessionsCommand(['prune', '--keep-days', '30'], {
      sessionsRoot: notADir,
      out: o.write,
    });
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toContain(notADir);
    expect(o.lines.join('\n')).toContain('error:');
  });
});

describe('sessions prune, protection rails (issue #119)', () => {
  it('a live lock protects an aged session and is reported', async () => {
    const root = tmpRoot();
    const dir = sessionDir(root, 'held-live', 90 * DAY_MS);
    lockFile(root, 'held-live', FAKE_PID, 90 * DAY_MS);
    const secs = (Date.now() - 90 * DAY_MS) / 1000;
    utimesSync(dir, secs, secs);
    const kill = stubKill(true);
    try {
      const o = out();
      const code = await runSessionsCommand(
        ['prune', '--keep-days', '30', '--yes'],
        { sessionsRoot: root, out: o.write },
      );
      expect(code).toBe(0);
      expect(existsSync(dir)).toBe(true);
      const text = o.lines.join('\n');
      expect(text).toContain('locked: held-live');
      expect(text).toContain(String(FAKE_PID));
      expect(text).not.toContain('pruned held-live');
    } finally {
      kill.mockRestore();
    }
  });

  it('a stale lock (dead holder) does not protect', async () => {
    const root = tmpRoot();
    const dir = sessionDir(root, 'held-dead', 90 * DAY_MS);
    lockFile(root, 'held-dead', FAKE_PID, 91 * DAY_MS);
    const secs = (Date.now() - 90 * DAY_MS) / 1000;
    utimesSync(dir, secs, secs);
    const kill = stubKill(false);
    try {
      const o = out();
      const code = await runSessionsCommand(
        ['prune', '--keep-days', '30', '--yes'],
        { sessionsRoot: root, out: o.write },
      );
      expect(code).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(o.lines.join('\n')).toContain('pruned held-dead');
    } finally {
      kill.mockRestore();
    }
  });

  it('--keep-session protects the named session even when aged', async () => {
    const root = tmpRoot();
    sessionDir(root, 'keep-me', 90 * DAY_MS);
    sessionDir(root, 'prune-me', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      ['prune', '--keep-days', '30', '--keep-session', 'keep-me', '--yes'],
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'keep-me'))).toBe(true);
    expect(existsSync(join(root, 'prune-me'))).toBe(false);
    expect(o.lines.join('\n')).toContain('kept: keep-me (--keep-session)');
  });

  it('never touches non-session-shaped entries in the root', async () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'stray.txt'), 'hello');
    writeFileSync(join(root, 'lock.json'), JSON.stringify({ pid: 1 }));
    mkdirSync(join(root, 'not a session'));
    // pi's transcript cwd-slug dir (<root>/--<cwd>--/<ts>_<id>.jsonl): it
    // matches the id character class but is never a session state dir.
    const slug = join(root, '--work--');
    mkdirSync(slug);
    const transcript = join(slug, '2026-01-01T00-00-00-000Z_abc.jsonl');
    writeFileSync(transcript, 'x'.repeat(64));
    const old = (Date.now() - 90 * DAY_MS) / 1000;
    utimesSync(slug, old, old);
    utimesSync(join(root, 'stray.txt'), old, old);
    utimesSync(join(root, 'not a session'), old, old);
    const o = out();
    const code = await runSessionsCommand(
      ['prune', '--keep-days', '30', '--yes'],
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'stray.txt'))).toBe(true);
    expect(existsSync(join(root, 'lock.json'))).toBe(true);
    expect(existsSync(join(root, 'not a session'))).toBe(true);
    expect(existsSync(transcript)).toBe(true);
    expect(o.lines.join('\n')).toContain('nothing to prune');
  });
});

describe('sessions prune, keep-window resolution (issue #119)', () => {
  it('refuses without a window: no flag, no config, no invented default', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(['prune'], {
      sessionsRoot: root,
      out: o.write,
    });
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toContain('--keep-days');
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
  });

  it('refuses malformed flags by name', async () => {
    const root = tmpRoot();
    const cases = [
      ['--keep-days'],
      ['--keep-days', 'thirty'],
      ['--keep-days', '-1'],
      ['--keep-session'],
      ['--keep-session', '../etc'],
      ['--bogus'],
    ];
    for (const args of cases) {
      const o = out();
      const code = await runSessionsCommand(['prune', ...args], {
        sessionsRoot: root,
        out: o.write,
      });
      expect(code, `args ${JSON.stringify(args)}`).toBe(1);
      expect(o.lines.join('\n')).toContain('error:');
    }
  });

  it('keep-days 0 means retention off — never prune', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      ['prune', '--keep-days', '0', '--yes'],
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
    expect(o.lines.join('\n')).toContain('off');
  });

  it('config retentionDays flows in as the default window; the flag overrides it', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-31d', 31 * DAY_MS);
    sessionDir(root, 'aged-29d', 29 * DAY_MS);
    const viaConfig = out();
    const code = await runSessionsCommand(['prune', '--yes'], {
      sessionsRoot: root,
      out: viaConfig.write,
      retentionDays: 30,
    });
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-31d'))).toBe(false);
    expect(existsSync(join(root, 'aged-29d'))).toBe(true);
  });

  it('the explicit flag beats config', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-31d', 31 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      ['prune', '--keep-days', '100', '--yes'],
      { sessionsRoot: root, out: o.write, retentionDays: 30 },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-31d'))).toBe(true);
  });

  it('config retentionDays = 0 is retention off, never prune', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(['prune', '--yes'], {
      sessionsRoot: root,
      out: o.write,
      retentionDays: 0,
    });
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
    expect(o.lines.join('\n')).toContain('off');
  });

  it('the usage line names prune and its flags', async () => {
    const root = tmpRoot();
    const o = out();
    const code = await runSessionsCommand(['--help'], {
      sessionsRoot: root,
      out: o.write,
    });
    expect(code).toBe(0);
    const usage = o.lines.find((line) => line.startsWith('usage: kubic'));
    expect(usage).toContain('prune');
    expect(usage).toContain('--keep-days');
    expect(usage).toContain('--yes');
  });
});
