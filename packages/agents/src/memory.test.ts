// Task-memory store tests, slice 1 (issue #35; §28): session entries.
// Faux-only: in-test Map-backed FileBridge fake (zero network).
import { describe, expect, it } from 'vitest';
import type { FileBridge } from '../../exec/src/file-bridge.js';
import {
  appendSessionEntry,
  openMemoryStore,
  readSessionEntries,
} from './memory.js';

function fakeBridge(): { bridge: FileBridge; files: Map<string, string> } {
  const files = new Map<string, string>();
  const bridge: FileBridge = {
    cwd: '/fake',
    absolutePath: (path: string): string => path,
    joinPath: (parts: string[]): string => parts.join('/'),
    readTextFile: (path: string): string => {
      const hit = files.get(path);
      if (hit === undefined) throw new Error(`fake fs: no such file: ${path}`);
      return hit;
    },
    readBinaryFile: (path: string): Uint8Array =>
      new TextEncoder().encode(bridge.readTextFile(path)),
    readTextLines: (path: string, maxLines?: number): string[] => {
      const lines = bridge.readTextFile(path).split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return maxLines === undefined ? lines : lines.slice(0, maxLines);
    },
    openTextLineReader: (path: string) => {
      const lines = bridge.readTextLines(path);
      let index = 0;
      return {
        readLine: (): string | undefined =>
          index < lines.length ? lines[index++] : undefined,
        close: (): void => undefined,
      };
    },
    writeFile: (path: string, content: string | Uint8Array): void => {
      files.set(path, typeof content === 'string' ? content : '{}');
    },
    appendFile: (path: string, content: string | Uint8Array): void => {
      const prior = files.get(path) ?? '';
      files.set(path, prior + (typeof content === 'string' ? content : '{}'));
    },
    renameFile: (source: string, destination: string): void => {
      const hit = files.get(source);
      if (hit === undefined)
        throw new Error(`fake fs: no such file: ${source}`);
      files.delete(source);
      files.set(destination, hit);
    },
    fileInfo: (path: string) => ({
      name: path.split('/').pop() ?? path,
      path,
      isDirectory: false,
      isSymbolicLink: false,
      size: 0,
      mtimeMs: 0,
    }),
    listDir: (path: string) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => {
          const name = key.slice(path.length + 1).split('/')[0] ?? key;
          return {
            name,
            path: `${path}/${name}`,
            isDirectory: false,
            isSymbolicLink: false,
            size: 0,
            mtimeMs: 0,
          };
        }),
    exists: (path: string): boolean => files.has(path),
    createDir: (_path: string): void => undefined,
    remove: (path: string): void => {
      files.delete(path);
    },
    createTempDir: (): string => '/fake/tmp',
    createTempFile: (): string => '/fake/tmp-file',
  };
  return { bridge, files };
}

describe('session memory entries (issue #35, §28)', () => {
  it('appends entries with sequence numbers and reads them back', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    const first = appendSessionEntry(
      store,
      'session-1',
      'note',
      'started work',
    );
    const second = appendSessionEntry(store, 'session-1', 'decision', 'use X');
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(second.kind).toBe('decision');
  });

  it('reads entries back and survives resume through a second handle', () => {
    const { bridge } = fakeBridge();
    const writer = openMemoryStore('memory', bridge);
    appendSessionEntry(writer, 'session-1', 'note', 'started work');
    appendSessionEntry(writer, 'session-1', 'discovery', 'found the seam');
    const resumed = openMemoryStore('memory', bridge);
    const entries = readSessionEntries(resumed, 'session-1');
    expect(entries.map((entry) => entry.text)).toEqual([
      'started work',
      'found the seam',
    ]);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('reads an empty list for an unknown session', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    expect(readSessionEntries(store, 'no-such-session')).toEqual([]);
  });

  it('rejects empty entry text and unsafe session ids', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    expect(() => appendSessionEntry(store, 'session-1', 'note', '  ')).toThrow(
      /non-empty/,
    );
    expect(() => appendSessionEntry(store, '../escape', 'note', 'x')).toThrow(
      /session id/,
    );
    expect(() => readSessionEntries(store, 'a/b')).toThrow(/session id/);
  });
});
