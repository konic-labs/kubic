// Task-memory store tests, slice 1 (issue #35; §28): session entries.
// Faux-only: in-test Map-backed FileBridge fake (zero network).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FileBridge } from '../../exec/src/file-bridge.js';
import {
  appendSessionEntry,
  deleteTaskMemory,
  dumpMemory,
  forkSessionMemory,
  MAX_ENTRY_TEXT_CHARS,
  MAX_SESSION_ENTRIES,
  MemoryUnavailableError,
  openMemoryStore,
  openSoloMemory,
  openUserMemory,
  openWorkspaceMemory,
  readSessionEntries,
  readTaskMemory,
  updateTaskMemory,
  writeTaskMemory,
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
    exists: (path: string): boolean =>
      files.has(path) ||
      [...files.keys()].some((key) => key.startsWith(`${path}/`)),
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

describe('task memory values (issue #35, §28)', () => {
  it('creates a task record with the seven value fields and reads it back', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    const record = writeTaskMemory(store, 'session-1', 'task-1', {
      objective: 'Implement the widget',
      decisions: ['use X'],
      constraints: ['no network'],
      files: ['src/widget.ts'],
      discoveries: ['seam in skills.ts'],
      failedAttempts: ['tried Y'],
      successfulChanges: ['added Z'],
      artifactIds: ['artifact-1'],
    });
    expect(record.objective).toBe('Implement the widget');
    expect(record.artifacts).toEqual([{ artifactId: 'artifact-1' }]);
    const reread = readTaskMemory(store, 'session-1', 'task-1');
    expect(reread).toEqual(record);
  });

  it('reads undefined for an unknown task and rejects duplicate creates', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    expect(readTaskMemory(store, 'session-1', 'no-such-task')).toBeUndefined();
    writeTaskMemory(store, 'session-1', 'task-1', { objective: 'goal' });
    expect(() =>
      writeTaskMemory(store, 'session-1', 'task-1', { objective: 'again' }),
    ).toThrow(/already exists/);
  });

  it('updates by appending list values and replacing the objective', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    writeTaskMemory(store, 'session-1', 'task-1', {
      objective: 'goal v1',
      decisions: ['use X'],
    });
    const updated = updateTaskMemory(store, 'session-1', 'task-1', {
      objective: 'goal v2',
      decisions: ['also Y'],
      failedAttempts: ['tried Z'],
      artifactIds: ['artifact-9'],
    });
    expect(updated.objective).toBe('goal v2');
    expect(updated.decisions).toEqual(['use X', 'also Y']);
    expect(updated.failedAttempts).toEqual(['tried Z']);
    expect(updated.artifacts).toEqual([{ artifactId: 'artifact-9' }]);
    expect(readTaskMemory(store, 'session-1', 'task-1')).toEqual(updated);
  });

  it('update and delete on a missing task fail explicitly', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    expect(() =>
      updateTaskMemory(store, 'session-1', 'ghost', { objective: 'x' }),
    ).toThrow(/unknown task/);
    expect(() => deleteTaskMemory(store, 'session-1', 'ghost')).toThrow(
      /unknown task/,
    );
  });

  it('deletes a task record so reads return undefined', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    writeTaskMemory(store, 'session-1', 'task-1', { objective: 'goal' });
    deleteTaskMemory(store, 'session-1', 'task-1');
    expect(readTaskMemory(store, 'session-1', 'task-1')).toBeUndefined();
  });
});

