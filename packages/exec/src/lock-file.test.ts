// Exclusive lock-file primitive: the raw I/O half of
// the session lock. Exec owns node:fs (I/O confinement) — the agent's
// session-store keeps the semantics (liveness, stale-steal) and calls these.
// Hermetic: tmp dirs only, no process signalling anywhere.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimLockLink,
  createLockFile,
  looseStateDirMode,
  processStartTimeOf,
  procStartTimeFromStat,
  readLockFile,
  removeLockFile,
  scanStateModes,
  startTimeFromLstart,
  withFileLocked,
} from './lock-file.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tmpFile(name = 'lock.json'): string {
  const root = mkdtempSync(join(tmpdir(), 'lock-file-'));
  roots.push(root);
  return join(root, name);
}

describe('lock file primitive', () => {
  it('creates exclusively and never clobbers an existing lock', () => {
    const path = tmpFile();
    expect(createLockFile(path, '{"pid":1}')).toBe(true);
    expect(readLockFile(path)).toBe('{"pid":1}');
    // O_EXCL: the second create reports the conflict and leaves the content.
    expect(createLockFile(path, '{"pid":2}')).toBe(false);
    expect(readLockFile(path)).toBe('{"pid":1}');
  });

  it('creates the parent directory eagerly (the lock holds the dir open)', () => {
    // Two missing levels: the create itself must make them.
    const nested = tmpFile(join('session', 'fresh', 'lock.json'));
    expect(existsSync(join(nested, '..'))).toBe(false);
    expect(createLockFile(nested, 'x')).toBe(true);
    expect(readLockFile(nested)).toBe('x');
  });

  it('reads missing and torn contents as undefined, never throwing', () => {
    expect(readLockFile(tmpFile('no-such-lock-file.json'))).toBeUndefined();
    const torn = tmpFile();
    writeFileSync(torn, '{"pid": 4242');
    expect(readLockFile(torn)).toBe('{"pid": 4242');
  });

  it('removes idempotently — a missing file is not an error', () => {
    const path = tmpFile();
    expect(createLockFile(path, 'x')).toBe(true);
    removeLockFile(path);
    expect(readLockFile(path)).toBeUndefined();
    expect(() => removeLockFile(path)).not.toThrow(); // second call: still fine
  });
});

// Atomic lock claim: temp file + hard link, so exactly one
// stale-takeover racer lands each generation — the loser sees EEXIST and
// must re-read the winner instead of deleting it.
describe('atomic lock claim', () => {
  it('claims an absent lock and leaves no temp file behind', () => {
    const path = tmpFile();
    expect(claimLockLink(path, '{"pid":1,"nonce":"a"}')).toBe(true);
    expect(readLockFile(path)).toBe('{"pid":1,"nonce":"a"}');
    expect(readdirSync(join(path, '..')).sort()).toEqual(['lock.json']);
  });

  it('loses to an existing occupant without touching it', () => {
    const path = tmpFile();
    writeFileSync(path, '{"pid":9}');
    expect(claimLockLink(path, '{"pid":1}')).toBe(false);
    expect(readLockFile(path)).toBe('{"pid":9}');
    expect(readdirSync(join(path, '..')).sort()).toEqual(['lock.json']);
  });

  it('a temp-name collision retries with a fresh name', () => {
    const path = tmpFile();
    const dir = dirname(path);
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      // Squat on the attempt-0 temp name: the claim must not throw the
      // raw EEXIST, it must retry under a fresh name and still land. The
      // squat itself stays (it is the test's, not the claim's litter) —
      // what must not survive is the claim's own attempt-1 temp.
      const squatName = `.lock.tmp.${process.pid}.${now.toString(36)}.0.${Math.floor(0.5 * 1e9).toString(36)}`;
      writeFileSync(join(dir, squatName), 'squat');
      expect(claimLockLink(path, '{"pid":1}')).toBe(true);
      expect(readLockFile(path)).toBe('{"pid":1}');
      expect(readdirSync(dir).sort()).toEqual([squatName, 'lock.json']);
    } finally {
      nowSpy.mockRestore();
      randSpy.mockRestore();
    }
  });
});

