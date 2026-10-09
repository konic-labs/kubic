// The lock acquire over a scripted lock-file seam: the steal path's
// conditional clear compares unconditionally (a live lock landing after an
// absent read is never removed — the absent observation licenses nothing),
// and a lock this attempt landed never outlives a failed acquire.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kubic/exec/lock-file', () => ({
  claimLockLink: vi.fn(() => true),
  createLockFile: vi.fn(() => false),
  processStartTimeOf: vi.fn(() => undefined),
  readLockFile: vi.fn(() => undefined),
  removeLockFile: vi.fn(),
  tightenStateDir: vi.fn(),
}));

import {
  claimLockLink,
  createLockFile,
  readLockFile,
  removeLockFile,
} from '@kubic/exec/lock-file';
import { acquireSessionLock, SessionLockError } from './lock.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('steal conditional clear', () => {
  it('never removes a live lock that lands after an absent read', () => {
    const FAKE_PID = 424242;
    const rival = JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() });
    // Read (fresh-path holder check): nothing there — not live, so the
    // steal path is entered. Read (steal's observed): still nothing.
    // Read (conditional-clear re-read): the rival's live lock landed.
    // Every later read keeps reporting the rival.
    const reads: (string | undefined)[] = [undefined, undefined, rival];
    vi.mocked(readLockFile).mockImplementation(() =>
      reads.length > 0 ? (reads.shift() as string | undefined) : rival,
    );
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => 0) as never);
    try {
      let caught: unknown;
      try {
        // No session dir is touched: every seam call is mocked above.
        acquireSessionLock('/no-such-dir', 'sess-review');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionLockError);
      expect((caught as Error).message).toContain(String(FAKE_PID));
    } finally {
      kill.mockRestore();
    }
    // The absent read licenses no remove: the rival's live lock is never
    // deleted and no claim is attempted on top of it.
    expect(removeLockFile).not.toHaveBeenCalled();
    expect(claimLockLink).not.toHaveBeenCalled();
  });

  it('EPERM counts as alive: a lock of another uid is never stolen', () => {
    const FAKE_PID = 424243;
    const rival = JSON.stringify({ pid: FAKE_PID, startedAt: Date.now() });
    // No procStart on the rival: liveness is the pid probe alone, and the
    // probe throws EPERM (process exists, other uid) instead of ESRCH.
    vi.mocked(readLockFile).mockReturnValue(rival);
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    }) as never);
    try {
      let caught: unknown;
      try {
        acquireSessionLock('/no-such-dir', 'sess-eperm');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionLockError);
      expect((caught as Error).message).toContain(String(FAKE_PID));
    } finally {
      kill.mockRestore();
    }
    expect(removeLockFile).not.toHaveBeenCalled();
    expect(claimLockLink).not.toHaveBeenCalled();
  });
});

describe('a failed acquire', () => {
  it('removes the lock it landed when the verify read throws', () => {
    // The create lands this attempt's bytes, then the verify read fails:
    // no handle ever received the nonce, so only the acquire can remove it.
    let landed: string | undefined;
    vi.mocked(createLockFile).mockImplementation((_path, payload) => {
      landed = payload;
      return true;
    });
    let reads = 0;
    vi.mocked(readLockFile).mockImplementation(() => {
      reads++;
      if (reads === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return landed;
    });
    expect(() => acquireSessionLock('/no-such-dir', 'sess-io')).toThrow('EIO');
    expect(removeLockFile).toHaveBeenCalledWith('/no-such-dir/lock.json');
  });

  it('leaves a lock alone that is not provably its own', () => {
    vi.mocked(createLockFile).mockReturnValue(true);
    const other = JSON.stringify({ pid: 1, startedAt: 0, nonce: 'theirs' });
    let reads = 0;
    vi.mocked(readLockFile).mockImplementation(() => {
      reads++;
      if (reads === 1) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return other;
    });
    expect(() => acquireSessionLock('/no-such-dir', 'sess-io')).toThrow('EIO');
    expect(removeLockFile).not.toHaveBeenCalled();
  });
});
