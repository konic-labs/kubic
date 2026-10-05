// Exclusive lock-file primitive (issue #118; §21–§22): the raw I/O half of
// the session lock. Exec owns node:fs (I/O confinement, §9) — the worker's
// session-store keeps the semantics (liveness, stale-steal) and calls these.
// Hermetic: tmp dirs only, no process signalling anywhere.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
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

describe('lock file primitive (issue #118)', () => {
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

// Atomic lock claim (issue #145): temp file + hard link, so exactly one
// stale-takeover racer lands each generation — the loser sees EEXIST and
// must re-read the winner instead of deleting it.
describe('atomic lock claim (issue #145)', () => {
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

  it('a temp-name collision retries with a fresh name (#424)', () => {
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

// Process start time (issue #145): the pid-reuse guard behind the stale
// rule. Linux-only: /proc is the only portable-enough source, and anywhere
// else the lock falls back to the pid probe.
describe('process start time (issue #145)', () => {
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

// Issue #361: the probe is POSIX-only — Windows cannot change the mode it
// reports, so a warn there would name a fix that does nothing.
describe('looseStateDirMode platform gate (issue #361)', () => {
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
