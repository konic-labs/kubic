// Exit after the std streams drain: `process.exit()` right after a large
// write can truncate piped stdout (pipes are async on macOS), so the root
// waits for each stream's write callback before exiting — bounded by a
// fallback timer, and silent on a closed pipe (EPIPE).
import { describe, expect, it } from 'vitest';
import { exitAfterFlush, type FlushableStream } from './exit.js';

type Listener = (error: Error & { code?: string }) => void;

function stream(): FlushableStream & {
  flush: () => void;
  fail: (code: string) => void;
} {
  const pending: Array<() => void> = [];
  const listeners: Listener[] = [];
  return {
    write: (_chunk: string, callback: () => void) => {
      pending.push(callback);
      return false;
    },
    on: (_event: 'error', listener: Listener) => {
      listeners.push(listener);
    },
    flush: () => {
      for (const callback of pending.splice(0)) callback();
    },
    fail: (code: string) => {
      const error = Object.assign(new Error(code), { code });
      for (const listener of listeners) listener(error);
    },
  };
}

interface FakeTimer {
  fire: () => void;
  unrefCalled: boolean;
}

function timers(): {
  schedule: (fn: () => void, ms: number) => { unref: () => void };
  last: () => FakeTimer;
} {
  let current: FakeTimer | undefined;
  return {
    schedule: (fn) => {
      const timer: FakeTimer = { fire: fn, unrefCalled: false };
      current = timer;
      return {
        unref: () => {
          timer.unrefCalled = true;
        },
      };
    },
    last: () => {
      if (current === undefined) throw new Error('no timer scheduled');
      return current;
    },
  };
}

describe('exitAfterFlush', () => {
  it('exits only after stdout and stderr have flushed', () => {
    const stdout = stream();
    const stderr = stream();
    const exits: number[] = [];
    exitAfterFlush(3, {
      stdout,
      stderr,
      exit: (code) => exits.push(code),
      schedule: timers().schedule,
    });
    expect(exits).toEqual([]);
    stdout.flush();
    expect(exits).toEqual([]);
    stderr.flush();
    expect(exits).toEqual([3]);
  });

  it('sets the exit code first, so an early natural exit keeps it', () => {
    const codes: number[] = [];
    exitAfterFlush(6, {
      stdout: stream(),
      stderr: stream(),
      exit: () => undefined,
      setExitCode: (code) => codes.push(code),
      schedule: timers().schedule,
    });
    expect(codes).toEqual([6]);
  });

  it('a reader that never drains cannot hang the process: an unref’d fallback exits', () => {
    const clock = timers();
    const exits: number[] = [];
    exitAfterFlush(2, {
      stdout: stream(),
      stderr: stream(),
      exit: (code) => exits.push(code),
      schedule: clock.schedule,
    });
    expect(clock.last().unrefCalled).toBe(true);
    clock.last().fire();
    expect(exits).toEqual([2]);
  });

  it('a closed pipe (EPIPE) exits silently with the intended code', () => {
    const stdout = stream();
    const exits: number[] = [];
    exitAfterFlush(0, {
      stdout,
      stderr: stream(),
      exit: (code) => exits.push(code),
      schedule: timers().schedule,
    });
    expect(() => stdout.fail('EPIPE')).not.toThrow();
    expect(exits).toEqual([0]);
  });

  it('exits once even when the flush and the fallback both fire', () => {
    const stdout = stream();
    const stderr = stream();
    const clock = timers();
    const exits: number[] = [];
    exitAfterFlush(1, {
      stdout,
      stderr,
      exit: (code) => exits.push(code),
      schedule: clock.schedule,
    });
    stdout.flush();
    stderr.flush();
    clock.last().fire();
    expect(exits).toEqual([1]);
  });
});