// Process start time: the pid-reuse guard behind the stale rule. Linux reads
// /proc, macOS asks ps; anywhere else the lock falls back to the pid probe.
describe('process start time', () => {
  (process.platform === 'darwin' ? it : it.skip)(
    "reads this process's start from ps, the same on every read",
    () => {
      const start = processStartTimeOf(process.pid);
      expect(start).toBeDefined();
      const uptimeStart = Date.now() - process.uptime() * 1000;
      expect(Math.abs((start as number) - uptimeStart)).toBeLessThan(60_000);
      expect(processStartTimeOf(process.pid)).toBe(start);
      // Another live process: its parent, read through the same path.
      expect(processStartTimeOf(process.ppid)).toBeDefined();
    },
  );

  // A claim naming a live pid whose recorded start is not that process's
  // start belongs to a holder that is gone: the pid was reused.
  (processStartTimeOf(process.pid) === undefined ? it.skip : it)(
    'takes over a file lock whose live pid started at another time',
    () => {
      const path = tmpFile('index.lock');
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, startedAt: 1, nonce: 'gone' }),
      );
      expect(withFileLocked(path, () => 'ran', { waitMs: 200 })).toBe('ran');
    },
  );

  it('parses ps lstart output as a UTC instant, refusing anything else', () => {
    expect(startTimeFromLstart('Wed Oct 21 06:04:15 2026    \n')).toBe(
      Date.UTC(2026, 9, 21, 6, 4, 15),
    );
    expect(startTimeFromLstart('Mon Jan  5 00:00:01 2026')).toBe(
      Date.UTC(2026, 0, 5, 0, 0, 1),
    );
    expect(startTimeFromLstart('')).toBeUndefined();
    expect(startTimeFromLstart('Wed Foo 21 06:04:15 2026')).toBeUndefined();
    expect(startTimeFromLstart('21 Oct 2026 06:04')).toBeUndefined();
  });

  (process.platform === 'linux' && processStartTimeOf(process.pid) !== undefined
    ? it
    : it.skip)("reads this process's start from /proc", () => {
    const start = processStartTimeOf(process.pid);
    expect(start).toBeDefined();
    const uptimeStart = Date.now() - process.uptime() * 1000;
    expect(Math.abs((start as number) - uptimeStart)).toBeLessThan(60_000);
  });

  it('returns undefined for pids that cannot exist', () => {
    expect(processStartTimeOf(2 ** 31)).toBeUndefined();
    expect(processStartTimeOf(0)).toBeUndefined();
    expect(processStartTimeOf(-4)).toBeUndefined();
  });

  it('parses starttime as field 22 past a comm holding spaces and parens', () => {
    // Fields after `comm`: state(3) ppid(4) pgrp(5) session(6) tty(7)
    // tpgid(8) flags(9) minflt(10) cminflt(11) majflt(12) cmajflt(13)
    // utime(14) stime(15) cutime(16) cstime(17) priority(18) nice(19)
    // num_threads(20) itrealvalue(21) starttime(22) = 12345 ticks.
    const stat =
      '4242 (my proc (weird)) S 0 1 1 0 -1 4194560 100 0 0 0 50 25 0 0 20 0 4 0 12345 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0';
    expect(procStartTimeFromStat(stat, 1_700_000_000_000)).toBe(
      1_700_000_000_000 + 12345 * 10,
    );
  });

  it('rejects stat texts without a comm close or a numeric starttime', () => {
    expect(procStartTimeFromStat('no parens here', 1000)).toBeUndefined();
    expect(procStartTimeFromStat('1 (x) S', 1000)).toBeUndefined();
  });
});

// The probe is POSIX-only — Windows cannot change the mode it
// reports, so a warn there would name a fix that does nothing.
describe('looseStateDirMode platform gate', () => {
  it('reports nothing on win32 even for a loose directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loose-'));
    roots.push(dir);
    chmodSync(dir, 0o755);

    expect(looseStateDirMode(dir)).toBe(0o755);
    const spy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32' as NodeJS.Platform);
    try {
      expect(looseStateDirMode(dir)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

// What `kubic doctor` reads for its private-state check: every directory of
// the walked state 0700, every file 0600, symlinks not followed, bounded.
describe('scanStateModes', () => {
  function stateTree(): string {
    const root = mkdtempSync(join(tmpdir(), 'state-modes-'));
    roots.push(root);
    chmodSync(root, 0o700);
    const session = join(root, 'session-a');
    mkdirSync(join(session, 'journal', 'blobs'), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(join(session, 'main.jsonl'), '{}\n', { mode: 0o600 });
    writeFileSync(join(session, 'journal', 'index.jsonl'), '', { mode: 0o600 });
    return root;
  }

  it.skipIf(process.platform === 'win32')('passes a private tree', () => {
    const scan = scanStateModes([], [stateTree()]);
    expect(scan).toMatchObject({ loose: [], count: 0, truncated: false });
    expect(scan?.checked).toBeGreaterThan(4);
  });

  it.skipIf(process.platform === 'win32')(
    'names a loose root, session dir, journal dir and file with the expected mode',
    () => {
      const root = stateTree();
      chmodSync(join(root, 'session-a', 'journal'), 0o755);
      chmodSync(join(root, 'session-a', 'main.jsonl'), 0o644);
      const scan = scanStateModes([], [root]);
      expect(scan?.count).toBe(2);
      expect(scan?.loose).toEqual(
        expect.arrayContaining([
          {
            path: join(root, 'session-a', 'journal'),
            mode: 0o755,
            expected: 0o700,
          },
          {
            path: join(root, 'session-a', 'main.jsonl'),
            mode: 0o644,
            expected: 0o600,
          },
        ]),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'checks single paths alone, skips absent ones, and never follows a link',
    () => {
      const root = stateTree();
      const outside = mkdtempSync(join(tmpdir(), 'state-modes-out-'));
      roots.push(outside);
      chmodSync(outside, 0o755);
      symlinkSync(outside, join(root, 'session-a', 'link'));
      const trust = join(root, 'trust.json');
      writeFileSync(trust, '{}', { mode: 0o644 });
      const scan = scanStateModes([trust, join(root, 'absent')], [root]);
      expect(scan?.loose.map((entry) => entry.path)).toEqual([trust]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'stops at its bound and says so',
    () => {
      const root = stateTree();
      for (let index = 0; index < 20; index += 1) {
        writeFileSync(join(root, `f${index}`), '', { mode: 0o644 });
      }
      const scan = scanStateModes([], [root], { limit: 8, keep: 3 });
      expect(scan?.truncated).toBe(true);
      expect(scan?.checked).toBe(8);
      expect(scan?.loose).toHaveLength(3);
      expect(scan?.count).toBeGreaterThanOrEqual(3);
    },
  );
});
