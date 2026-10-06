// updateFileLocked + createTempFile/readFileRange durability (issue #360):
// the stale-lock break, the contention timeout, release when update()
// throws, tmp cleanup when rename fails, cross-process serialization, the
// EEXIST temp retry and short reads past EOF. Real temp dirs, zero network,
// zero paid tokens; every temp dir and child process cleaned in afterEach.
import { type ChildProcess, spawn } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge, updateFileLocked } from './file-bridge.js';

const BRIDGE_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  'file-bridge.ts',
);

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already exited: the exit listener below settles the duty.
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-lock-'));
  dirs.push(dir);
  return dir;
}

function runChild(script: string): Promise<void> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: 'ignore',
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`lock child exited with code ${code}`)),
    );
  });
}

describe('updateFileLocked failure paths (issue #360)', () => {
  it('breaks a stale lock and applies the update', () => {
    const dir = scratch();
    const file = join(dir, 'state.json');
    writeFileSync(file, '{"n":1}');
    const lock = `${file}.lock`;
    writeFileSync(lock, '999999999');
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);
    updateFileLocked(file, (current) => `${current ?? ''}+`, {
      staleMs: 1_000,
    });
    expect(readFileSync(file, 'utf8')).toBe('{"n":1}+');
    expect(existsSync(lock)).toBe(false);
  });

  it('times out on a fresh foreign lock and leaves it in place', () => {
    const dir = scratch();
    const file = join(dir, 'state.json');
    writeFileSync(file, 'kept');
    const lock = `${file}.lock`;
    writeFileSync(lock, String(process.pid));
    expect(() =>
      updateFileLocked(file, () => 'clobbered', {
        staleMs: 60_000,
        waitMs: 50,
      }),
    ).toThrow(/timed out waiting for lock/);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('kept');
  });

  it('a throwing update leaves no lock, no tmp sibling, and the file unchanged', () => {
    const dir = scratch();
    const file = join(dir, 'state.json');
    writeFileSync(file, 'kept');
    expect(() =>
      updateFileLocked(file, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(
      readdirSync(dir).filter(
        (name) => name.endsWith('.lock') || name.includes('.tmp.'),
      ),
    ).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('kept');
    // An absent file stays absent when the update throws.
    const missing = join(dir, 'missing.json');
    expect(() =>
      updateFileLocked(missing, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(missing)).toBe(false);
  });

  it('removes the tmp file when the rename fails, leaving the target intact', () => {
    const dir = scratch();
    const file = join(dir, 'victim.txt');
    writeFileSync(file, 'before');
    // Read-succeed-then-rename-fail: the callback swaps the regular file
    // for a non-empty dir, so the pre-read succeeds, the tmp write lands,
    // and only the rename onto the dir fails — exercising the rmSync(tmp)
    // catch (a dir target from the start would throw EISDIR in the
    // pre-read and never reach the rename).
    expect(() =>
      updateFileLocked(file, () => {
        rmSync(file);
        mkdirSync(file);
        writeFileSync(join(file, 'k'), 'k');
        return 'after';
      }),
    ).toThrow();
    expect(readdirSync(dir).filter((name) => name.includes('.tmp.'))).toEqual(
      [],
    );
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(readFileSync(join(file, 'k'), 'utf8')).toBe('k');
  });

  it('two child processes doing 50 increments each end at 100', async () => {
    const dir = scratch();
    const file = join(dir, 'counter.json');
    writeFileSync(file, '0');
    const script = [
      `const { updateFileLocked } = await import(${JSON.stringify(BRIDGE_SOURCE)});`,
      `for (let i = 0; i < 50; i += 1) {`,
      `  updateFileLocked(${JSON.stringify(file)}, (cur) => String(Number(cur) + 1));`,
      `}`,
    ].join('\n');
    await Promise.all([runChild(script), runChild(script)]);
    expect(readFileSync(file, 'utf8')).toBe('100');
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});

describe('temp + range primitives (issue #360)', () => {
  it('createTempFile retries on EEXIST and returns attempt 1', () => {
    const { bridge } = (() => {
      const cwd = scratch();
      return { bridge: createNodeFileBridge(cwd) };
    })();
    const first = bridge.createTempFile('kubic-360-', '.tmp');
    dirs.push(first);
    const second = bridge.createTempFile('kubic-360-', '.tmp');
    dirs.push(second);
    // The first call occupies attempt 0, so the second skips to attempt 1.
    expect(second).not.toBe(first);
    expect(second).toContain(`${process.pid}-1`);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
  });

  it('readFileRange past EOF returns a short buffer', () => {
    const cwd = scratch();
    const bridge = createNodeFileBridge(cwd);
    const readFileRange = bridge.readFileRange;
    if (readFileRange === undefined)
      throw new Error('node bridge lacks readFileRange');
    bridge.writeFile('f.bin', 'hello');
    expect(Buffer.from(readFileRange('f.bin', 0, 5)).toString()).toBe('hello');
    const past = readFileRange('f.bin', 2, 100);
    expect(past.length).toBe(3);
    expect(Buffer.from(past).toString()).toBe('llo');
  });
});
