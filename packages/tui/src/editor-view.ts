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

import { RULE_MARK } from './editor-frame.js';
import { tuiTheme } from './theme.js';
import type {
  AutocompleteProvider,
  Component,
  EditorTheme,
  Focusable,
  TUI,
} from './tui-boundary.js';
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

// Issue #340: how many prompts Up can recall — Pi's editor keeps the newest
// 100 itself, so seeding more would only be dropped; the bound keeps a long
// resumed session cheap to seed.
export const PROMPT_HISTORY_MAX = 100;

export function editorTheme(): EditorTheme {
  // Read per call so a theme set after construction applies.
  const ui = () => tuiTheme().ui;
  return {
    // Issue #454: the rules only carry the frame's marker; the frame
    // (editor-frame.ts) draws and colours the box around them.
    borderColor: (text: string): string => `${RULE_MARK}${text}`,
    selectList: {
      selectedPrefix: (text: string): string => ui().fg('accent')(text),
      selectedText: (text: string): string =>
        ui().style({ fg: 'fg0', bold: true })(text),
      description: (text: string): string => ui().fg('fg2')(text),
      scrollInfo: (text: string): string => ui().fg('fg3')(text),
      noMatch: (text: string): string => ui().fg('fg2')(text),
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
  // Issue #338 (review): an image-only prompt is a prompt. The app owns the
  // pending attachments, so it answers this before the wrapper drops a blank
  // draft — otherwise attach + Enter is a silent no-op while the footer says
  // "Enter sends it". Absent means the shipped behaviour (blank is a no-op).
  allowEmptySubmit: () => boolean = () => false;

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
      if (prompt === '' && !this.allowEmptySubmit()) return;
      if (prompt !== '') this.recordHistory(prompt);
      this.onSubmit?.(prompt);
    };
  }

  private readonly history: string[];

  private recordHistory(prompt: string): void {
    if (this.history[0] === prompt) return;
    this.history.unshift(prompt);
    if (this.history.length > PROMPT_HISTORY_MAX) this.history.pop();
    this.inner.addToHistory(prompt);
  }

  // Issue #340 (§16.5): seed the history from a resumed session's committed
  // prompts, oldest first (newest last), so Up recalls what the previous
  // process sent. Only the newest PROMPT_HISTORY_MAX are replayed, through
  // the same consecutive-dedup rule a live submit follows.
  seedHistory(prompts: readonly string[]): void {
    const recent = prompts
      .map((prompt) => prompt.trim())
      .filter((prompt) => prompt !== '')
      .slice(-PROMPT_HISTORY_MAX);
    for (const prompt of recent) this.recordHistory(prompt);
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

  // While a turn is in flight the loop keeps the editor ENABLED (#334):
  // Enter queues the draft as a follow-up in the conversation's inbox and
  // Alt+Enter steers, so there is nothing to disable. `disableSubmit` stays
  // available for embedders that own a stricter loop.
  setDisabled(disabled: boolean): void {
    this.inner.disableSubmit = disabled;
  }

  // Re-bind to the live TUI at boot so rendering and paging see the real
  // terminal dimensions. Called once by the composition root.
  bind(tui: TUI): void {
    this.delegate.bind(tui);
  }

  // Issue #305: the registry's `/`-command autocomplete, handed to Pi's
  // editor (it owns the popup, the debounce and the completion keys).
  setAutocomplete(provider: AutocompleteProvider): void {
    this.inner.setAutocompleteProvider(provider);
  }

  getText(): string {
    return this.inner.getText();
  }

  // Issue #454: Esc closes the dropdown before it means anything else.
  isShowingAutocomplete(): boolean {
    return this.inner.isShowingAutocomplete();
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