describe('fork and inspectable dump (issue #35, §28)', () => {
  it('forks entries and task records into a fresh session', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    appendSessionEntry(store, 'session-1', 'note', 'started work');
    writeTaskMemory(store, 'session-1', 'task-1', {
      objective: 'goal',
      decisions: ['use X'],
      artifactIds: ['artifact-1'],
    });
    const summary = forkSessionMemory(store, 'session-1', 'session-2');
    expect(summary).toEqual({ entries: 1, tasks: ['task-1'] });
    // Resume through a second handle: the fork is durable.
    const resumed = openMemoryStore('memory', bridge);
    expect(readSessionEntries(resumed, 'session-2').map((e) => e.text)).toEqual(
      ['started work'],
    );
    const forked = readTaskMemory(resumed, 'session-2', 'task-1');
    expect(forked?.objective).toBe('goal');
    expect(forked?.sessionId).toBe('session-2');
    expect(forked?.decisions).toEqual(['use X']);
    expect(forked?.artifacts).toEqual([{ artifactId: 'artifact-1' }]);
    // The source session is untouched.
    expect(readTaskMemory(resumed, 'session-1', 'task-1')?.sessionId).toBe(
      'session-1',
    );
  });

  it('fork rejects unknown sources, self-forks, and non-fresh targets', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    expect(() => forkSessionMemory(store, 'ghost', 'fresh')).toThrow(
      /unknown session/,
    );
    appendSessionEntry(store, 'session-1', 'note', 'x');
    expect(() => forkSessionMemory(store, 'session-1', 'session-1')).toThrow(
      /must differ/,
    );
    appendSessionEntry(store, 'taken', 'note', 'y');
    expect(() => forkSessionMemory(store, 'session-1', 'taken')).toThrow(
      /already has/,
    );
  });

  it('dumps entries and tasks as plain JSON with no opaque blobs', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    appendSessionEntry(store, 'session-1', 'decision', 'use X');
    writeTaskMemory(store, 'session-1', 'task-1', {
      objective: 'goal',
      files: ['src/a.ts'],
    });
    const dump = dumpMemory(store, 'session-1');
    expect(dump.sessionId).toBe('session-1');
    expect(dump.entries.map((e) => e.text)).toEqual(['use X']);
    expect(dump.tasks.map((t) => t.taskId)).toEqual(['task-1']);
    // Inspectable: survives a JSON round-trip byte-identical in meaning.
    expect(JSON.parse(JSON.stringify(dump))).toEqual(dump);
  });
});

describe('solo reduction and v1 stubs (issue #35, §28)', () => {
  it('solo runs a full flow through a fork-free facade', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    const solo = openSoloMemory(store, 'session-solo');
    expect('forkSessionMemory' in solo).toBe(false);
    expect(Object.keys(solo).sort()).toEqual(
      [
        'appendEntry',
        'deleteTask',
        'dump',
        'entries',
        'readTask',
        'sessionId',
        'updateTask',
        'writeTask',
      ].sort(),
    );
    solo.appendEntry('note', 'solo continuity');
    solo.writeTask('task-1', { objective: 'solo goal' });
    solo.updateTask('task-1', { decisions: ['decided alone'] });
    expect(solo.entries().map((e) => e.text)).toEqual(['solo continuity']);
    expect(solo.readTask('task-1')?.decisions).toEqual(['decided alone']);
    expect(solo.dump().tasks.map((t) => t.taskId)).toEqual(['task-1']);
    solo.deleteTask('task-1');
    expect(solo.readTask('task-1')).toBeUndefined();
  });

  it('workspace and user memory are explicit not-supported-in-v1 stubs', () => {
    expect(() => openWorkspaceMemory()).toThrow(MemoryUnavailableError);
    expect(() => openUserMemory()).toThrow(MemoryUnavailableError);
    try {
      openWorkspaceMemory();
    } catch (error) {
      expect((error as Error).message).toMatch(/not supported in v1/);
    }
    try {
      openUserMemory();
    } catch (error) {
      expect((error as Error).message).toMatch(/not supported in v1/);
    }
  });

  it('bounds entry text length and session entry count', () => {
    const { bridge } = fakeBridge();
    const store = openMemoryStore('memory', bridge);
    expect(() =>
      appendSessionEntry(
        store,
        'session-1',
        'note',
        'x'.repeat(MAX_ENTRY_TEXT_CHARS + 1),
      ),
    ).toThrow(/too long/);
    for (let i = 0; i < MAX_SESSION_ENTRIES; i += 1) {
      appendSessionEntry(store, 'session-1', 'note', `entry ${i}`);
    }
    expect(() =>
      appendSessionEntry(store, 'session-1', 'note', 'one more'),
    ).toThrow(/too many/);
  });

  it('contains no network, embedding, or preference-learning paths', () => {
    const here = new URL('./memory.ts', import.meta.url);
    const source = readFileSync(here, 'utf8');
    for (const banned of [
      'fetch(',
      'XMLHttpRequest',
      'embedding',
      'vector',
      'preference',
      'node:fs',
      'node:child_process',
      "from 'http",
      'WebSocket',
    ]) {
      expect(source.includes(banned)).toBe(false);
    }
  });
});
