// Edit size guard (issue #122, slice 1; §9.1).
// edit must refuse files above EDIT_MAX_BYTES (8 MiB) with a named
// `file_too_large` OpError BEFORE any content allocation — a huge edit is
// one tool call away and today it allocates the whole file.

import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ExecutionEnv,
  NodeExecutionEnv,
  ROOT_PROVENANCE,
} from '../../../exec/src/env.js';
import type { FileJournalStore } from '../../../exec/src/journal.js';
import { editOperation } from './edit.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import type { OpContext, ToolInvocation } from './types.js';

const MIB = 1024 * 1024;

let dir: string;
let readCalls: number;
let journalAppends: number;
let ctx: OpContext;

function inv(id = 'inv-1'): ToolInvocation {
  return createInvocation(
    { invocationId: id, operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kubic-edit-bounds-'));
  readCalls = 0;
  journalAppends = 0;
  const base = new NodeExecutionEnv(dir);
  const fs = base.fs;
  const env: ExecutionEnv = {
    cwd: dir,
    provenance: ROOT_PROVENANCE,
    shell: base.shell,
    withProvenance: base.withProvenance.bind(base),
    fs: {
      // Counting wrapper: the guard must refuse before readFile is reached.
      readFile: (path: string) => {
        readCalls += 1;
        return fs.readFile(path);
      },
      writeFile: (path: string, content: string) => fs.writeFile(path, content),
      rename: (from: string, to: string) => fs.rename(from, to),
      listDir: (path: string) => fs.listDir(path),
      stat: (path: string) => fs.stat(path),
    },
  };
  const journal = {
    append: () => {
      journalAppends += 1;
    },
  } as unknown as FileJournalStore;
  ctx = { env, sessionId: 's1', agentId: 'a1', journal };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Sparse fixture: logical size without real bytes (ftruncate).
function sparseFile(name: string, bytes: number): void {
  const handle = openSync(join(dir, name), 'w');
  try {
    ftruncateSync(handle, bytes);
  } finally {
    closeSync(handle);
  }
}

describe('edit size guard (issue #122)', () => {
  it('refuses a file just over 8 MiB with file_too_large before any content allocation', async () => {
    sparseFile('big.txt', 8 * MIB + 1);
    let caught: unknown;
    try {
      await editOperation.execute(
        inv(),
        { path: 'big.txt', oldText: 'needle', newText: 'hay' },
        ctx,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: 'OpError', code: 'file_too_large' });
    // The error names the size so the model knows what it hit.
    expect((caught as Error).message).toContain(String(8 * MIB + 1));
    // Refusal is pre-allocation: the content is never read...
    expect(readCalls).toBe(0);
    // ...and the journal is untouched.
    expect(journalAppends).toBe(0);
  });

  it('still edits a file of exactly 8 MiB', async () => {
    // Exactly at the bound: real content with one occurrence of oldText.
    const handle = openSync(join(dir, 'edge.txt'), 'w');
    try {
      ftruncateSync(handle, 8 * MIB);
      writeSync(
        handle,
        Buffer.from('EDITME'),
        0,
        'EDITME'.length,
        8 * MIB - 'EDITME'.length,
      );
    } finally {
      closeSync(handle);
    }
    const out = await editOperation.execute(
      inv(),
      { path: 'edge.txt', oldText: 'EDITME', newText: 'ok' },
      ctx,
    );
    expect(out.replacements).toBe(1);
    expect(journalAppends).toBe(1);
    expect(readCalls).toBe(1);
    // The replacement landed at the tail of the file.
    const edited = readFileSync(join(dir, 'edge.txt'), 'utf8');
    expect(edited.length).toBe(8 * MIB - 'EDITME'.length + 'ok'.length);
    expect(edited.endsWith('ok')).toBe(true);
  });

  it('keeps the not_found refusal for missing files', async () => {
    await expect(
      editOperation.execute(
        inv(),
        { path: 'ghost.txt', oldText: 'needle', newText: 'hay' },
        ctx,
      ),
    ).rejects.toMatchObject({ name: 'OpError', code: 'not_found' });
  });
});
