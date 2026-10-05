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
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { effectiveConfigView } from '../../../packages/host/src/config/runtime.js';
import {
  runSessionsCommand,
  type SessionsInvocation,
} from '../../../packages/host/src/sessions-cli.js';
import { planSessionPrune } from '../../../packages/host/src/sessions-prune.js';
import { loadCliConfig, sessionRetentionDays } from './config-runtime.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FAKE_PID = 424243;
// The plan→delete window test's two holders: one flips dead→live between
// the passes, one stays dead throughout.
const FLIP_PID = 424251;
const DEAD_PID = 424252;

const made: string[] = [];

function tmpRoot(prefix = 'prune-'): string {
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

function lockFile(
  root: string,
  id: string,
  pid: number,
  ageMs: number,
): number {
  const startedAt = Date.now() - ageMs;
  writeFileSync(
    join(root, id, 'lock.json'),
    JSON.stringify({ pid, startedAt }),
  );
  return startedAt;
}

type PruneFlags = Omit<
  Extract<SessionsInvocation, { command: 'prune' }>,
  'command'
>;

function prune(
  root: string,
  flags: PruneFlags,
  extra: {
    retentionDays?: number;
    now?: () => number;
    confirm?: (message: string) => Promise<boolean | null>;
  } = {},
): Promise<{ code: number; lines: string[] }> {
  const o = out();
  return runSessionsCommand(
    { command: 'prune', ...flags },
    {
      sessionsRoot: root,
      out: o.write,
      ...extra,
    },
  ).then((code) => ({ code, lines: o.lines }));
}

describe('sessions prune, dry-run default (issue #119)', () => {
  it('lists candidates and deletes nothing without --yes', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-one', 31 * DAY_MS);
    sessionDir(root, 'fresh-one', 60 * 60 * 1000);
    const { code, lines } = await prune(root, { keepDays: 30 });
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
    const { code, lines } = await prune(root, { dryRun: true, keepDays: 30 });
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
    const dry = await prune(root, { keepDays: 30 });
    const listed = dry.lines
      .filter((line) => line.startsWith('would prune '))
      .map((line) => line.split(' ')[2] as string);
    expect(listed.sort()).toEqual(['aged-a', 'aged-b']);
    const { code } = await prune(root, { keepDays: 30, yes: true });
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
      { command: 'prune', keepDays: 30, yes: true, dryRun: true },
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(2);
    expect(o.lines.join('\n')).toContain('--dry-run');
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
  });
});

describe('sessions prune, interactive confirmation', () => {
  it('asks once on a terminal and deletes on yes', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 40 * DAY_MS);
    const asked: string[] = [];
    const { code, lines } = await prune(
      root,
      { keepDays: 30 },
      {
        confirm: async (message) => {
          asked.push(message);
          return true;
        },
      },
    );
    expect(code).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Delete 1 session\(s\) \(\d+B\)\?$/);
    expect(existsSync(join(root, 'aged-a'))).toBe(false);
    expect(lines.join('\n')).toContain('pruned 1 session(s)');
  });

  it('keeps everything on no or cancel (the dry-run report)', async () => {
    for (const answer of [false, null]) {
      const root = tmpRoot();
      sessionDir(root, 'aged-a', 40 * DAY_MS);
      const { code, lines } = await prune(
        root,
        { keepDays: 30 },
        { confirm: async () => answer },
      );
      expect(code).toBe(0);
      expect(existsSync(join(root, 'aged-a'))).toBe(true);
      expect(lines.join('\n')).toContain('dry run: 1 session(s)');
    }
  });

  it('never asks under --dry-run or --yes', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 40 * DAY_MS);
    const never = async (): Promise<boolean> => {
      throw new Error('must not prompt');
    };
    const dry = await prune(
      root,
      { keepDays: 30, dryRun: true },
      { confirm: never },
    );
    expect(dry.code).toBe(0);
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
    const yes = await prune(
      root,
      { keepDays: 30, yes: true },
      { confirm: never },
    );
    expect(yes.code).toBe(0);
    expect(existsSync(join(root, 'aged-a'))).toBe(false);
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
    const { code } = await prune(
      root,
      { keepDays: 30, yes: true },
      {
        now: () => now,
      },
    );
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
      { command: 'prune', keepDays: 30, yes: true },
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(0);
    expect(existsSync(dir)).toBe(true);
    expect(o.lines.join('\n')).toContain('nothing to prune');
  });

  it('a missing sessions root is a fresh machine: nothing to prune, exit 0', async () => {
    const root = join(tmpRoot(), 'not-created-yet');
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune', keepDays: 30 },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    expect(code).toBe(0);
    expect(o.lines.join('\n')).toContain('nothing to prune');
  });

  it('a malformed sessions root refuses by name, exit 1', async () => {
    const root = tmpRoot();
    const notADir = join(root, 'sessions');
    writeFileSync(notADir, 'not a directory');
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune', keepDays: 30 },
      {
        sessionsRoot: notADir,
        out: o.write,
      },
    );
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toContain(notADir);
    expect(o.lines.join('\n')).toContain('error:');
  });
});

