// Interactive TUI controller over the lane.
//
// Headless snapshots only (no VirtualTerminal in Pi 0.85.1): the root
// VStack renders pure, like renderLayout in layout.test.ts. Faux-only,
// zero network.

import { describe, expect, it, vi } from 'vitest';
import { QUIT_ARM_MS } from './app/quit.js';
import { createKeyRegistry } from './keybindings.js';
import { presentation, SESSION } from './test-support/presentation.js';
import { createTuiApp } from './tui-app.js';

const MODEL = 'test-model';

describe('tui app root', () => {
  it('orders header / transcript / status / hints top to bottom', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    const rows = app.render(100);
    const doc = rows.join('\n');
    const order = ['■ KUBIC', 'PREFLIGHT', `${MODEL} · off`, '⏎ send'].map(
      (marker) => doc.indexOf(marker),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The header is the first row; the status line and the hints the last.
    expect(rows[0]).toContain(`session ${SESSION} │ approvals on`);
    expect(rows.at(-2)?.endsWith(' ready ')).toBe(true);
    expect(rows.at(-1)).toContain('^C quit');
  });

  it('hides the tree row until Ctrl-T, and always below 80 columns', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    expect(app.render(100).join('\n')).not.toContain('◌ default');
    app.handleInput('\x14');
    expect(app.render(100).join('\n')).toContain('◌ default');
    const narrow = app.render(70).join('\n');
    expect(narrow).not.toContain('◌ default');
    expect(narrow).toContain('approvals on');
  });

  it('routes Ctrl-T to the tree toggle and keeps T/t for the draft', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    app.applyPresentation(
      presentation({
        tools: [
          {
            toolCallId: 't1',
            toolName: 'read',
            status: 'running',
            isError: false,
          },
        ],
      }),
    );
    // The tree row starts hidden.
    expect(app.render(100).join('\n')).not.toContain('● read');
    // Ctrl-T toggles the tree. Sent in BOTH encodings, because
    // the classification goes through parseKey — the legacy byte here and
    // the Kitty CSI-u form ('\x1b[116;5u') below.
    expect(app.handleInput('\x14')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(app.render(100).join('\n')).toContain('● read');
    expect(app.handleInput('\x1b[116;5u')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(app.render(100).join('\n')).not.toContain('● read');
    app.handleInput('\x14');
    // The editor owns plain characters — T/t are prompt text,
    // never toggles (a coding-agent prompt must be able to spell "test").
    for (const ch of 'Tt') app.handleInput(ch);
    expect(app.editor.getText()).toBe('Tt');
    expect(app.render(100).join('\n')).toContain('● read');
  });

  // The key model — Esc never quits, Ctrl-C clears a draft and
  // then quits on a double press within QUIT_ARM_MS, Ctrl-D quits on an
  // empty editor.
  const CONSUMED = { quit: false, consumed: true, cancel: false };

  it('arms on an idle Ctrl-C and quits on the second press', () => {
    vi.useFakeTimers();
    try {
      const app = createTuiApp({
        sessionId: SESSION,
        model: MODEL,
        approvalsSkipped: false,
      });
      expect(app.handleInput('\x03')).toEqual(CONSUMED);
      expect(app.render(100).join('\n')).toContain('press ^C again to quit');
      vi.advanceTimersByTime(QUIT_ARM_MS - 1);
      expect(app.handleInput('\x03')).toEqual({
        quit: true,
        consumed: true,
        cancel: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms after the window and clears the notice', () => {
    vi.useFakeTimers();
    try {
      const app = createTuiApp({
        sessionId: SESSION,
        model: MODEL,
        approvalsSkipped: false,
      });
      app.handleInput('\x03');
      vi.advanceTimersByTime(QUIT_ARM_MS);
      expect(app.render(100).join('\n')).not.toContain('again to quit');
      // A lapsed arm starts over: the next press arms again.
      expect(app.handleInput('\x03')).toEqual(CONSUMED);
      // Any other key still reaches the draft.
      expect(app.handleInput('x')).toEqual(CONSUMED);
      expect(app.editor.getText()).toBe('x');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never quits on Esc; Ctrl-D quits on an empty draft', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    expect(app.handleInput('\x1b')).toEqual(CONSUMED);
    expect(app.handleInput('\x1b')).toEqual(CONSUMED);
    expect(app.handleInput('\x04')).toEqual({
      quit: true,
      consumed: true,
      cancel: false,
    });
  });

  it('keeps a composed draft on Esc', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    for (const ch of 'hello') app.handleInput(ch);
    expect(app.handleInput('\x1b')).toEqual(CONSUMED);
    expect(app.handleInput('\x1b')).toEqual(CONSUMED);
    expect(app.editor.getText()).toBe('hello');
  });

  it('clears a composed draft on idle Ctrl-C before arming', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    for (const ch of 'hi') app.handleInput(ch);
    expect(app.handleInput('\x03')).toEqual(CONSUMED);
    expect(app.editor.getText()).toBe('');
    expect(app.render(100).join('\n')).toContain('^C: draft cleared');
    // The empty editor now arms; only the press after that quits.
    expect(app.handleInput('\x03')).toEqual(CONSUMED);
    expect(app.handleInput('\x03')).toEqual({
      quit: true,
      consumed: true,
      cancel: true,
    });
  });

  it('interrupts a running turn on Esc without quitting', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    app.setBusy(true);
    for (const ch of 'queued thought') app.handleInput(ch);
    // Busy: Esc is an interrupt — the root aborts the turn and keeps the
    // session; the draft stays for the next turn.
    expect(app.handleInput('\x1b')).toEqual({
      quit: false,
      consumed: true,
      cancel: true,
      interrupt: true,
    });
    expect(app.editor.getText()).toBe('queued thought');
    // Ctrl-C during a turn keeps its cancel-then-quit classification.
    expect(app.handleInput('\x03')).toEqual({
      quit: true,
      consumed: true,
      cancel: true,
    });
  });

  it('closes the editor dropdown on Esc before anything else', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    const showing = vi
      .spyOn(app.editor, 'isShowingAutocomplete')
      .mockReturnValue(true);
    const forwarded = vi.spyOn(app.editor, 'handleInput');
    app.setBusy(true);
    expect(app.handleInput('\x1b')).toEqual(CONSUMED);
    expect(forwarded).toHaveBeenCalledWith('\x1b');
    showing.mockRestore();
  });

  it('still quits through an operator-bound app.exit key', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
      keys: createKeyRegistry({ 'app.exit': ['ctrl+q'] }),
    });
    for (const ch of 'draft') app.handleInput(ch);
    expect(app.handleInput('\x11')).toEqual(CONSUMED);
    expect(app.editor.getText()).toBe('');
    expect(app.handleInput('\x11')).toEqual({
      quit: true,
      consumed: true,
      cancel: false,
    });
  });

  it('keeps Ctrl-D as delete-forward while the draft is non-empty', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    for (const ch of 'ab') app.handleInput(ch);
    app.handleInput('\x1b[D');
    expect(app.handleInput('\x04')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(app.editor.getText()).toBe('a');
  });

  it('replicates lane events and usage into the rows', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    app.applyPresentation(presentation());
    app.handleInput('\x14');
    expect(app.render(100).join('\n')).toContain('● default');
    app.setUsage([
      {
        model: MODEL,
        provider: 'faux',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.02,
          },
        },
      },
    ]);
    expect(app.render(100).join('\n')).toContain('$0.020');
  });

  it('renders the context gauge from the seed and follows setContextLimits', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
      contextWindow: 1000,
      compactionThreshold: 500,
    });
    // A committed request (an entry id) whose prompt was 420 tokens.
    app.setUsage([
      {
        model: MODEL,
        provider: 'faux',
        entryId: 'e1',
        usage: {
          input: 300,
          output: 5,
          cacheRead: 120,
          cacheWrite: 0,
          totalTokens: 425,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.02,
          },
        },
      },
    ]);
    expect(app.render(120).join('\n')).toContain('42% of 1k');
    // A switch to a model with a wider window moves the gauge.
    app.setContextLimits({ contextWindow: 4000, compactionThreshold: 3000 });
    expect(app.render(120).join('\n')).toContain('11% of 4k');
    // A model whose window is unknown clears it: no made-up percentage.
    app.setContextLimits({});
    expect(app.render(120).join('\n')).not.toContain('ctx ');
  });

  it('prints the final document with transcript and status', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    app.applyLaneEntries([
      {
        id: 'a1',
        seq: 1,
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'final words' }],
        },
      },
    ]);
    const doc = app.finalDocument(100).join('\n');
    expect(doc).toContain('final words');
    // The header above the transcript, the status line below.
    expect(doc.indexOf(`session ${SESSION}`)).toBeLessThan(
      doc.indexOf('final words'),
    );
    expect(doc.indexOf('final words')).toBeLessThan(doc.indexOf(' ready '));
    expect(doc).toContain('approvals on');
  });
});

