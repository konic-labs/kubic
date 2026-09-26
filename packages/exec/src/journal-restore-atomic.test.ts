// Restore atomicity (issue #117, slice 2): `kubic undo` must never leave a
// half-written file — that is the worst possible failure mode for a recovery
// tool, and the write/edit ops have taken tmp+rename care for years while
// restoreEntry wrote in place. A crash mid-restore now leaves the target
// untouched and at most a `<target>.kubic-restore-<pid>.tmp` sibling, which
// the failed write cleans up best-effort.
//
// RED: restoreEntry writes the target file directly, so a torn write lands
// on the real file and no `.kubic-restore-*` path ever exists.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  // Force the best-effort tmp cleanup to fail too: the crash residue a power
  // loss leaves behind (write throws AND the remove never runs).
  failRemove: null as null | ((path: string) => boolean),
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
        remove: (path: string, recursive?: boolean, force?: boolean): void => {
          if (hooks.failRemove?.(path) === true) {
            throw new Error('simulated crash before tmp cleanup');
          }
          bridge.remove(path, recursive, force);
        },
        writeFile: (
          path: string,
          content: string | Uint8Array,
          options?: { mode?: number },
        ): void => {
          if (hooks.tornWrite?.(path) === true) {
            bridge.writeFile(path, String(content).slice(0, 4), options);
            throw new Error('simulated crash mid-write');
          }
          bridge.writeFile(path, content, options);
        },
      };
    },
  };
});

function restoreLitter(root: string): string[] {
  return readdirSync(root).filter((name) => name.includes('.kubic-restore-'));
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
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

// Issue #117 review fix 2: the tmp+rename restore must not reset the target's
// mode (main's in-place writeFileSync preserved the inode's mode; the rename
// replaces the inode with the tmp's) and must not leave world-readable crash
// residue behind. The tmp is created 0600, the existing target's mode is
// copied onto it before the rename, and a successful restore sweeps stale
// `<target>.kubic-restore-*.tmp` siblings.
// RED: the tmp is created with the umask default (0644 here), so a 0600 file
// becomes 0644, a 755 script loses its exec bit, and crash residue is 0644.
describe('restore mode preservation + residue sweep (issue #117 review)', () => {
  it('keeps a 0600 target at 0600 across the restore', () => {
    const { store, root, recorded } = seed();
    chmodSync(join(root, 'f.txt'), 0o600);
    expect(restoreEntry(store, recorded, root)).toEqual({ restored: true });
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v1\n');
    expect(modeOf(join(root, 'f.txt'))).toBe(0o600);
  });

  it('keeps a 755 script executable across the restore', () => {
    const { store, root, recorded } = seed();
    chmodSync(join(root, 'f.txt'), 0o755);
    expect(restoreEntry(store, recorded, root)).toEqual({ restored: true });
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v1\n');
    expect(modeOf(join(root, 'f.txt'))).toBe(0o755);
  });

  it('crash residue is never world-readable: the tmp is created 0600, not 0644', () => {
    const { store, root, recorded } = seed();
    // A 0644 target (the umask default): a crash mid-write, where the
    // best-effort cleanup fails too, leaves the torn tmp behind — it must
    // sit at the restrictive creation mode, never the umask default.
    hooks.tornWrite = (path) => path.includes('.kubic-restore-');
    hooks.failRemove = (path) => path.includes('.kubic-restore-');
    try {
      const result = restoreEntry(store, recorded, root);
      expect(result.restored).toBe(false);
      expect(result.restored === false && result.reason).toContain(
        'restore write failed',
      );
    } finally {
      hooks.tornWrite = null;
      hooks.failRemove = null;
    }
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v2\n');
    const residue = restoreLitter(root);
    expect(residue).toHaveLength(1);
    expect(modeOf(join(root, residue[0] ?? ''))).toBe(0o600);
  });

  it('a recreated target keeps the restrictive default even when a same-pid tmp is stale', () => {
    const { store, root, recorded } = seed();
    // Pre-fix residue (or pid reuse) sitting at the umask default under this
    // process's exact tmp name: the recreate path has no target mode to copy,
    // so the stale mode must not leak into the recreated file.
    const staleSamePid = join(root, `f.txt.kubic-restore-${process.pid}.tmp`);
    writeFileSync(staleSamePid, 'old residue\n');
    rmSync(join(root, 'f.txt'));
    expect(restoreEntry(store, recorded, root)).toEqual({ restored: true });
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v1\n');
    expect(modeOf(join(root, 'f.txt'))).toBe(0o600);
    expect(existsSync(staleSamePid)).toBe(false);
  });

  it('a successful restore sweeps stale .kubic-restore-*.tmp siblings of its target', () => {
    const { store, root, recorded } = seed();
    // Residue a previous crash (another pid) left behind for this target,
    // plus two controls that must never be touched: another target's
    // residue, and a name that does not match the sweep pattern.
    const stale = join(root, 'f.txt.kubic-restore-99999.tmp');
    writeFileSync(stale, 'old torn content\n');
    const otherTarget = join(root, 'g.txt.kubic-restore-99999.tmp');
    writeFileSync(otherTarget, 'other target residue\n');
    const unrelated = join(root, 'f.txt.tmp');
    writeFileSync(unrelated, 'not ours\n');
    expect(restoreEntry(store, recorded, root)).toEqual({ restored: true });
    expect(readFileSync(join(root, 'f.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(otherTarget, 'utf8')).toBe('other target residue\n');
    expect(readFileSync(unrelated, 'utf8')).toBe('not ours\n');
    expect(restoreLitter(root)).toEqual(['g.txt.kubic-restore-99999.tmp']);
  });
});
