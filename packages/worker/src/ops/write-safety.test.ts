// Write/edit safety on the node seam: mode preservation across tmp+rename,
// no lossy pre-image for binary files, journal intent before the rename.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeExecutionEnv } from '../../../exec/src/env.js';
import { FileJournalStore } from '../../../exec/src/journal.js';
import { diffEntries } from '../../../exec/src/journal-diff.js';
import { journalStatus } from '../../../exec/src/journal-status.js';
import { applyUndo, planUndo } from '../../../exec/src/journal-undo.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function setup(): { root: string; journal: FileJournalStore; c: OpContext } {
  const root = tmp('ws-');
  const journal = new FileJournalStore(tmp('j-'));
  const c: OpContext = {
    env: new NodeExecutionEnv(root),
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    journal,
  };
  return { root, journal, c };
}

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

const posix = process.platform !== 'win32';

describe('write/edit safety on the node seam', () => {
  it.runIf(posix)('write preserves an existing file mode', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    writeFileSync(join(root, 'secret'), 'a\n');
    chmodSync(join(root, 'secret'), 0o600);
    await callOperation(
      'write',
      { path: 'run.sh', content: 'echo\n' },
      inv(),
      c,
    );
    await callOperation('write', { path: 'secret', content: 'b\n' }, inv(), c);
    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'secret')).mode & 0o777).toBe(0o600);
  });

  it.runIf(posix)('edit preserves an existing file mode', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'run.sh'), 'echo a\n');
    chmodSync(join(root, 'run.sh'), 0o755);
    const out = await callOperation(
      'edit',
      { path: 'run.sh', oldText: 'a', newText: 'b' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    expect(statSync(join(root, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('overwriting a binary file never records a lossy pre-image; undo refuses instead of mangling', async () => {
    const { root, journal, c } = setup();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80]);
    writeFileSync(join(root, 'img.png'), bytes);
    await callOperation(
      'write',
      { path: 'img.png', content: 'text\n' },
      inv(),
      c,
    );
    const entry = journal.entries()[0];
    expect(entry?.op).toBe('write');
    // The recorded before-hash is the hash of the real bytes.
    expect(entry?.beforeHash).not.toBeNull();
    expect(entry === undefined ? 'x' : journal.readBefore(entry)).toBeNull();
    const result = applyUndo(journal, planUndo(journal, {}, root), root, {});
    expect(result.restored).toEqual([]);
    // A designed hash-only pre-image, not lost content.
    expect(entry?.beforeOmitted).toBe(true);
    expect(journalStatus(journal, root).corrupt).toBe(0);
    expect(diffEntries(journal, {})[0]?.corrupt).toBe(false);
    // Undo must not write U+FFFD-mangled content, nor delete the file.
    expect(readFileSync(join(root, 'img.png'), 'utf8')).toBe('text\n');
  });

  it('records the journal intent before the rename: a failed journal leaves the file untouched', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'a.txt'), 'old\n');
    const failing = {
      append: () => {
        throw new Error('disk full');
      },
    } as unknown as FileJournalStore;
    const out = await callOperation(
      'write',
      { path: 'a.txt', content: 'new\n' },
      inv(),
      { ...c, journal: failing },
    );
    expect(out.ok).toBe(false);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('old\n');
    expect(existsSync(join(root, 'a.txt.kubic-tmp'))).toBe(false);
    const edit = await callOperation(
      'edit',
      { path: 'a.txt', oldText: 'old', newText: 'new' },
      inv(),
      { ...c, journal: failing },
    );
    expect(edit.ok).toBe(false);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('old\n');
  });
});