describe('prompt loop routing', () => {
  it('submits a typed prompt from the editor through Enter', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    const submitted: string[] = [];
    app.onSubmit((text) => {
      submitted.push(text);
      return 'accepted';
    });
    for (const ch of 'fix the bug') app.handleInput(ch);
    expect(app.handleInput('\r')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(submitted).toEqual(['fix the bug']);
    // The draft is cleared, so a second Enter submits nothing.
    expect(app.handleInput('\r')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(submitted).toEqual(['fix the bug']);
  });

  it('routes every editor key to the draft instead of the tree', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    const submitted: string[] = [];
    app.onSubmit((text) => {
      submitted.push(text);
      return 'accepted';
    });
    for (const ch of 'tT x') app.handleInput(ch);
    // T/t are prompt characters while typing, never toggles.
    expect(app.handleInput('\r')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(submitted).toEqual(['tT x']);
  });

  it('renders the draft into the editor row', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    for (const ch of 'hello') app.handleInput(ch);
    expect(app.render(100).join('\n')).toContain('hello');
  });

  it('accepts a multi-line prompt with Ctrl-J then submits it whole', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    const submitted: string[] = [];
    app.onSubmit((text) => {
      submitted.push(text);
      return 'accepted';
    });
    for (const ch of 'first') app.handleInput(ch);
    app.handleInput('\n');
    for (const ch of 'second') app.handleInput(ch);
    app.handleInput('\r');
    expect(submitted).toEqual(['first\nsecond']);
  });

  it('ignores Enter on an empty draft', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    const submitted: string[] = [];
    app.onSubmit((text) => {
      submitted.push(text);
      return 'accepted';
    });
    expect(app.handleInput('\r')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(submitted).toEqual([]);
  });

  it('reports the loop as busy only while a turn is in flight', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    expect(app.isBusy()).toBe(false);
    app.setBusy(true);
    expect(app.isBusy()).toBe(true);
    app.setBusy(false);
    expect(app.isBusy()).toBe(false);
  });
});

