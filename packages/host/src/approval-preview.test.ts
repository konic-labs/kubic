// The change an edit or write ask would make: the approval
// card's diff preview, computed against the file on disk.
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PREVIEW_MAX_BYTES,
  approvalPreview,
} from './approval-preview.js';

function files(contents: Record<string, string>) {
  return {
    exists: (path: string) => path in contents,
    fileInfo: (path: string) => {
      const text = contents[path];
      if (text === undefined) throw new Error('ENOENT');
      return {
        name: path,
        path,
        isDirectory: false,
        isSymbolicLink: false,
        isFile: true,
        size: text.length,
        mtimeMs: 0,
      };
    },
    readTextFile: (path: string) => {
      const text = contents[path];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
  };
}

describe('approval preview', () => {
  const disk = files({
    'src/cart.js': 'a\r\nexisting.qty = qty;\r\nb\r\nqty\r\n',
  });

  it('diffs an edit against the file, in the edit tool display form', () => {
    expect(
      approvalPreview(disk, 'edit', {
        path: 'src/cart.js',
        oldText: 'qty = qty',
        newText: 'qty += qty',
      }),
    ).toMatchObject({
      kind: 'diff',
      text: ' 1 a\n-2 existing.qty = qty;\n+2 existing.qty += qty;\n 3 b\n 4 qty',
      added: 1,
      removed: 1,
    });
  });

  it('mirrors the edit tool on the match count', () => {
    const twice = files({ 'a.txt': 'x\ny\nx\n' });
    // Two matches where the edit expects one: the edit will be refused
    // (ambiguous_match), so there is no change to preview.
    expect(
      approvalPreview(twice, 'edit', {
        path: 'a.txt',
        oldText: 'x',
        newText: 'z',
      }),
    ).toBeUndefined();
    expect(
      approvalPreview(twice, 'edit', {
        path: 'a.txt',
        oldText: 'x',
        newText: 'z',
        expectCount: 2,
      }),
    ).toMatchObject({ added: 2, removed: 2 });
  });

  it('never reads a pipe, a device, a link or an oversized file', () => {
    const reads: string[] = [];
    const bridge = (info: { isFile?: boolean; size: number }) => ({
      exists: () => true,
      fileInfo: (path: string) => ({
        name: path,
        path,
        isDirectory: false,
        isSymbolicLink: false,
        mtimeMs: 0,
        ...info,
      }),
      readTextFile: (path: string) => {
        // A synchronous read of a FIFO blocks until a writer opens it.
        reads.push(path);
        return 'x';
      },
    });
    const fifo = bridge({ isFile: false, size: 0 });
    const huge = bridge({ isFile: true, size: APPROVAL_PREVIEW_MAX_BYTES + 1 });
    for (const disk of [fifo, huge]) {
      expect(
        approvalPreview(disk, 'edit', {
          path: 'p',
          oldText: 'x',
          newText: 'y',
        }),
      ).toBeUndefined();
      expect(
        approvalPreview(disk, 'write', { path: 'p', content: 'y' }),
      ).toBeUndefined();
    }
    expect(reads).toEqual([]);
  });

  it('shows a new file by its lines and an overwrite as a diff', () => {
    expect(
      approvalPreview(disk, 'write', { path: 'new.md', content: 'one\ntwo\n' }),
    ).toEqual({ kind: 'write', newFile: true, lines: 2, preview: 'one\ntwo' });
    expect(
      approvalPreview(disk, 'write', { path: 'src/cart.js', content: 'a\n' }),
    ).toMatchObject({ kind: 'diff', removed: 3 });
  });

  it('gives no preview it cannot stand behind', () => {
    // Missing file, a stale oldText, bad args, an unreadable file, other tools.
    expect(
      approvalPreview(disk, 'edit', {
        path: 'gone.js',
        oldText: 'a',
        newText: 'b',
      }),
    ).toBeUndefined();
    expect(
      approvalPreview(disk, 'edit', {
        path: 'src/cart.js',
        oldText: 'not there',
        newText: 'b',
      }),
    ).toBeUndefined();
    expect(approvalPreview(disk, 'edit', { path: 3 })).toBeUndefined();
    expect(
      approvalPreview(
        {
          exists: () => true,
          fileInfo: () => {
            throw new Error('EACCES');
          },
          readTextFile: () => {
            throw new Error('EACCES');
          },
        },
        'write',
        { path: 'dir', content: 'x' },
      ),
    ).toBeUndefined();
    expect(approvalPreview(disk, 'bash', { command: 'ls' })).toBeUndefined();
  });
});
