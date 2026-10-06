// Block mode in the app (EPIC N, issue #463; docs/ui 01-D, 01-M): Esc on
// an idle, empty editor walks the transcript by blocks — move, copy (OSC 52
// through the composition root), view whole, expand — and any other key
// returns to typing.
import { describe, expect, it } from 'vitest';
import { createApprovalSurface } from './approval-surface.js';
import type { ApprovalOverlayTui } from './approval-view.js';
import { createTuiApp } from './tui-app.js';
import type { Component } from './tui-boundary.js';

const OUTPUT = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

function setup(clipboard?: (text: string) => boolean) {
  const app = createTuiApp({
    sessionId: 'sess-463',
    model: 'faux/m',
    mode: 'solo',
    approvalsSkipped: false,
    approvalSurface: createApprovalSurface({ armingMs: 0 }),
    ...(clipboard === undefined ? {} : { clipboard }),
  });
  const shown: Array<{ component: Component; hidden: boolean }> = [];
  const host: ApprovalOverlayTui = {
    terminal: { columns: 100, rows: 30 },
    showOverlay: (component) => {
      const entry = { component, hidden: false };
      shown.push(entry);
      return {
        unfocus: () => {},
        hide: () => {
          entry.hidden = true;
        },
      };
    },
  };
  app.attachApprovalOverlay(host);
  app.applyLaneEntries([
    {
      id: 'u1',
      seq: 1,
      type: 'message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'run the tests' }],
      },
    },
    {
      id: 'a1',
      seq: 2,
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running them.' },
          {
            type: 'toolCall',
            id: 'c1',
            name: 'bash',
            arguments: { command: 'npm test' },
          },
        ],
      },
    },
    {
      id: 'r1',
      seq: 3,
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'c1',
        content: [{ type: 'text', text: OUTPUT }],
      },
    },
    {
      id: 'a2',
      seq: 4,
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'All green.' }],
      },
    },
  ]);
  const frame = (): string[] => app.render(100);
  const overlay = (): string =>
    shown
      .find((entry) => !entry.hidden)
      ?.component.render(90)
      .join('\n') ?? '';
  return { app, frame, overlay };
}

const selectedRow = (lines: readonly string[]): string =>
  lines.find((line) => line.startsWith('▌')) ?? '';

describe('block mode (issue #463)', () => {
  it('Esc on an idle, empty editor selects the last block', () => {
    const { app, frame } = setup();
    app.render(100);
    app.handleInput('\u001b');
    expect(selectedRow(frame())).toContain('All green.');
    expect(frame().at(-1)).toContain('esc back');
  });

  it('a draft keeps Esc from entering it', () => {
    const { app, frame } = setup();
    app.render(100);
    app.editor.setText('half typed');
    app.handleInput('\u001b');
    expect(selectedRow(frame())).toBe('');
  });

  it('moves by block with arrows, k/j and g/G', () => {
    const { app, frame } = setup();
    app.render(100);
    app.handleInput('\u001b');
    app.handleInput('k');
    expect(selectedRow(frame())).toContain('bash');
    app.handleInput('\u001b[A');
    expect(selectedRow(frame())).toContain('Running them.');
    app.handleInput('g');
    expect(selectedRow(frame())).toContain('run the tests');
    app.handleInput('G');
    expect(selectedRow(frame())).toContain('All green.');
    app.handleInput('j');
    expect(selectedRow(frame())).toContain('All green.');
  });

  it('copies the block, or its command, through the clipboard hook', () => {
    const copied: string[] = [];
    const { app, frame } = setup((text) => {
      copied.push(text);
      return true;
    });
    app.render(100);
    app.handleInput('\u001b');
    app.handleInput('k');
    app.handleInput('y');
    app.handleInput('Y');
    expect(copied).toEqual([OUTPUT, 'bash npm test']);
    expect(frame().join('\n')).toContain('copied 13 B');
  });

  it('says when a copy cannot happen', () => {
    const { app, frame } = setup(() => false);
    app.render(100);
    app.handleInput('\u001b');
    app.handleInput('y');
    expect(frame().join('\n')).toContain('does not take clipboard writes');
    const none = setup();
    none.app.render(100);
    none.app.handleInput('\u001b');
    none.app.handleInput('y');
    expect(none.frame().join('\n')).toContain('does not take clipboard writes');
  });

  it('opens the block whole in the viewer, copies from it and closes', () => {
    const copied: string[] = [];
    const { app, overlay } = setup((text) => {
      copied.push(text);
      return true;
    });
    app.render(100);
    app.handleInput('\u001b');
    app.handleInput('k');
    app.handleInput('\r');
    expect(overlay()).toContain('┌─ bash npm test');
    expect(overlay()).toContain('line 12');
    app.handleInput('y');
    expect(copied).toEqual([OUTPUT]);
    app.handleInput('\u001b');
    expect(overlay()).toBe('');
  });

  it('expands just the selected block', () => {
    const { app, frame } = setup();
    app.render(100);
    expect(frame().join('\n')).not.toContain('line 12');
    app.handleInput('\u001b');
    app.handleInput('k');
    app.handleInput('x');
    expect(frame().join('\n')).toContain('line 12');
  });

  it('any other key returns to typing, and is typed', () => {
    const { app, frame } = setup();
    app.render(100);
    app.handleInput('\u001b');
    app.handleInput('h');
    expect(selectedRow(frame())).toBe('');
    expect(app.editor.getText()).toBe('h');
    app.editor.setText('');
    app.handleInput('\u001b');
    app.handleInput('i');
    expect(selectedRow(frame())).toBe('');
    expect(app.editor.getText()).toBe('');
  });
});
