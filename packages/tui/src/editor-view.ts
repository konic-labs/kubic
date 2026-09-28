// Prompt editor slot for the interactive loop (issue #88).
// The layout's editor row was a bare `Text('')` (issue #75): no submit
// binding, no multi-line entry, no history — so the loop could never
// accept a prompt. This wraps Pi's Editor (the component upstream uses,
// §16 pi-tui architecture) behind the presentation seam so the controller
// stays Pi-free: the composition root owns the TUI handle, the app owns
// the routing, this slot owns the draft.
//
// Presentation only (§66): the editor holds a draft string and a submit
// callback. It never knows what a lane is.

import { tuiTheme } from './theme.js';
import type { Component, EditorTheme, Focusable, TUI } from './tui-boundary.js';
import { Editor } from './tui-boundary.js';

// Pi's editor takes the owning TUI at construction (it reads terminal rows
// for paging and calls requestRender on state changes), but the app builds
// its views before the screen exists. The delegate resolves the TUI lazily:
// before `bind` it no-ops, after `bind` every render request and terminal
// read goes to the live alt-screen.
class TuiDelegate {
  private target: TUI | undefined;
  private readonly fallbackRows: number;

  constructor(fallbackRows: number) {
    this.fallbackRows = fallbackRows;
  }

  bind(tui: TUI): void {
    this.target = tui;
  }

  requestRender(): void {
    this.target?.requestRender();
  }

  get terminal(): { rows: number } {
    return this.target?.terminal ?? { rows: this.fallbackRows };
  }
}

export const EDITOR_FALLBACK_ROWS = 24;

export function editorTheme(): EditorTheme {
  const identity = (text: string): string => text;
  return {
    // Read per call so a theme set after construction applies.
    borderColor: (text: string): string => tuiTheme().accent(text),
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  };
}

// The editor slot: Pi's Editor behind a tiny seam. `onSubmit` fires only
// for a non-empty draft (Enter on blank input is a no-op, matching Pi's
// interactive mode) with the draft already cleared by the editor, so a slow
// submit can never double-fire the same prompt.
export class PromptEditor implements Component, Focusable {
  readonly inner: Editor;
  onSubmit?: (text: string) => void;

  private readonly delegate: TuiDelegate;

  constructor() {
    this.delegate = new TuiDelegate(EDITOR_FALLBACK_ROWS);
    this.inner = new Editor(this.delegate as unknown as TUI, editorTheme());
    // History is recorded by the wrapper: Pi's submitValue clears the
    // draft and fires onSubmit without touching the history ring, so the
    // trimmed draft is pushed before the caller's handler runs. Duplicate
    // consecutive prompts collapse to one entry.
    this.history = [];
    this.inner.onSubmit = (text: string): void => {
      const prompt = text.trim();
      if (prompt === '') return;
      this.recordHistory(prompt);
      this.onSubmit?.(prompt);
    };
  }

  private readonly history: string[];

  private recordHistory(prompt: string): void {
    if (this.history[0] === prompt) return;
    this.history.unshift(prompt);
    this.inner.addToHistory(prompt);
  }

  // Focus is the inner editor's own flag (it decides whether to emit the
  // hardware-cursor marker for IME placement); forwarding keeps Pi's focus
  // semantics without a second source of truth.
  get focused(): boolean {
    return this.inner.focused;
  }

  set focused(value: boolean) {
    this.inner.focused = value;
  }

  // While a turn is in flight the loop disables submit: the lane refuses a
  // second concurrent accept, and a queued prompt would silently vanish.
  // Pi's `disableSubmit` keeps editing (and history) alive but drops Enter.
  setDisabled(disabled: boolean): void {
    this.inner.disableSubmit = disabled;
  }

  // Re-bind to the live TUI at boot so rendering and paging see the real
  // terminal dimensions. Called once by the composition root.
  bind(tui: TUI): void {
    this.delegate.bind(tui);
  }

  getText(): string {
    return this.inner.getText();
  }

  setText(text: string): void {
    this.inner.setText(text);
  }

  handleInput(data: string): void {
    this.inner.handleInput(data);
  }

  render(width: number): string[] {
    return this.inner.render(width);
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}
