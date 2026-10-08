// The no-isolation warning text.
// Fresh start must announce no isolation — one TUI line
// plus a `kubic run` stderr block. Faux-only: pure strings, no I/O.
import { describe, expect, it } from 'vitest';
import {
  emitNoIsolationNotice,
  noIsolationNoticeLines,
  noIsolationTuiLine,
} from './no-isolation-notice.js';

describe('startup warning', () => {
  it('TUI line announces no isolation in one line', () => {
    const line = noIsolationTuiLine();
    expect(line).toMatch(/no isolation/);
    expect(line).toContain('in-process');
    expect(line).toContain('approvals');
    expect(line).toContain('journal');
    expect(line).not.toContain('\n');
  });

  it('stderr block names user authority over files, network, credentials', () => {
    const text = noIsolationNoticeLines().join('\n');
    expect(text).toMatch(/no isolation/);
    expect(text).toContain('in-process');
    expect(text).toContain('files');
    expect(text).toContain('network');
    expect(text).toContain('credentials');
    expect(text).toMatch(/no containment/);
    expect(text).toMatch(
      /no .*injection.*prevention|no prompt-injection prevention/,
    );
    expect(text).toContain('approvals');
    expect(text).toContain('journal');
  });

  it('stderr block points at review/undo controls', () => {
    const text = noIsolationNoticeLines().join('\n');
    expect(text).toContain('kubic diff');
    expect(text).toContain('kubic undo');
  });

  it('emits one warning-prefixed line per line to the run stderr sink', () => {
    const lines: string[] = [];
    emitNoIsolationNotice((line: string) => lines.push(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith('warning:')).toBe(true);
    }
    expect(lines).toEqual(noIsolationNoticeLines());
  });
});