describe('queued follow-ups and steers while a turn runs', () => {
  const app = () =>
    createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });

  it('keeps Enter live during a turn and renders the queued row from the inbox', () => {
    const ui = app();
    const submitted: string[] = [];
    ui.onSubmit((text) => {
      submitted.push(text);
      return 'queued';
    });
    ui.setBusy(true);
    for (const ch of 'also run the tests') ui.handleInput(ch);
    expect(ui.handleInput('\r')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(submitted).toEqual(['also run the tests']);
    // A queued prompt is NOT echoed as a pending turn: the queued row is the
    // feedback (the lane's inbox drives it).
    expect(ui.render(100).join('\n')).not.toContain('▌ also run the tests');
    ui.applyPresentation(presentation({ queued: ['also run the tests'] }));
    const doc = ui.render(100).join('\n');
    expect(doc).toContain('queued: also run the tests');
    // The inbox list is a snapshot: a fresh state replaces it.
    ui.applyPresentation(presentation());
    expect(ui.render(100).join('\n')).not.toContain('queued:');
  });

  it('echoes an accepted submit, and a refused one instead names the reason', () => {
    const ui = app();
    ui.onSubmit(() => 'accepted');
    for (const ch of 'first') ui.handleInput(ch);
    ui.handleInput('\r');
    expect(ui.render(100).join('\n')).toContain('▌ first');
    const refused = app();
    refused.setEditorFooter('error: a run is in flight');
    refused.onSubmit(() => 'refused');
    for (const ch of 'dropped') refused.handleInput(ch);
    refused.handleInput('\r');
    const doc = refused.render(100).join('\n');
    // No pending echo in the transcript (the editor's own `›` caret shows the
    // restored draft below).
    expect(refused.transcript.render(100).join('\n')).not.toContain(
      '▌ dropped',
    );
    expect(doc).toContain('error: a run is in flight');
    // A refused prompt never eats the draft — Pi's
    // editor cleared it before onSubmit fired, so it is put back.
    expect(refused.editor.getText()).toBe('dropped');
    expect(refused.render(100).join('\n')).toContain('dropped');
    // A restored draft is editable again, and Enter submits it once the loop
    // accepts (no stale refusal latch).
    refused.onSubmit(() => 'accepted');
    refused.handleInput('\r');
    expect(refused.editor.getText()).toBe('');
  });

  it('hands a draft back through restoreDraft', () => {
    const ui = app();
    ui.onSubmit(() => 'accepted');
    for (const ch of 'keep me') ui.handleInput(ch);
    ui.editor.setText('');
    ui.restoreDraft('keep me');
    expect(ui.editor.getText()).toBe('keep me');
    expect(ui.render(100).join('\n')).toContain('keep me');
  });

  it('echoes a queued prompt once its turn starts', () => {
    const ui = app();
    ui.applyPresentation(presentation({ queued: ['queued prompt'] }));
    expect(ui.render(100).join('\n')).toContain('queued: queued prompt');
    // The inbox placed it: the row goes, the pending echo takes over.
    ui.applyPresentation(presentation());
    ui.setPendingEcho('queued prompt');
    const doc = ui.render(100).join('\n');
    expect(doc).not.toContain('queued: queued prompt');
    expect(doc).toContain('▌ queued prompt');
  });

  it('Alt+Enter hands the draft to the loop as a steer and clears it', () => {
    const ui = app();
    ui.onSubmit(() => 'accepted');
    for (const ch of 'use pnpm') ui.handleInput(ch);
    // Legacy encoding (\x1b\r) — parseKey classifies it as alt+enter when
    // the Kitty protocol is not active, which is the test terminal's case.
    expect(ui.handleInput('\x1b\r')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
      steer: 'use pnpm',
    });
    expect(ui.editor.getText()).toBe('');
    // An empty draft is a no-op, never a blank steer.
    expect(ui.handleInput('\x1b\r')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
  });
});

