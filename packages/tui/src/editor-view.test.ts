// Prompt editor component for the interactive loop (issue #88).
// RED: packages/tui/src/editor-view.ts does not exist yet.
//
// Pure headless snapshots (no VirtualTerminal in Pi 0.85.1): the editor is
// driven byte-by-byte like the real input listener feeds it. Faux-only,
// zero network.
import { describe, expect, it } from 'vitest';
import { PromptEditor } from './editor-view.js';

const CURSOR_MARKER = '\u001B_pi:c\u0007';

function typed(text: string, into: PromptEditor): void {
  for (const ch of text) into.handleInput(ch);
}

describe('prompt editor (issue #88)', () => {
  it('submits the typed prompt on Enter and clears the draft', () => {
    const editor = new PromptEditor();
    const submitted: string[] = [];
    editor.onSubmit = (text: string) => submitted.push(text);
    typed('hi there', editor);
    editor.handleInput('\r');
    expect(submitted).toEqual(['hi there']);
    expect(editor.getText()).toBe('');
  });

  it('keeps Ctrl-J as a newline and submits the whole multi-line draft', () => {
    const editor = new PromptEditor();
    const submitted: string[] = [];
    editor.onSubmit = (text: string) => submitted.push(text);
    typed('line one', editor);
    editor.handleInput('\n');
    typed('line two', editor);
    editor.handleInput('\r');
    expect(submitted).toEqual(['line one\nline two']);
  });

  it('submits the backslash-Enter newline escape as a newline, not a submit', () => {
    const editor = new PromptEditor();
    const submitted: string[] = [];
    editor.onSubmit = (text: string) => submitted.push(text);
    typed('trailing\\', editor);
    editor.handleInput('\r');
    typed('next', editor);
    expect(submitted).toEqual([]);
    expect(editor.getText()).toBe('trailing\nnext');
    editor.handleInput('\r');
    expect(submitted).toEqual(['trailing\nnext']);
  });

  it('exposes focus to the wrapped editor (cursor marker only while focused)', () => {
    const editor = new PromptEditor();
    typed('x', editor);
    expect(editor.render(40).join('\n')).not.toContain(CURSOR_MARKER);
    editor.focused = true;
    const render = editor.render(40).join('\n');
    expect(render).toContain(CURSOR_MARKER);
    expect(render).toContain('x');
    editor.focused = false;
    expect(editor.render(40).join('\n')).not.toContain(CURSOR_MARKER);
  });

  it('tracks submitted prompts for arrow-key history', () => {
    const editor = new PromptEditor();
    editor.onSubmit = () => {};
    typed('first prompt', editor);
    editor.handleInput('\r');
    editor.handleInput('\u001b[A');
    expect(editor.getText()).toBe('first prompt');
  });
});
