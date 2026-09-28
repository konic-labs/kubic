// The approval dialog shows the whole command (issue #316; §41.2, §16.4): a
// long command wraps across lines, and when it needs more rows than a page
// the dialog says exactly what is hidden and how to see it — never a silent
// cut. Headless renders only.
import { describe, expect, it } from 'vitest';
import { createApprovalSurface } from './approval-surface.js';
import {
  APPROVAL_COMMAND_PAGE_LINES,
  type ApprovalViewRequest,
  renderApprovalLines,
} from './approval-view.js';
import { createTuiApp } from './tui-app.js';

const PREFIX = 'command: ';
const INDENT = ' '.repeat(PREFIX.length);

// The command text back out of the rendered rows (prefix/indent removed).
function commandRows(lines: string[]): string[] {
  const start = lines.findIndex((line) => line.startsWith(PREFIX));
  if (start < 0) return [];
  const rows = [lines[start]?.slice(PREFIX.length) ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(INDENT)) break;
    rows.push(line.slice(INDENT.length));
  }
  return rows;
}

function request(command: string): ApprovalViewRequest {
  return {
    key: 'k-316',
    capability: 'destructive-shell',
    toolName: 'bash',
    summary: `destructive-shell: ${command.slice(0, 120)}… (+${command.length - 120} chars)`,
    command,
  };
}

const PADDED = `echo 'running formatter' ${'x'.repeat(360)}; rm -rf ~/work`;

describe('approval dialog command display (issue #316)', () => {
  it('a 400-char command renders in full, wrapped, with its tail visible', () => {
    expect(PADDED.length).toBeGreaterThan(390);
    const lines = renderApprovalLines(request(PADDED), 80);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(commandRows(lines).join('')).toBe(PADDED);
    expect(lines.join('\n')).toContain('rm -rf ~/work');
    // No silent cut anywhere, and no second, truncated copy of the command.
    expect(lines.some((line) => line.startsWith('summary:'))).toBe(false);
    expect(lines.join('\n')).not.toContain('next page');
  });

  it('keeps the lines of a multi-line command', () => {
    const lines = renderApprovalLines(request('cd build\nrm -rf out'), 80);
    expect(commandRows(lines)).toEqual(['cd build', 'rm -rf out']);
  });

  it('pages a command taller than a page with an explicit marker', () => {
    const long = Array.from({ length: 40 }, (_, i) => `step-${i}`).join('\n');
    const first = renderApprovalLines(request(long), 80);
    expect(commandRows(first)).toHaveLength(APPROVAL_COMMAND_PAGE_LINES);
    const marker = first.find((line) => line.startsWith('… command lines'));
    expect(marker).toBe(
      `… command lines 1–${APPROVAL_COMMAND_PAGE_LINES} of 40 · [v] next page`,
    );
    const second = renderApprovalLines(request(long), 80, { commandPage: 1 });
    expect(commandRows(second)[0]).toBe(`step-${APPROVAL_COMMAND_PAGE_LINES}`);
    const last = renderApprovalLines(request(long), 80, { commandPage: 4 });
    expect(commandRows(last).at(-1)).toBe('step-39');
    // Paging wraps back to the start.
    const wrapped = renderApprovalLines(request(long), 80, { commandPage: 5 });
    expect(commandRows(wrapped)).toEqual(commandRows(first));
  });

  it('shows the summary when the request carries no command', () => {
    const lines = renderApprovalLines(
      {
        key: 'k',
        capability: 'outside-write',
        toolName: 'write',
        summary: 'outside-write: write /etc/hosts',
      },
      80,
    );
    expect(lines).toContain('summary: outside-write: write /etc/hosts');
  });

  it('control characters in the command are sanitized in the dialog', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(request('echo \u001b[2Jhi\u0007; rm -rf x'));
    const body = surface.renderOverlayBody(80).join('\n');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(body).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(body).toContain('rm -rf x');
    surface.cancelPending();
    await pending;
  });

  it('the v key pages the shown command and never decides', async () => {
    const long = Array.from({ length: 20 }, (_, i) => `step-${i}`).join('\n');
    const surface = createApprovalSurface({ armingMs: 0 });
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    const pending = app.requestApproval(request(long));
    expect(surface.renderOverlayBody(80).join('\n')).toContain('step-0');
    expect(app.handleInput('v').consumed).toBe(true);
    expect(app.hasPendingApproval()).toBe(true);
    const paged = surface.renderOverlayBody(80).join('\n');
    expect(paged).toContain(`step-${APPROVAL_COMMAND_PAGE_LINES}`);
    expect(paged).not.toContain('step-0\n');
    expect(app.editor.getText()).toBe('');
    surface.cancelPending();
    await pending;
  });
});
