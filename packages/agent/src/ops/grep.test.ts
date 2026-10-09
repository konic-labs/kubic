// Grep bounds on the node seam: a match on a huge line
// must not flood the context, binary files must not be searched, an
// oversized file must be skipped WITHOUT being read, and the whole result
// must fit a byte budget. include stays a documented substring test.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FileSystem, NodeExecutionEnv } from '@kubic/exec/env';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import {
  GREP_MAX_FILE_BYTES,
  GREP_MAX_LINE_LENGTH,
  GREP_RESULT_MAX_BYTES,
} from './grep.js';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { callOperation, OPERATION_PARAMETERS, OPERATIONS } from './registry.js';
import type { OpContext, ToolInvocation } from './types.js';

function ctx(root: string): OpContext {
  return { env: new NodeExecutionEnv(root), sessionId: 's1', agentId: 'a1' };
}

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

describe('grep bounds', () => {
  it('clips a matching line at the line cap and sets linesTruncated', async () => {
    const root = tempDir('grep-tool-line-');
    const long = `needle ${'x'.repeat(1_000_000)}`;
    writeFileSync(join(root, 'big.txt'), `${long}\n`);
    const out = await callOperation(
      'grep',
      { pattern: 'needle', root: '.' },
      inv(),
      ctx(root),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.linesTruncated).toBe(true);
    const match = out.result.matches[0];
    expect(match?.text.length).toBe(GREP_MAX_LINE_LENGTH);
    expect(match?.text.startsWith('needle')).toBe(true);
    // Clipping a line is not a truncated search: every match was reported.
    expect(out.result.truncated).toBe(false);
  });

  it('leaves a short matching line whole and reports linesTruncated false', async () => {
    const root = tempDir('grep-tool-short-');
    writeFileSync(join(root, 'a.txt'), 'needle here\n');
    const out = await callOperation(
      'grep',
      { pattern: 'needle', root: '.' },
      inv(),
      ctx(root),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.matches).toEqual([
      { path: 'a.txt', line: 1, text: 'needle here' },
    ]);
    expect(out.result.linesTruncated).toBe(false);
  });

  it('skips a file containing NUL bytes and counts it', async () => {
    const root = tempDir('grep-tool-binary-');
    writeFileSync(join(root, 'blob.dat'), Buffer.from('needle\u0000needle\n'));
    writeFileSync(join(root, 'text.txt'), 'needle\n');
    const out = await callOperation(
      'grep',
      { pattern: 'needle', root: '.' },
      inv(),
      ctx(root),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.matches).toEqual([
      { path: 'text.txt', line: 1, text: 'needle' },
    ]);
    expect(out.result.skippedBinary).toBe(1);
    expect(out.result.skippedOversized).toBe(0);
  });

  it('skips a file over the size bound, counts it, and never reads it', async () => {
    const root = tempDir('grep-tool-size-');
    writeFileSync(join(root, 'huge.txt'), 'needle\n');
    writeFileSync(join(root, 'small.txt'), 'needle\n');
    const base = new NodeExecutionEnv(root);
    const reads: string[] = [];
    const fs = Object.create(base.fs) as FileSystem;
    const statOf = base.fs.stat.bind(base.fs);
    // Stats seam: the file is over the bound without the test allocating it.
    fs.stat = (path: string) =>
      path === 'huge.txt'
        ? {
            isFile: true,
            isDirectory: false,
            size: GREP_MAX_FILE_BYTES + 1,
            mode: 0o644,
          }
        : statOf(path);
    fs.readFile = (path: string) => {
      reads.push(path);
      return base.fs.readFile(path);
    };
    const env = {
      cwd: base.cwd,
      shell: base.shell,
      provenance: base.provenance,
      fs,
      withProvenance: (next: typeof base.provenance) =>
        base.withProvenance(next),
    };
    const out = await callOperation(
      'grep',
      { pattern: 'needle', root: '.' },
      inv(),
      { ...ctx(root), env },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.matches).toEqual([
      { path: 'small.txt', line: 1, text: 'needle' },
    ]);
    expect(out.result.skippedOversized).toBe(1);
    expect(out.result.skippedBinary).toBe(0);
    // Never whole-read: the oversized file is not even opened.
    expect(reads).toEqual(['small.txt']);
    // An unsearched text candidate means the result may be incomplete.
    expect(out.result.truncated).toBe(true);
    expect(out.result.notice).toContain(String(GREP_MAX_FILE_BYTES));
  });

  it('bounds the total result bytes and names the cap', async () => {
    const root = tempDir('grep-tool-bytes-');
    const line = `needle ${'y'.repeat(400)}`;
    for (let i = 0; i < 200; i += 1) {
      writeFileSync(
        join(root, `f${String(i).padStart(3, '0')}.txt`),
        `${line}\n`,
      );
    }
    const out = await callOperation(
      'grep',
      { pattern: 'needle', root: '.', maxMatches: 1000 },
      inv(),
      ctx(root),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.truncated).toBe(true);
    expect(out.result.notice).toContain('output cap');
    expect(out.result.matches.length).toBeLessThan(200);
    const bytes = out.result.matches.reduce(
      (total, match) =>
        total +
        Buffer.byteLength(`${match.path}:${match.line}: ${match.text}\n`),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(GREP_RESULT_MAX_BYTES);
  });

  it('documents include as a substring test in the description and the schema', () => {
    expect(OPERATIONS.grep.description).toContain('substring (not a glob)');
    const schema = OPERATION_PARAMETERS.grep as unknown as {
      properties: { include: { description: string } };
    };
    expect(schema.properties.include.description).toContain(
      'substring (not a glob)',
    );
  });
});