describe('sessions prune, one bucket per session (issue #419)', () => {
  it('a locked session whose header cannot be statted is locked, not unreadable', async () => {
    const root = tmpRoot();
    sessionDir(root, 'locked-dark', 90 * DAY_MS);
    lockFile(root, 'locked-dark', FAKE_PID, 90 * DAY_MS);
    const kill = stubKill(true);
    try {
      // The lock reads fine (live holder); only the stat fails.
      const real = createNodeFileBridge(root);
      const plan = planSessionPrune({
        root,
        bridge: {
          ...real,
          fileInfo: (path: string) => {
            if (path === 'locked-dark') throw new Error('EACCES');
            return real.fileInfo(path);
          },
        },
        keepDays: 30,
        keep: [],
      });
      expect(plan.locked.map((entry) => entry.id)).toEqual(['locked-dark']);
      expect(plan.unreadable).toEqual([]);
    } finally {
      kill.mockRestore();
    }
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
        { command: 'prune', keepDays: 30, yes: true },
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
        { command: 'prune', keepDays: 30, yes: true },
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
      { command: 'prune', keepDays: 30, keepSession: ['keep-me'], yes: true },
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
      { command: 'prune', keepDays: 30, yes: true },
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

describe('sessions prune, bash spill files (issue #182)', () => {
  // A clipped bash stream spills into <sessionDir>/spill/. The prune's whole
  // effect on a candidate is one recursive remove, so the spill goes with the
  // session — pinned here through the real CLI path (runSessionsCommand →
  // deleteSessionPruneCandidates), not by reproducing the remove.
  it('removes a session together with its spill files', async () => {
    const root = tmpRoot();
    const dir = sessionDir(root, 'with-spills', 90 * DAY_MS);
    mkdirSync(join(dir, 'spill'), { recursive: true });
    const spill = join(dir, 'spill', `0001-stdout-${FAKE_PID}.log`);
    writeFileSync(spill, 'x'.repeat(10));
    // mkdir/writeFile bump the dir mtime: re-age it.
    const secs = (Date.now() - 90 * DAY_MS) / 1000;
    utimesSync(dir, secs, secs);
    const kill = stubKill(false);
    try {
      const { code, lines } = await prune(root, { keepDays: 30, yes: true });
      expect(code).toBe(0);
      expect(existsSync(spill)).toBe(false);
      expect(existsSync(dir)).toBe(false);
      expect(lines.join('\n')).toContain('pruned with-spills');
    } finally {
      kill.mockRestore();
    }
  });
});

describe('sessions prune, the plan→delete window (issue #119)', () => {
  // Per-pid call counting drives the window deterministically: a holder
  // reads dead on the planning pass (its first liveness call) and live on
  // the delete re-check (its second). No timing, no real process.
  function stubKillAliveFromCall(
    aliveFromCall: Map<number, number>,
  ): ReturnType<typeof vi.spyOn> {
    const calls = new Map<number, number>();
    return vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      const call = (calls.get(pid) ?? 0) + 1;
      calls.set(pid, call);
      const threshold = aliveFromCall.get(pid);
      if (threshold !== undefined && call >= threshold) return 0;
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }) as never);
  }

  it('a lock acquired between planning and the delete stops that delete and is reported', async () => {
    const root = tmpRoot();
    const flipDir = sessionDir(root, 'flip-live', 90 * DAY_MS);
    const deadDir = sessionDir(root, 'stays-dead', 90 * DAY_MS);
    const flippedAt = lockFile(root, 'flip-live', FLIP_PID, 90 * DAY_MS);
    const deadAt = lockFile(root, 'stays-dead', DEAD_PID, 90 * DAY_MS);
    // lock.json writes bump the dir mtime: re-age both dirs afterwards.
    const secs = (Date.now() - 90 * DAY_MS) / 1000;
    utimesSync(flipDir, secs, secs);
    utimesSync(deadDir, secs, secs);
    // lock.json rides inside the state dir, so it counts toward its bytes.
    const deadBytes =
      15 + JSON.stringify({ pid: DEAD_PID, startedAt: deadAt }).length;
    const kill = stubKillAliveFromCall(new Map([[FLIP_PID, 2]]));
    try {
      const o = out();
      const code = await runSessionsCommand(
        { command: 'prune', keepDays: 30, yes: true },
        { sessionsRoot: root, out: o.write },
      );
      expect(code).toBe(0);
      const text = o.lines.join('\n');
      // The candidate whose lock went live is not removed...
      expect(existsSync(flipDir)).toBe(true);
      // ...and is reported exactly like a planning-time lock.
      expect(text).toContain(
        `locked: flip-live (held by pid ${FLIP_PID} since ${new Date(flippedAt).toISOString()}) — skipped`,
      );
      expect(text).not.toContain('pruned flip-live');
      // A candidate still dead at its own delete is removed and counted.
      expect(existsSync(deadDir)).toBe(false);
      expect(text).toContain(`pruned stays-dead (${deadBytes}B)`);
      // Honest accounting: the skipped candidate is not counted as pruned.
      expect(text).toContain(`pruned 1 session(s), ${deadBytes}B reclaimed`);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('sessions prune, keep-window resolution (issue #119)', () => {
  it('refuses without a window: no flag, no config, no invented default', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune' },
      {
        sessionsRoot: root,
        out: o.write,
      },
    );
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toContain('--keep-days');
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
  });

  it('keep-days 0 means retention off — never prune', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune', keepDays: 0, yes: true },
      { sessionsRoot: root, out: o.write },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
    expect(o.lines.join('\n')).toContain('off');
  });

  it('config retentionDays flows in as the default window', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-31d', 31 * DAY_MS);
    sessionDir(root, 'aged-29d', 29 * DAY_MS);
    const viaConfig = out();
    const code = await runSessionsCommand(
      { command: 'prune', yes: true },
      {
        sessionsRoot: root,
        out: viaConfig.write,
        retentionDays: 30,
      },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-31d'))).toBe(false);
    expect(existsSync(join(root, 'aged-29d'))).toBe(true);
  });

  it('the explicit flag beats config', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-31d', 31 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune', keepDays: 100, yes: true },
      { sessionsRoot: root, out: o.write, retentionDays: 30 },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-31d'))).toBe(true);
  });

  it('config retentionDays = 0 is retention off, never prune', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune', yes: true },
      {
        sessionsRoot: root,
        out: o.write,
        retentionDays: 0,
      },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
    expect(o.lines.join('\n')).toContain('off');
  });
});

