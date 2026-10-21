import { describe, expect, it } from 'vitest';
import {
  cleanItem,
  parseSessionExportFormat,
  renderSessionHtml,
  renderSessionMarkdown,
  type SessionDocument,
} from './session-export.js';

function doc(overrides: Partial<SessionDocument> = {}): SessionDocument {
  return {
    id: 'abc',
    workspace: '/repo',
    createdAt: '2026-10-21T10:00:00.000Z',
    mode: undefined,
    posture: 'approvals enforced',
    models: ['faux/faux-1'],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 },
    items: [],
    audit: [],
    changes: [],
    ...overrides,
  };
}

describe('session export cleaning', () => {
  it('strips terminal control sequences but keeps lines and tabs', () => {
    const item = cleanItem({
      kind: 'user',
      text: '\u001b[31mred\u001b[0m\tand\r\n\u001b]0;title\u0007next\u0007 line',
      entryId: '1',
    });
    expect(item).toMatchObject({ text: 'red\tand\nnext line' });
  });

  it('cuts long tool output with a marker and redacts it', () => {
    const long = Array.from({ length: 300 }, (_, n) => `line ${n}`).join('\n');
    const item = cleanItem({
      kind: 'tool-result',
      callId: 'c',
      name: 'bash',
      text: `token: abcdefghijklmnop\n${long}`,
      isError: false,
      entryId: '2',
    });
    const text = item.kind === 'tool-result' ? item.text : '';
    expect(text.startsWith('token: [REDACTED]\nline 0\n')).toBe(true);
    expect(text).toMatch(/\n\[cut: \d+ more characters\]$/);
    expect(text).not.toContain('line 250');
  });
});

describe('session export rendering', () => {
  it('fences content with a fence longer than any backtick run inside it', () => {
    const md = renderSessionMarkdown(
      doc({
        items: [
          {
            kind: 'tool-result',
            callId: 'c',
            name: 'read',
            text: 'before\n```\ninside\n```\nafter',
            isError: true,
            entryId: '3',
          },
        ],
      }),
    );
    expect(md).toContain('#### Result of `read` (error)');
    expect(md).toContain('````\nbefore\n```\ninside\n```\nafter\n````');
  });

  it('escapes HTML and keeps the page self-contained', () => {
    const html = renderSessionHtml(
      doc({
        items: [
          {
            kind: 'user',
            text: '<script>alert(1)</script> & co',
            entryId: '4',
          },
        ],
        changes: [
          {
            path: 'a|b.ts',
            change: 'edit',
            bytes: -3,
            by: 'edit',
            contested: true,
          },
        ],
      }),
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
    expect(html).not.toContain('<script>');
    expect(html).toContain(
      '<td>a|b.ts</td><td>edit (contested)</td><td>-3</td>',
    );
    const md = renderSessionMarkdown(
      doc({
        changes: [
          {
            path: 'a|b.ts',
            change: 'edit',
            bytes: -3,
            by: 'edit',
            contested: false,
          },
        ],
      }),
    );
    expect(md).toContain('| a\\|b.ts | edit | -3 | edit |');
  });

  it('names an empty session plainly', () => {
    const md = renderSessionMarkdown(doc());
    expect(md).toContain('No messages.');
    expect(md).toContain('No audit rows for this session.');
    expect(md).toContain('The change journal recorded no file changes.');
    expect(md).toContain(
      '- Usage: 10 input, 5 output, 0 cache-read tokens; $0.5000',
    );
  });

  it('accepts md and html only', () => {
    expect(parseSessionExportFormat('md')).toBe('md');
    expect(parseSessionExportFormat('html')).toBe('html');
    expect(() => parseSessionExportFormat('pdf')).toThrow(
      'expected md or html, got "pdf"',
    );
  });
});
