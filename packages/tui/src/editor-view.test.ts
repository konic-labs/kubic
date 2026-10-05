// Prompt editor component for the interactive loop (issue #88).
// RED: packages/tui/src/editor-view.ts does not exist yet.
//
// Pure headless snapshots (no VirtualTerminal in Pi 0.85.1): the editor is
// driven byte-by-byte like the real input listener feeds it. Faux-only,
// zero network.
import { describe, expect, it } from 'vitest';
import { PROMPT_HISTORY_MAX, PromptEditor } from './editor-view.js';

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

// Issue #340 (§16.5): a resumed session's earlier prompts are recallable
// with Up — the editor is seeded from the committed user entries, newest
// last, bounded so a very long session stays cheap to resume.
describe('seeded prompt history (issue #340)', () => {
  const UP = '\x1b[A';

  it('Up recalls the most recent seeded prompt, then older ones', () => {
    const editor = new PromptEditor();
    editor.seedHistory(['first', 'second', 'third']);
    editor.handleInput(UP);
    expect(editor.getText()).toBe('third');
    editor.handleInput(UP);
    expect(editor.getText()).toBe('second');
  });

  it('collapses consecutive duplicates and skips blank prompts', () => {
    const editor = new PromptEditor();
    editor.seedHistory(['a', 'a', '  ', 'b', 'b']);
    editor.handleInput(UP);
    expect(editor.getText()).toBe('b');
    editor.handleInput(UP);
    expect(editor.getText()).toBe('a');
    editor.handleInput(UP);
    expect(editor.getText()).toBe('a');
  });

  it('keeps only the newest PROMPT_HISTORY_MAX prompts when seeded with 500', () => {
    const editor = new PromptEditor();
    editor.seedHistory(Array.from({ length: 500 }, (_, i) => `p${i}`));
    for (let i = 0; i < PROMPT_HISTORY_MAX + 20; i += 1) editor.handleInput(UP);
    // The oldest recallable prompt is the 100th newest, never p0.
    expect(editor.getText()).toBe(`p${500 - PROMPT_HISTORY_MAX}`);
  });
});