describe('sessions prune, config flow (issue #119)', () => {
  // A real config load (global layer under a tmp home), the composition
  // root's seam, then the CLI — the same chain `kubic sessions prune` runs.
  function loadedHome(retention?: string): string {
    const home = tmpRoot('home-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    if (retention !== undefined) {
      writeFileSync(
        join(home, '.kubic', 'config.toml'),
        `[session]\nretentionDays = ${retention}\n`,
      );
    }
    return home;
  }

  it('session.retentionDays becomes the default window', async () => {
    const root = tmpRoot();
    sessionDir(root, 'aged-31d', 31 * DAY_MS);
    sessionDir(root, 'aged-29d', 29 * DAY_MS);
    const loaded = loadCliConfig({
      home: loadedHome('30'),
      cwd: tmpRoot('cwd-'),
      env: {},
    });
    expect(loaded.error).toBeUndefined();
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune', yes: true },
      {
        sessionsRoot: root,
        out: o.write,
        retentionDays: sessionRetentionDays(loaded),
      },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-31d'))).toBe(false);
    expect(existsSync(join(root, 'aged-29d'))).toBe(true);
  });

  it('reports the key through the effective-config view (kubic config)', () => {
    const loaded = loadCliConfig({
      home: loadedHome('30'),
      cwd: tmpRoot('cwd-'),
      env: {},
    });
    const runtime = loaded.runtime;
    if (runtime === undefined) throw new Error(loaded.error ?? 'refused');
    const view = effectiveConfigView(runtime);
    const value = view.values.find(
      (entry) => entry.key === 'session.retentionDays',
    );
    expect(value?.value).toBe('30');
    expect(value?.layer).toBe('global');
  });

  it('unset config means no window: prune refuses, deletes nothing', async () => {
    const loaded = loadCliConfig({
      home: loadedHome(),
      cwd: tmpRoot('cwd-'),
      env: {},
    });
    expect(sessionRetentionDays(loaded)).toBeUndefined();
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune', yes: true },
      {
        sessionsRoot: root,
        out: o.write,
        retentionDays: sessionRetentionDays(loaded),
      },
    );
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toContain('--keep-days');
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
  });

  it('a refused config leaves no window either: prune refuses, deletes nothing (issue #242)', async () => {
    // A typo refuses the whole load, so sessionRetentionDays is undefined
    // exactly like the unset case — prune still demands --keep-days.
    const home = tmpRoot('home-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[session]\nretentionDays = 30\n[nope]\nkey = 1\n',
    );
    const loaded = loadCliConfig({
      home,
      cwd: tmpRoot('cwd-'),
      env: {},
    });
    expect(loaded.runtime).toBeUndefined();
    expect(loaded.error).toContain('nope');
    expect(sessionRetentionDays(loaded)).toBeUndefined();
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune', yes: true },
      {
        sessionsRoot: root,
        out: o.write,
        retentionDays: sessionRetentionDays(loaded),
      },
    );
    expect(code).toBe(1);
    expect(o.lines.join('\n')).toContain('--keep-days');
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
  });

  describe('sessions prune treats a run as a unit (issue #164)', () => {
    // A session-shaped dir WITH a listing header + storage marker, so the
    // planner's parent map sees it exactly as listSessions would.
    function runSession(
      root: string,
      id: string,
      ageMs: number,
      parent?: string,
    ): void {
      sessionDir(root, id, 0);
      writeFileSync(
        join(root, id, 'session.json'),
        `${JSON.stringify({
          v: 1,
          kind: 'kubic.session',
          id,
          cwd: '/repo',
          createdAt: new Date(Date.now() - ageMs).toISOString(),
          ...(parent === undefined ? {} : { parentSessionId: parent }),
        })}\n`,
      );
      writeFileSync(join(root, id, 'main.jsonl'), '');
      const secs = (Date.now() - ageMs) / 1000;
      utimesSync(join(root, id), secs, secs);
    }

    it('keeps a recent child while its parent is old (the run is as young as its youngest member)', async () => {
      const root = tmpRoot();
      runSession(root, 'orch-1', 40 * DAY_MS);
      runSession(root, 'orch-1-aaa', 60 * 60 * 1000, 'orch-1');
      const { code, lines } = await prune(root, { keepDays: 30 });
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('nothing to prune');
      expect(existsSync(join(root, 'orch-1'))).toBe(true);
      expect(existsSync(join(root, 'orch-1-aaa'))).toBe(true);
    });

    it('prunes an old run together: parent and children are candidates in the same run', async () => {
      const root = tmpRoot();
      runSession(root, 'orch-1', 40 * DAY_MS);
      runSession(root, 'orch-1-aaa', 40 * DAY_MS, 'orch-1');
      runSession(root, 'orch-1-bbb', 40 * DAY_MS, 'orch-1');
      runSession(root, 'solo-9', 40 * DAY_MS);
      const { code, lines } = await prune(root, { keepDays: 30 });
      expect(code).toBe(0);
      const text = lines.join('\n');
      for (const id of ['orch-1', 'orch-1-aaa', 'orch-1-bbb', 'solo-9']) {
        expect(text).toContain(`would prune ${id}`);
      }
    });

    it('a live-locked child keeps its aged parent (review #164)', async () => {
      const root = tmpRoot();
      runSession(root, 'orch-1', 40 * DAY_MS);
      runSession(root, 'orch-1-aaa', 60 * 60 * 1000, 'orch-1');
      // The child is mid-run: its lock is live, so it is reported locked
      // — but its mtime still counts toward the family's age.
      lockFile(root, 'orch-1-aaa', FAKE_PID, 60 * 60 * 1000);
      const kill = stubKill(true);
      try {
        const { code, lines } = await prune(root, { keepDays: 30 });
        expect(code).toBe(0);
        const text = lines.join('\n');
        expect(text).toContain('locked: orch-1-aaa');
        expect(text).not.toContain('would prune orch-1');
        expect(existsSync(join(root, 'orch-1'))).toBe(true);
      } finally {
        kill.mockRestore();
      }
    });

    it('keeps the children of an explicitly kept parent', async () => {
      const root = tmpRoot();
      runSession(root, 'orch-1', 40 * DAY_MS);
      runSession(root, 'orch-1-aaa', 40 * DAY_MS, 'orch-1');
      const { code } = await prune(root, {
        keepDays: 30,
        keepSession: ['orch-1'],
        yes: true,
      });
      expect(code).toBe(0);
      expect(existsSync(join(root, 'orch-1'))).toBe(true);
      expect(existsSync(join(root, 'orch-1-aaa'))).toBe(true);
    });
  });

  it('retentionDays = 0 flows through as retention off', async () => {
    const loaded = loadCliConfig({
      home: loadedHome('0'),
      cwd: tmpRoot('cwd-'),
      env: {},
    });
    expect(sessionRetentionDays(loaded)).toBe(0);
    const root = tmpRoot();
    sessionDir(root, 'aged-a', 90 * DAY_MS);
    const o = out();
    const code = await runSessionsCommand(
      { command: 'prune', yes: true },
      {
        sessionsRoot: root,
        out: o.write,
        retentionDays: sessionRetentionDays(loaded),
      },
    );
    expect(code).toBe(0);
    expect(existsSync(join(root, 'aged-a'))).toBe(true);
    expect(o.lines.join('\n')).toContain('off');
  });
});
