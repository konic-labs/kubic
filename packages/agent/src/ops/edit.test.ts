// Edit line-ending and BOM handling (Pi's edit-diff.ts).
// A Windows-authored file (CRLF, or CRLF + UTF-8 BOM) must edit where Pi
// succeeds: matching happens on LF-normalized text with the BOM stripped,
// and every line the edit does not touch keeps its own ending, so a uniform
// file stays uniform and a mixed one changes only where it was edited.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { applyUndo, FileJournalStore, planUndo } from '@kubic/exec/journal';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { inv } from '../test-support/invocation.js';
import { callOperation } from './registry.js';
import type { OpContext } from './types.js';

function setup(): { root: string; journal: FileJournalStore; c: OpContext } {
  const root = tempDir('edit-tool-');
  const journal = new FileJournalStore(tempDir('edit-tool-j-'));
  const c: OpContext = {
    env: new NodeExecutionEnv(root),
    sessionId: 's1',
    agentId: 'root',
    toolCallId: 'call-1',
    journal,
  };
  return { root, journal, c };
}

describe('edit line endings and BOM', () => {
  it('replaces a multi-line LF oldText in a CRLF file and keeps CRLF everywhere', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'win.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
    const out = await callOperation(
      'edit',
      { path: 'win.txt', oldText: 'alpha\nbeta', newText: 'ALPHA\nBETA' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    const text = readFileSync(join(root, 'win.txt'), 'utf8');
    expect(text).toBe('ALPHA\r\nBETA\r\ngamma\r\n');
    // No mixed endings: every newline in the result is a CRLF.
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('matches a CRLF oldText too, never doubling the carriage returns', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'win.txt'), 'alpha\r\nbeta\r\n');
    const out = await callOperation(
      'edit',
      { path: 'win.txt', oldText: 'alpha\r\n', newText: 'ALPHA\r\n' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(join(root, 'win.txt'), 'utf8')).toBe(
      'ALPHA\r\nbeta\r\n',
    );
  });

  it('edits the first line of a BOM file and preserves the BOM', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'bom.txt'), '\uFEFFfirst\r\nsecond\r\n');
    const out = await callOperation(
      'edit',
      { path: 'bom.txt', oldText: 'first', newText: 'FIRST' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(join(root, 'bom.txt'), 'utf8')).toBe(
      '\uFEFFFIRST\r\nsecond\r\n',
    );
  });

  it('matches an oldText that carries the BOM, keeping exactly one BOM', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'bom.txt'), '\uFEFFfirst\nsecond\n');
    // The model may copy the first line from a reader that keeps the BOM:
    // both sides are normalized, so this matches and the file still has one
    // BOM — never zero, never two.
    const out = await callOperation(
      'edit',
      { path: 'bom.txt', oldText: '\uFEFFfirst', newText: 'FIRST' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(join(root, 'bom.txt'), 'utf8')).toBe(
      '\uFEFFFIRST\nsecond\n',
    );
  });

  it('normalizes a leading BOM in oldText even when the file has none', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'plain.txt'), 'first\nsecond\n');
    // Both sides go through the same normalization, so a needle copied out
    // of a BOM-prefixed file still finds its line here.
    const out = await callOperation(
      'edit',
      { path: 'plain.txt', oldText: '\uFEFFfirst', newText: 'FIRST' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    expect(readFileSync(join(root, 'plain.txt'), 'utf8')).toBe(
      'FIRST\nsecond\n',
    );
  });

  it('never lets a replacement introduce a second BOM', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'bom.txt'), '\uFEFFfirst\nsecond\n');
    const out = await callOperation(
      'edit',
      {
        path: 'bom.txt',
        oldText: 'first\nsecond',
        newText: '\uFEFFFIRST\nSECOND',
      },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    const text = readFileSync(join(root, 'bom.txt'), 'utf8');
    expect(text).toBe('\uFEFFFIRST\nSECOND\n');
    expect(text.indexOf('\uFEFF', 1)).toBe(-1);
  });

  it('refuses an oldText that is empty after normalization', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'a.txt'), 'a\nb\n');
    // A lone BOM normalizes to nothing, and an empty needle would match
    // everywhere (and spin the occurrence counter).
    const out = await callOperation(
      'edit',
      { path: 'a.txt', oldText: '\uFEFF', newText: 'X' },
      inv(),
      c,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('invalid_args');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a\nb\n');
  });

  it('counts expectCount on the normalized text', async () => {
    const { root, c } = setup();
    writeFileSync(join(root, 'win.txt'), 'a\r\nb\r\na\r\nb\r\n');
    const out = await callOperation(
      'edit',
      { path: 'win.txt', oldText: 'a\nb', newText: 'X', expectCount: 2 },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.replacements).toBe(2);
    expect(readFileSync(join(root, 'win.txt'), 'utf8')).toBe('X\r\nX\r\n');
  });

  it('leaves an LF file byte-for-byte as it was, apart from the replacement', async () => {
    const { root, journal, c } = setup();
    writeFileSync(join(root, 'unix.txt'), 'alpha\nbeta\n');
    const out = await callOperation(
      'edit',
      { path: 'unix.txt', oldText: 'alpha', newText: 'ALPHA' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(readFileSync(join(root, 'unix.txt'), 'utf8')).toBe('ALPHA\nbeta\n');
    // The journal's after-side is the content actually written.
    expect(journal.entries()[0]?.afterHash).toBe(out.result.afterHash);
    expect(out.result.bytesDelta).toBe(0);
  });

  it('journals the restored content, so undo brings the CRLF file back exactly', async () => {
    const { root, journal, c } = setup();
    writeFileSync(join(root, 'win.txt'), 'alpha\r\nbeta\r\ngamma\r\n');
    const out = await callOperation(
      'edit',
      { path: 'win.txt', oldText: 'alpha\nbeta', newText: 'ALPHA\nBETA' },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    const result = applyUndo(journal, planUndo(journal, {}, root), root, {});
    expect(result.restored).toEqual(['win.txt']);
    expect(readFileSync(join(root, 'win.txt'), 'utf8')).toBe(
      'alpha\r\nbeta\r\ngamma\r\n',
    );
  });
});

describe('edit in a file with mixed line endings', () => {
  async function edited(
    content: string,
    args: { oldText: string; newText: string; expectCount?: number },
  ): Promise<string> {
    const { root, c } = setup();
    writeFileSync(join(root, 'mixed.txt'), content);
    const out = await callOperation(
      'edit',
      { path: 'mixed.txt', ...args },
      inv(),
      c,
    );
    expect(out.ok).toBe(true);
    return readFileSync(join(root, 'mixed.txt'), 'utf8');
  }

  it('keeps every untouched line ending when an LF line is edited', async () => {
    expect(await edited('a\r\nb\nc\r\n', { oldText: 'b', newText: 'B' })).toBe(
      'a\r\nB\nc\r\n',
    );
  });

  it('keeps every untouched line ending when a CRLF line is edited', async () => {
    expect(await edited('a\nb\r\nc\n', { oldText: 'b', newText: 'B' })).toBe(
      'a\nB\r\nc\n',
    );
  });

  it('gives an added line the ending of the line it was added to', async () => {
    expect(
      await edited('a\r\nb\nc\r\n', { oldText: 'b', newText: 'b\nb2' }),
    ).toBe('a\r\nb\nb2\nc\r\n');
    // On a last line with no newline, the line before decides.
    expect(await edited('a\r\nb', { oldText: 'b', newText: 'b\nc' })).toBe(
      'a\r\nb\r\nc',
    );
  });

  it('gives a multi-line replacement the ending of the lines it replaces', async () => {
    expect(
      await edited('a\r\nb\nc\r\nd\n', { oldText: 'b\nc', newText: 'B\nC' }),
    ).toBe('a\r\nB\nC\r\nd\n');
    expect(
      await edited('a\nb\r\nc\r\nd\n', { oldText: 'b\nc\n', newText: 'B\n' }),
    ).toBe('a\nB\r\nd\n');
  });

  it('replaces every counted match in place', async () => {
    expect(
      await edited('x\r\ny\nx\n', {
        oldText: 'x',
        newText: 'z',
        expectCount: 2,
      }),
    ).toBe('z\r\ny\nz\n');
  });

  it('keeps the BOM and the untouched endings of a BOM file', async () => {
    expect(
      await edited('\uFEFFa\r\nb\nc\r\n', { oldText: 'a', newText: 'A' }),
    ).toBe('\uFEFFA\r\nb\nc\r\n');
  });
});
