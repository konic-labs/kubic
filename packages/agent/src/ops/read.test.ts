// Model-facing read bounds.
// READ_MAX_BYTES caps the SCAN; these tests pin the OUTPUT bounds:
// the byte cap on what reaches the model (a notice, never a silent slice),
// the binary refusal (size + type, no U+FFFD), and the offset-past-EOF
// notice. Existing windowed/error behavior is pinned by
// read-windowed.test.ts and read-errors.test.ts and must stay green.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeExecutionEnv, NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInvocation, MemoryMemoStore } from './memos.js';
import { READ_RESULT_MAX_BYTES, readOperation } from './read.js';
import type { OpContext, ToolInvocation } from './types.js';

const MIB = 1024 * 1024;

let dir: string;

function inv(): ToolInvocation {
  return createInvocation(
    { invocationId: 'inv-1', operationId: 'op-1', turnId: 't-1' },
    new MemoryMemoStore(),
  );
}

function ctx(): OpContext {
  return { env: new NodeExecutionEnv(dir), sessionId: 's1', agentId: 'a1' };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kubic-read-bounds-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('read output byte cap', () => {
  it('clips a 3 MB single-line file at the cap with a notice, never a partial line', async () => {
    const line = 'x'.repeat(3 * MIB);
    writeFileSync(join(dir, 'min.js'), line);
    const out = await readOperation.execute(inv(), { path: 'min.js' }, ctx());
    expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(
      READ_RESULT_MAX_BYTES,
    );
    // No partial line: the whole line is left out.
    expect(out.content).toBe('');
    expect(out.truncated).toBe(true);
    expect(out.notice).toContain(`${3 * MIB}B`);
    expect(out.notice).toContain(`${READ_RESULT_MAX_BYTES}B`);
    expect(out.notice).toContain('bash');
  });

  it('shell-quotes the path in the suggested bash command', async () => {
    const name = "it's min.js";
    writeFileSync(join(dir, name), 'x'.repeat(3 * MIB));
    const out = await readOperation.execute(inv(), { path: name }, ctx());
    expect(out.notice).toContain(
      "sed -n '1p' < 'it'\\''s min.js' | head -c 51200",
    );
  });

  it('never hands a leading-dash path to sed as an operand', async () => {
    // GNU sed permutes options, so `sed -n '1p' '-e1e touch pwned'` would run
    // `touch pwned` as sed script text (r/-f/w variants too). The suggestion
    // feeds the file through stdin, so the name is never an operand.
    const name = '-e1e touch pwned';
    writeFileSync(join(dir, name), 'x'.repeat(3 * MIB));
    const out = await readOperation.execute(inv(), { path: name }, ctx());
    expect(out.notice).toContain("sed -n '1p' < '-e1e touch pwned'");
    expect(out.notice).not.toContain("sed -n '1p' '-e");
  });

  it('points at the next line when the offset line is too large to carry', async () => {
    writeFileSync(join(dir, 'long-then.txt'), `${'x'.repeat(3 * MIB)}\ntail\n`);
    const out = await readOperation.execute(
      inv(),
      { path: 'long-then.txt' },
      ctx(),
    );
    expect(out.content).toBe('');
    expect(out.notice).toContain('bash');
    expect(out.notice).toContain('; more: offset=2');
  });

  it('counts the cap in UTF-8 bytes, not characters', async () => {
    // 1000 lines of 50 é (100 bytes each): 102000 bytes, so the cap must
    // clip it. A character-based cap would return all 1000 untouched.
    const line = 'é'.repeat(50);
    writeFileSync(
      join(dir, 'unicode.txt'),
      `${Array.from({ length: 1000 }, () => line).join('\n')}\n`,
    );
    const out = await readOperation.execute(
      inv(),
      { path: 'unicode.txt' },
      ctx(),
    );
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(
      READ_RESULT_MAX_BYTES,
    );
    // 506 lines × (100 bytes + '\n') = 51106 — the 507th would pass the cap.
    expect(out.content.split('\n')).toHaveLength(507);
    expect(out.notice).toBe(`output clipped at ${READ_RESULT_MAX_BYTES}B`);
  });

  it('keeps a window whose total content is exactly the cap', async () => {
    // 512 lines × 99 bytes + 511 joins + the trailing '\n' = 51200 exactly.
    // The newline is part of the content, so it must fit, not clip.
    const line = 'z'.repeat(99);
    writeFileSync(
      join(dir, 'exact.txt'),
      `${Array.from({ length: 512 }, () => line).join('\n')}\n`,
    );
    const out = await readOperation.execute(
      inv(),
      { path: 'exact.txt' },
      ctx(),
    );
    expect(Buffer.byteLength(out.content, 'utf8')).toBe(READ_RESULT_MAX_BYTES);
    expect(out.truncated).toBe(false);
    expect(out.notice).toBeUndefined();
  });

  it('clips a window whose body is exactly the cap, where the trailing newline would cross it', async () => {
    // 511 × 99 + one 100-byte line + 512 joins = 51201 bytes of content:
    // the body is exactly 51200, but body + '\n' is over the cap.
    const line = 'z'.repeat(99);
    writeFileSync(
      join(dir, 'over.txt'),
      `${Array.from({ length: 511 }, () => line).join('\n')}\n${'z'.repeat(100)}\n`,
    );
    const out = await readOperation.execute(inv(), { path: 'over.txt' }, ctx());
    expect(Buffer.byteLength(out.content, 'utf8')).toBeLessThanOrEqual(
      READ_RESULT_MAX_BYTES,
    );
    expect(out.truncated).toBe(true);
    expect(out.notice).toBe(`output clipped at ${READ_RESULT_MAX_BYTES}B`);
  });
});

describe('binary refusal', () => {
  it('refuses a PNG from the first-chunk UTF-8 sniff with size and type, never U+FFFD content', async () => {
    // PNG signature + IHDR chunk: 0x89 leads with a UTF-8 continuation
    // byte, and the length field carries NULs.
    const png = Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR', 'latin1');
    writeFileSync(join(dir, 'logo.png'), png);
    const out = await readOperation.execute(inv(), { path: 'logo.png' }, ctx());
    expect(out.content).toBe('');
    expect(out.content).not.toContain('\uFFFD');
    expect(out.truncated).toBe(true);
    expect(out.binary).toEqual({ reason: 'invalid_utf8', bytes: png.length });
    expect(out.notice).toContain(`${png.length}B`);
    expect(out.notice).toContain('invalid UTF-8');
  });

  it('refuses a NUL-bearing file as NUL, not as invalid UTF-8', async () => {
    const bytes = Buffer.from('name\u0000value\n');
    writeFileSync(join(dir, 'utf16.txt'), bytes);
    const out = await readOperation.execute(
      inv(),
      { path: 'utf16.txt' },
      ctx(),
    );
    expect(out.content).toBe('');
    expect(out.binary).toEqual({ reason: 'nul', bytes: bytes.length });
    expect(out.notice).toContain('NUL');
  });

  it('does not call a multi-byte codepoint straddling the chunk boundary binary', async () => {
    // The é starts in the last byte of the first 512 KiB chunk; a strict
    // whole-chunk decode would misread it as invalid UTF-8.
    writeFileSync(
      join(dir, 'straddle.txt'),
      `${'x'.repeat(512 * 1024 - 1)}é\ntail\n`,
    );
    const out = await readOperation.execute(
      inv(),
      { path: 'straddle.txt', offset: 2, limit: 1 },
      ctx(),
    );
    expect(out.binary).toBeUndefined();
    expect(out.content).toBe('tail\n');
  });

  it('refuses binary on a seam without ranged reads, where U+FFFD is the surviving signal', async () => {
    const env = new FakeExecutionEnv({});
    // Seam without ranged reads: the fallback path only
    // runs when the seam lacks readFileRange, so drop the fake's.
    env.fs.readFileRange = undefined;
    env.fs.writeFile('logo.png', '\uFFFDPNG\r\n\u001a\n');
    const out = await readOperation.execute(
      inv(),
      { path: 'logo.png' },
      { env, sessionId: 's1', agentId: 'a1' },
    );
    expect(out.content).toBe('');
    expect(out.binary?.reason).toBe('invalid_utf8');
    expect(out.notice).toContain('invalid UTF-8');
  });

  it('refuses NUL-bearing content on a seam without ranged reads', async () => {
    const env = new FakeExecutionEnv({});
    // Seam without ranged reads: keep this on the fallback
    // path the test name promises.
    env.fs.readFileRange = undefined;
    env.fs.writeFile('utf16.txt', 'a\0b\0');
    const out = await readOperation.execute(
      inv(),
      { path: 'utf16.txt' },
      { env, sessionId: 's1', agentId: 'a1' },
    );
    expect(out.binary).toEqual({ reason: 'nul', bytes: 4 });
    expect(out.notice).toContain('NUL bytes');
  });

  it('refuses binary without a size when the file cannot be statted after the read', async () => {
    const env = new FakeExecutionEnv({});
    // Seam without ranged reads: the U+FFFD signal only
    // survives on the fallback path.
    env.fs.readFileRange = undefined;
    env.fs.writeFile('logo.png', '\uFFFDPNG');
    vi.spyOn(env.fs, 'stat').mockImplementation(() => {
      throw new Error('boom');
    });
    const out = await readOperation.execute(
      inv(),
      { path: 'logo.png' },
      { env, sessionId: 's1', agentId: 'a1' },
    );
    expect(out.binary).toEqual({ reason: 'invalid_utf8' });
    expect(out.notice).toBe(
      'binary file (invalid UTF-8) — read serves text only; use bash for byte-level inspection',
    );
  });
});

describe('offset past EOF', () => {
  it('names the offset past the last line with the exact line count', async () => {
    writeFileSync(join(dir, 'three.txt'), 'a\nb\nc\n');
    const out = await readOperation.execute(
      inv(),
      { path: 'three.txt', offset: 5 },
      ctx(),
    );
    expect(out.content).toBe('');
    expect(out.totalLines).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.notice).toBe('offset 5 is past the last line (3 lines total)');
  });

  it('counts a final line without a trailing newline before refusing the offset', async () => {
    writeFileSync(join(dir, 'two.txt'), 'a\nb');
    const out = await readOperation.execute(
      inv(),
      { path: 'two.txt', offset: 3 },
      ctx(),
    );
    expect(out.content).toBe('');
    expect(out.totalLines).toBe(2);
    expect(out.notice).toBe('offset 3 is past the last line (2 lines total)');
  });

  it('singularizes the line count for a one-line file', async () => {
    writeFileSync(join(dir, 'one.txt'), 'only\n');
    const out = await readOperation.execute(
      inv(),
      { path: 'one.txt', offset: 2 },
      ctx(),
    );
    expect(out.notice).toBe('offset 2 is past the last line (1 line total)');
  });
});