describe('lane snapshot feed', () => {
  it('lands committed lane entries in the transcript view', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    app.applyLaneEntries([
      {
        id: 'u1',
        seq: 1,
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      },
      {
        id: 'a1',
        seq: 2,
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done and dusted' }],
        },
      },
    ]);
    const doc = app.render(100).join('\n');
    expect(doc).toContain('▌ fix it');
    expect(doc).toContain('done and dusted');
  });

  it('replaces cells on a re-apply instead of duplicating them', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    const entry = {
      id: 'a1',
      seq: 2,
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'only once' }],
      },
    };
    app.applyLaneEntries([entry]);
    app.applyLaneEntries([entry]);
    const occurrences = app.render(100).join('\n').split('only once').length;
    expect(occurrences).toBe(2);
  });

  // A `/model` switch lands on every surface that names the
  // model — header, welcome block and status bar — through one call, so the
  // three cannot drift apart.
  it('updates header, welcome and status bar on a model switch', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      thinking: 'high',
      approvalsSkipped: false,
    });
    expect(app.status.getState().model).toBe(MODEL);
    expect(app.status.getState().thinking).toBe('high');
    const before = app.render(100).join('\n');
    expect(before).toContain(`provider     ${MODEL}`);
    expect(app.status.render(100).join('\n')).toContain(`${MODEL} · high`);

    app.setModel('alt/m1', 'medium');

    expect(app.status.getState().model).toBe('alt/m1');
    expect(app.status.getState().thinking).toBe('medium');
    const doc = app.render(100).join('\n');
    expect(doc).toContain('provider     alt/m1');
    expect(app.status.render(100).join('\n')).toContain('alt/m1 · medium');
    expect(doc).not.toContain(MODEL);
  });

  it('keeps the thinking level when a switch does not carry one', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      approvalsSkipped: false,
    });
    expect(app.status.getState().thinking).toBe('off');
    app.setModel('alt/m1');
    expect(app.status.getState().model).toBe('alt/m1');
    expect(app.status.getState().thinking).toBe('off');
  });
});
