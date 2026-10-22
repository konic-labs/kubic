// The cross-process mutation lock. A claim lands atomically and names its
// holder (pid, process start time, a nonce); a waiter takes the lock away
// only when that holder is gone, never from a live one; a steal runs under a
// guard so two waiters never both take a gone holder's lock; and a release
// removes only the claim's own lock. Real temp dirs; the exclusion test runs
// the bundled module in worker threads that contend for one counter.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withFileLocked } from './lock-file.js';

const hooks = vi.hoisted(() => ({ failTempWrite: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (hooks.failTempWrite && String(args[0]).includes('.lock.tmp.')) {
        // A full disk: the temp is created, then the write fails.
        actual.writeFileSync(args[0], '');
        const error: NodeJS.ErrnoException = new Error('no space left');
        error.code = 'ENOSPC';
        throw error;
      }
      return actual.writeFileSync(...args);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  hooks.failTempWrite = false;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function lockPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'with-lock-'));
  roots.push(root);
  return join(root, 'sub', 'index.jsonl.lock');
}

// A pid that names no process: one that ran and exited.
function goneProcessPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid as number;
}

function plant(path: string, payload: string, ageMs = 0): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, payload);
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
}

describe('withFileLocked', () => {
  it('names its holder while held and removes the lock after', () => {
    const path = lockPath();
    const held = withFileLocked(path, () => readFileSync(path, 'utf8'));
    expect(JSON.parse(held)).toMatchObject({ pid: process.pid });
    expect(existsSync(path)).toBe(false);
  });

  it('leaves neither a lock nor a temp behind when the claim cannot be written', () => {
    const path = lockPath();
    hooks.failTempWrite = true;
    expect(() => withFileLocked(path, () => 'body')).toThrow(/no space left/);
    expect(readdirSync(dirname(path))).toEqual([]);
    hooks.failTempWrite = false;
    expect(withFileLocked(path, () => 'next')).toBe('next');
  });

  it('never takes a live holder’s lock, however old it is', () => {
    const path = lockPath();
    const live = JSON.stringify({ pid: process.pid, nonce: 'other' });
    plant(path, live, 60_000);
    expect(() => withFileLocked(path, () => 'body', { waitMs: 50 })).toThrow(
      /timed out waiting for lock/,
    );
    expect(readFileSync(path, 'utf8')).toBe(live);
  });

  it('takes a gone holder’s lock at once', () => {
    const path = lockPath();
    plant(path, JSON.stringify({ pid: goneProcessPid(), nonce: 'gone' }));
    expect(withFileLocked(path, () => 'body', { waitMs: 50 })).toBe('body');
    expect(existsSync(path)).toBe(false);
  });

  it('reads an older build’s bare pid by its process, and unreadable bytes by age', () => {
    const live = lockPath();
    plant(live, String(process.pid), 60_000);
    expect(() => withFileLocked(live, () => 'x', { waitMs: 50 })).toThrow(
      /timed out/,
    );
    const gone = lockPath();
    plant(gone, String(goneProcessPid()));
    expect(withFileLocked(gone, () => 'x', { waitMs: 50 })).toBe('x');
    const fresh = lockPath();
    plant(fresh, '{torn');
    expect(() =>
      withFileLocked(fresh, () => 'x', { waitMs: 50, staleMs: 10_000 }),
    ).toThrow(/timed out/);
    const old = lockPath();
    plant(old, '{torn', 60_000);
    expect(withFileLocked(old, () => 'x', { staleMs: 10_000 })).toBe('x');
  });

  it('never removes a lock that changed hands while it ran', () => {
    const path = lockPath();
    const successor = JSON.stringify({ pid: process.pid, nonce: 'successor' });
    withFileLocked(path, () => writeFileSync(path, successor));
    expect(readFileSync(path, 'utf8')).toBe(successor);
  });

  it('clears a steal guard whose holder is gone, so a waiter cannot wedge it', () => {
    const path = lockPath();
    plant(path, JSON.stringify({ pid: goneProcessPid(), nonce: 'gone' }));
    plant(
      `${path}.steal`,
      JSON.stringify({ pid: goneProcessPid(), nonce: 'g' }),
    );
    expect(withFileLocked(path, () => 'body', { waitMs: 500 })).toBe('body');
    expect(existsSync(`${path}.steal`)).toBe(false);
  });
});

describe('withFileLocked across threads', () => {
  // The module as plain JS, so a worker thread can load it.
  function bundledModule(): string {
    const dir = mkdtempSync(join(tmpdir(), 'with-lock-bundle-'));
    roots.push(dir);
    const outfile = join(dir, 'lock-file.cjs');
    buildSync({
      entryPoints: [join(import.meta.dirname, 'lock-file.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      logLevel: 'silent',
    });
    return outfile;
  }

  // Each thread adds to the counter `rounds` times, read-sleep-write: a lock
  // that let two threads in at once loses an update and the total falls
  // short.
  async function contend(
    lock: string,
    counter: string,
    threads: number,
    rounds: number,
  ): Promise<void> {
    const module = bundledModule();
    const code = `
      const { readFileSync, writeFileSync } = require('node:fs');
      const { workerData } = require('node:worker_threads');
      const { withFileLocked } = require(workerData.module);
      for (let round = 0; round < workerData.rounds; round += 1) {
        withFileLocked(workerData.lock, () => {
          const value = Number(readFileSync(workerData.counter, 'utf8'));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          writeFileSync(workerData.counter, String(value + 1));
        }, { waitMs: 20000 });
      }`;
    await Promise.all(
      Array.from(
        { length: threads },
        () =>
          new Promise<void>((resolve, reject) => {
            const worker = new Worker(code, {
              eval: true,
              workerData: { module, lock, counter, rounds },
            });
            worker.once('error', reject);
            worker.once('exit', (exitCode) =>
              exitCode === 0
                ? resolve()
                : reject(new Error(`worker exited ${exitCode}`)),
            );
          }),
      ),
    );
  }

  it('lets exactly one thread in at a time, a gone holder’s lock included', {
    timeout: 30_000,
  }, async () => {
    const lock = lockPath();
    const counter = join(dirname(dirname(lock)), 'counter');
    writeFileSync(counter, '0');
    // Every thread starts against a gone holder's lock, so they race to
    // take it away.
    plant(lock, JSON.stringify({ pid: goneProcessPid(), nonce: 'gone' }));
    await contend(lock, counter, 4, 25);
    expect(readFileSync(counter, 'utf8')).toBe('100');
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.steal`)).toBe(false);
  });
});
