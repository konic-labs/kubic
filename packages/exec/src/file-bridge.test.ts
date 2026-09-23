import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFileBridge } from './file-bridge.js';

function tmpBridge() {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-'));
  return { cwd, bridge: createNodeFileBridge(cwd) };
}

describe('node file bridge (issue #14, slice A)', () => {
  it('writes, reads, appends, and lists', () => {
    const { bridge } = tmpBridge();
    bridge.writeFile('a.txt', 'one\n');
    bridge.appendFile('a.txt', 'two\n');
    expect(bridge.readTextFile('a.txt')).toBe('one\ntwo\n');
    expect(bridge.readTextLines('a.txt', 1)).toEqual(['one']);
    expect(bridge.listDir('.').map((entry) => entry.name)).toContain('a.txt');
  });

  it('reads lines through a line reader', () => {
    const { bridge } = tmpBridge();
    bridge.writeFile('b.txt', 'x\ny\n');
    const reader = bridge.openTextLineReader('b.txt');
    expect(reader.readLine()).toBe('x');
    expect(reader.readLine()).toBe('y');
    reader.close();
  });

  it('stats, creates dirs, renames, and removes', () => {
    const { bridge } = tmpBridge();
    bridge.createDir('sub');
    expect(bridge.exists('sub')).toBe(true);
    expect(bridge.fileInfo('sub').isDirectory).toBe(true);
    bridge.writeFile('sub/c.txt', 'hi');
    expect(bridge.fileInfo('sub/c.txt').size).toBe(2);
    bridge.renameFile('sub/c.txt', 'sub/d.txt');
    expect(bridge.exists('sub/d.txt')).toBe(true);
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
  });

  it('creates parent directories on write and sanitizes temp prefixes', () => {
    const { bridge } = tmpBridge();
    bridge.writeFile('deep/nested/f.txt', 'hi');
    expect(bridge.readTextFile('deep/nested/f.txt')).toBe('hi');
    const dir = bridge.createTempDir('../../evil');
    expect(dir.startsWith(tmpdir())).toBe(true);
    const file = bridge.createTempFile('p', '.log');
    expect(bridge.exists(file)).toBe(true);
  });
});
