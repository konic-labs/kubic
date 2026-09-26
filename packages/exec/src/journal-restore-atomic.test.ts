// Restore atomicity (issue #117, slice 2): `kubic undo` must never leave a
// half-written file — that is the worst possible failure mode for a recovery
// tool, and the write/edit ops have taken tmp+rename care for years while
// restoreEntry wrote in place. A crash mid-restore now leaves the target
// untouched and at most a `<target>.kubic-restore-<pid>.tmp` sibling, which
// the failed write cleans up best-effort.
//
// RED: restoreEntry writes the target file directly, so a torn write lands
// on the real file and no `.kubic-restore-*` path ever exists.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FileBridge } from './file-bridge.js';
import { FileJournalStore, restoreEntry } from './journal.js';

const hooks = vi.hoisted(() => ({
  // Force writeFile to land a torn prefix and throw (crash-mid-write).
  tornWrite: null as null | ((path: string) => boolean),
  // Force renameFile to throw for matching destinations (crash-before-rename).
  failRename: null as null | ((destination: string) => boolean),
}));

vi.mock('./file-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-bridge.js')>();
  return {
    ...actual,
    createNodeFileBridge: (cwd: string): FileBridge => {
      const bridge = actual.createNodeFileBridge(cwd);
      return {
        ...bridge,
        renameFile: (source: string, destination: string): void => {
          if (hooks.failRename?.(destination) === true) {
            throw new Error('simulated crash before rename');
          }
          bridge.renameFile(source, destination);
        },
        writeFile: (path: string, content: string | Uint8Array): void => {
          if (hooks.tornWrite?.(path) === true) {
            bridge.writeFile(path, String(content).slice(0, 4));
            throw new Error('simulated crash mid-write');
          }
          bridge.writeFile(path, content);
        },
      };
    },
  };
});

function restoreLitter(root: string): string[] {
  return readdirSync(root).filter((name) => name.includes('.kubic-restore-'));
}

function seed(): {
  store: FileJournalStore;
  root: string;
  recorded: ReturnType<FileJournalStore['append']>;
} {
  const store = new FileJournalStore(mkdtempSync(join(tmpdir(), 'j-')));
  const root = mkdtempSync(join(tmpdir(), 'ws-'));
  writeFileSync(join(root, 'f.txt'), 'v2\n');
  const recorded = store.append({
    path: 'f.txt',
    op: 'write',
    before: 'v1\n',
    after: 'v2\n',
    bytesDelta: 0,
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    timestamp: 100,
  });
  return { store, root, recorded };
}

describe('restore atomicity (issue #117, slice 2)', () => {
  it('a crash mid-write leaves the target untouched and no .kubic-restore-* litter', () => {
    const { store, root, recorded } = seed();
    hooks.tornWrite = (path) => path.includes('.kubic-restore-');
    try {
      const result = restoreEntry(store, recorded, root);
      expect(result.restored).toBe(false);
      expect(result.restored === false && result.reason).toContain(
        'restore write failed',
      );
    } finally {
      hooks.tornWrite = null;
    }
    // The half-written content landed on the tmp, never the real file.
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v2\n');
    expect(restoreLitter(root)).toEqual([]);
  });

  it('a rename failure after a complete tmp write leaves the target untouched and no litter', () => {
    const { store, root, recorded } = seed();
    hooks.failRename = (destination) => destination.endsWith('f.txt');
    try {
      const result = restoreEntry(store, recorded, root);
      expect(result.restored).toBe(false);
      expect(result.restored === false && result.reason).toContain(
        'restore write failed',
      );
    } finally {
      hooks.failRename = null;
    }
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v2\n');
    expect(restoreLitter(root)).toEqual([]);
  });

  it('a successful restore writes the before-content and leaves no tmp behind', () => {
    const { store, root, recorded } = seed();
    expect(restoreEntry(store, recorded, root)).toEqual({ restored: true });
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v1\n');
    expect(restoreLitter(root)).toEqual([]);
  });
});
