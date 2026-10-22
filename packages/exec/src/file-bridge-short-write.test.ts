// The durable append over a filesystem whose writes come back short: every
// byte still lands, in order, and the fsync covers the whole append.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// At most three bytes per write, the way a platform may legally answer.
const writes = vi.hoisted(() => ({ calls: 0, fsyncs: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: (
      fd: number,
      buffer: Uint8Array,
      offset = 0,
      length = buffer.length - offset,
    ): number => {
      writes.calls++;
      return actual.writeSync(fd, buffer, offset, Math.min(3, length));
    },
    fsyncSync: (fd: number): void => {
      writes.fsyncs++;
      actual.fsyncSync(fd);
    },
  };
});

import { createNodeFileBridge } from './file-bridge.js';

const made: string[] = [];

afterEach(() => {
  writes.calls = 0;
  writes.fsyncs = 0;
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('appendDurably on short writes', () => {
  it('keeps writing until every byte of the append is out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kubic-short-write-'));
    made.push(dir);
    const bridge = createNodeFileBridge(dir);
    bridge.appendDurably?.('log.jsonl', 'first line\n');
    bridge.appendDurably?.('log.jsonl', new TextEncoder().encode('second\n'));
    expect(readFileSync(join(dir, 'log.jsonl'), 'utf8')).toBe(
      'first line\nsecond\n',
    );
    // 11 bytes and 7 bytes at three per write: 4 + 3 writes, one fsync each.
    expect(writes.calls).toBe(7);
    expect(writes.fsyncs).toBe(2);
  });
});
