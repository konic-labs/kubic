import { mkdtempSync } from 'node:fs';
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
