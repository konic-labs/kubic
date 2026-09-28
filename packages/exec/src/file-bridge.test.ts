import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeFileBridge } from './file-bridge.js';

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function tmpBridge() {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-'));
  created.push(cwd);
  return { cwd, bridge: createNodeFileBridge(cwd) };
}

describe('node file bridge (issue #14, slice A)', () => {
  it('writes, reads, appends, and lists', () => {
    const { bridge } = tmpBridge();
    bridge.writeFile('a.txt', 'one\n');
    bridge.appendFile('a.txt', 'two\n');
    expect(bridge.readTextFile('a.txt')).toBe('one\ntwo\n');
    expect(bridge.readTextLines('a.txt', 1)).toEqual(['one']);
    expect(bridge.listDir('.').map((entry) => entry.name)).toEqual(['a.txt']);
  });

  it('stats, creates dirs, renames, and removes', () => {
    const { bridge } = tmpBridge();
    bridge.createDir('sub');
    expect(bridge.exists('sub')).toBe(true);
    expect(bridge.fileInfo('sub').isDirectory).toBe(true);
    bridge.writeFile('sub/c.txt', 'hi');
    expect(bridge.fileInfo('sub/c.txt').size).toBe(2);
    bridge.renameFile('sub/c.txt', 'sub/d.txt');
    expect(bridge.exists('sub/c.txt')).toBe(false);
    expect(bridge.readTextFile('sub/d.txt')).toBe('hi');
    bridge.remove('sub', true);
    expect(bridge.exists('sub')).toBe(false);
  });
});

describe('node file bridge hardening (review #14)', () => {
  it('does not follow symlinks in fileInfo', () => {
    const { bridge } = tmpBridge();
    bridge.writeFile('real.txt', 'data');
    symlinkSync('real.txt', join(bridge.cwd, 'link.txt'));
    const info = bridge.fileInfo('link.txt');
    expect(info.isSymbolicLink).toBe(true);
    expect(info.isDirectory).toBe(false);
  });

  it('drops the trailing-newline phantom line', () => {
    const { bridge } = tmpBridge();
    bridge.writeFile('c.txt', 'x\ny\n');
    expect(bridge.readTextLines('c.txt')).toEqual(['x', 'y']);
    const reader = bridge.openTextLineReader('c.txt');
    expect(reader.readLine()).toBe('x');
    expect(reader.readLine()).toBe('y');
    expect(reader.readLine()).toBeUndefined();
    reader.close();
  });

  it('creates parent directories on write and sanitizes temp prefixes', () => {
    const { bridge } = tmpBridge();
    bridge.writeFile('deep/nested/f.txt', 'hi');
    expect(bridge.readTextFile('deep/nested/f.txt')).toBe('hi');
    const dir = bridge.createTempDir('../../evil');
    created.push(dir);
    // Directly under tmpdir: the `..` segments never climbed out of it.
    expect(dirname(dir)).toBe(tmpdir());
    const file = bridge.createTempFile('../p', '/../.log');
    created.push(file);
    expect(dirname(file)).toBe(tmpdir());
    expect(bridge.exists(file)).toBe(true);
  });
});
