// Interactive TUI controller over the solo lane (issue #75, #88).
//
// Headless snapshots only (no VirtualTerminal in Pi 0.85.1): the root
// VStack renders pure, like renderLayout in layout.test.ts. Faux-only,
// zero network.
import { describe, expect, it } from 'vitest';
import type { ApprovalOverlayTui } from './approval-view.js';
import { createTuiApp, seedFromPresentation } from './tui-app.js';

const SESSION = 'sess-1';
const MODEL = 'test-model';

describe('tui app root (issue #75)', () => {
  it('orders tree / transcript / status top to bottom at 100 cols', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const doc = app.render(100).join('\n');
    const order = [
      '◌ solo',
      'Kubic — terminal coding agent',
      'approvals:on',
    ].map((marker) => doc.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('hides the tree only below 80 columns', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const wide = app.render(100).join('\n');
    expect(wide).toContain('◌ solo');
    const narrow = app.render(70).join('\n');
    expect(narrow).not.toMatch(/[✓●◌]/);
    expect(narrow).toContain(`session ${SESSION}`);
    expect(narrow).toContain('approvals:on');
  });

  it('routes Ctrl-T to the tree toggle and keeps T/t for the draft', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    app.applyLaneEvent({
      type: 'tool-start',
      toolCallId: 't1',
      toolName: 'read',
    });
    expect(app.render(100).join('\n')).toContain('● read');
    // Issue #88: Ctrl-T toggles the tree. Sent in BOTH encodings, because
    // the classification goes through parseKey — the legacy byte here and
    // the Kitty CSI-u form ('\x1b[116;5u') below.
    expect(app.handleInput('\x14')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(app.render(100).join('\n')).toContain('…1 call');
    expect(app.render(100).join('\n')).not.toContain('● read');
    expect(app.handleInput('\x1b[116;5u')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(app.render(100).join('\n')).toContain('● read');
    expect(app.render(100).join('\n')).not.toContain('…1 call');
    // Issue #88: the editor owns plain characters — T/t are prompt text,
    // never toggles (a coding-agent prompt must be able to spell "test").
    for (const ch of 'Tt') app.handleInput(ch);
    expect(app.editor.getText()).toBe('Tt');
    expect(app.render(100).join('\n')).toContain('● read');
  });

  it('quits on Ctrl-C and passes other keys through', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(app.handleInput('\x03')).toEqual({
      quit: true,
      consumed: true,
      cancel: true,
    });
    // Any other key is neither a quit nor a cancel: it reaches the draft.
    expect(app.handleInput('x')).toMatchObject({ quit: false, cancel: false });
    expect(app.editor.getText()).toBe('x');
  });

  it('quits on Esc and on Ctrl-D with an empty draft', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(app.handleInput('\x1b')).toEqual({
      quit: true,
      consumed: true,
      cancel: false,
    });
    expect(app.handleInput('\x04')).toEqual({
      quit: true,
      consumed: true,
      cancel: false,
    });
  });

  it('keeps Ctrl-D as delete-forward while the draft is non-empty', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
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
      mode: 'solo',
      approvalsSkipped: false,
    });
    app.applyLaneEvent({ type: 'run-start' });
    expect(app.render(100).join('\n')).toContain('● solo');
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
    expect(app.render(100).join('\n')).toContain('$0.02');
  });

  it('renders the context gauge from the seed and follows setContextLimits (#347)', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
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
    expect(app.render(120).join('\n')).toContain('ctx 42%');
    // A switch to a model with a wider window moves the gauge.
    app.setContextLimits({ contextWindow: 4000, compactionThreshold: 3000 });
    expect(app.render(120).join('\n')).toContain('ctx 11%');
    // A model whose window is unknown clears it: no made-up percentage.
    app.setContextLimits({});
    expect(app.render(120).join('\n')).not.toContain('ctx ');
  });

  it('prints the final document with transcript and status', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
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
    expect(doc).toContain(`session ${SESSION}`);
    expect(doc.indexOf('final words')).toBeLessThan(
      doc.indexOf(`session ${SESSION}`),
    );
    expect(doc).toContain('approvals:on');
  });
});

describe('presentation seed (issue #75; §66 contracts only)', () => {
  it('maps the core presentation snapshot to a tui seed', () => {
    const seed = seedFromPresentation(
      {
        session: { sessionId: 'abc' },
        agents: new Map(),
        lanes: new Map(),
        workers: new Map(),
        approvals: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        connection: { status: 'connected' },
      },
      MODEL,
      { mode: 'solo', approvalsSkipped: true },
    );
    expect(seed).toEqual({
      sessionId: 'abc',
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: true,
    });
  });
});

describe('prompt loop routing (issue #88)', () => {
  it('submits a typed prompt from the editor through Enter', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
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
      mode: 'solo',
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
      mode: 'solo',
      approvalsSkipped: false,
    });
    for (const ch of 'hello') app.handleInput(ch);
    expect(app.render(100).join('\n')).toContain('hello');
  });

  it('accepts a multi-line prompt with Ctrl-J then submits it whole', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
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
      mode: 'solo',
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
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(app.isBusy()).toBe(false);
    app.setBusy(true);
    expect(app.isBusy()).toBe(true);
    app.setBusy(false);
    expect(app.isBusy()).toBe(false);
  });
});

describe('queued follow-ups and steers while a turn runs (issue #334)', () => {
  const app = () =>
    createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
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
    expect(ui.render(100).join('\n')).not.toContain('› also run the tests');
    ui.setQueuedPrompts(['also run the tests']);
    const doc = ui.render(100).join('\n');
    expect(doc).toContain('queued: also run the tests');
    // The inbox list is a snapshot: a fresh call replaces it.
    ui.setQueuedPrompts([]);
    expect(ui.render(100).join('\n')).not.toContain('queued:');
  });

  it('echoes an accepted submit, and a refused one instead names the reason', () => {
    const ui = app();
    ui.onSubmit(() => 'accepted');
    for (const ch of 'first') ui.handleInput(ch);
    ui.handleInput('\r');
    expect(ui.render(100).join('\n')).toContain('› first');
    const refused = app();
    refused.setEditorFooter('error: an orchestrator run is in flight');
    refused.onSubmit(() => 'refused');
    for (const ch of 'dropped') refused.handleInput(ch);
    refused.handleInput('\r');
    const doc = refused.render(100).join('\n');
    expect(doc).not.toContain('› dropped');
    expect(doc).toContain('error: an orchestrator run is in flight');
    // Issue #334 (review): a refused prompt never eats the draft — Pi's
    // editor cleared it before onSubmit fired, so it is put back.
    expect(refused.editor.getText()).toBe('dropped');
    expect(refused.render(100).join('\n')).toContain('dropped');
    // A restored draft is editable again, and Enter submits it once the loop
    // accepts (no stale refusal latch).
    refused.onSubmit(() => 'accepted');
    refused.handleInput('\r');
    expect(refused.editor.getText()).toBe('');
  });

  it('hands a draft back through restoreDraft (#334 review)', () => {
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
    ui.setQueuedPrompts(['queued prompt']);
    expect(ui.render(100).join('\n')).toContain('queued: queued prompt');
    // The inbox placed it: the row goes, the pending echo takes over.
    ui.setQueuedPrompts([]);
    ui.setPendingEcho('queued prompt');
    const doc = ui.render(100).join('\n');
    expect(doc).not.toContain('queued: queued prompt');
    expect(doc).toContain('› queued prompt');
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

describe('lane snapshot feed (issue #88)', () => {
  it('lands committed lane entries in the transcript view', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
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
    expect(doc).toContain('› fix it');
    expect(doc).toContain('done and dusted');
  });

  it('replaces cells on a re-apply instead of duplicating them', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
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

  // Issue #227: a `/model` switch lands on every surface that names the
  // model — header, welcome block and status bar — through one call, so the
  // three cannot drift apart.
  it('updates header, welcome and status bar on a model switch', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      thinking: 'high',
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(app.status.getState().model).toBe(MODEL);
    expect(app.status.getState().thinking).toBe('high');
    const before = app.render(100).join('\n');
    expect(before).toContain(MODEL);
    expect(before).toContain(`model ${MODEL}`);
    expect(
      before.split('\n').some((l) => l.includes('solo') && l.includes(MODEL)),
    ).toBe(true);

    app.setModel('alt/m1', 'medium');

    expect(app.status.getState().model).toBe('alt/m1');
    expect(app.status.getState().thinking).toBe('medium');
    const doc = app.render(100).join('\n');
    expect(doc).toContain('alt/m1');
    expect(doc).toContain('model alt/m1');
    expect(
      doc.split('\n').some((l) => l.includes('solo') && l.includes('alt/m1')),
    ).toBe(true);
    expect(app.status.render(100).join('\n')).toContain('alt/m1');
    expect(doc).not.toContain(MODEL);
  });

  it('keeps the thinking level when a switch does not carry one', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(app.status.getState().thinking).toBe('off');
    app.setModel('alt/m1');
    expect(app.status.getState().model).toBe('alt/m1');
    expect(app.status.getState().thinking).toBe('off');
  });
});

describe('model picker and thinking cycle (issue #328)', () => {
  const app = () =>
    createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });

  // The overlay seat the composition root attaches in prod: the picker is
  // shown through the same host the approval dialog uses.
  const pickerHost = () => {
    const shown: Array<{ render: (width: number) => string[] }> = [];
    let hidden = 0;
    return {
      shown,
      get hidden() {
        return hidden;
      },
      host: {
        showOverlay: (component: unknown) => {
          shown.push(component as { render: (width: number) => string[] });
          return {
            unfocus: () => {},
            hide: () => {
              hidden += 1;
            },
          };
        },
      } as unknown as ApprovalOverlayTui,
    };
  };

  it('classifies Alt+M and Alt+T for the loop', () => {
    const ui = app();
    expect(ui.handleInput('\u001bm')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
      pickModel: true,
    });
    expect(ui.handleInput('\u001bt')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
      cycleThinking: true,
    });
    // Kitty CSI-u encodings classify the same (parseKey, not raw bytes).
    expect(ui.handleInput('\u001b[109;3u')).toMatchObject({ pickModel: true });
    expect(ui.handleInput('\u001b[116;3u')).toMatchObject({
      cycleThinking: true,
    });
  });

  it('opens the picker overlay and reports the chosen row', () => {
    const ui = app();
    const seat = pickerHost();
    ui.attachApprovalOverlay(seat.host);
    const picked: string[] = [];
    expect(
      ui.openModelPicker({
        rows: [
          { provider: 'faux', id: 'big', label: 'faux/big', current: true },
          {
            provider: 'alt',
            id: 'm1',
            label: 'alt/m1',
            note: 'models.json',
          },
        ],
        onSelect: (row) => picked.push(`${row.provider}/${row.id}`),
      }),
    ).toBe(true);
    expect(ui.isModelPickerOpen()).toBe(true);
    const frame = seat.shown[0]?.render(80).join('\n') ?? '';
    // The live model is marked and the note renders as its description.
    expect(frame).toContain('faux/big (current)');
    expect(frame).toContain('alt/m1');
    expect(frame).toContain('models.json');
    // The picker is modal: arrows move it and Enter selects the second row.
    ui.handleInput('\u001b[B');
    ui.handleInput('\r');
    expect(picked).toEqual(['alt/m1']);
    expect(ui.isModelPickerOpen()).toBe(false);
    expect(seat.hidden).toBe(1);
    // Modal means the editor never saw those keys.
    expect(ui.editor.getText()).toBe('');
  });

  it('cancels the picker with Esc and leaves the model alone', () => {
    const ui = app();
    const seat = pickerHost();
    ui.attachApprovalOverlay(seat.host);
    let cancelled = 0;
    ui.openModelPicker({
      rows: [{ provider: 'faux', id: 'big', label: 'faux/big', current: true }],
      onSelect: () => {},
      onCancel: () => {
        cancelled += 1;
      },
    });
    expect(ui.handleInput('\u001b')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(ui.isModelPickerOpen()).toBe(false);
    expect(cancelled).toBe(1);
    expect(seat.hidden).toBe(1);
  });

  it('refuses to open the picker without an overlay seat', () => {
    const ui = app();
    expect(
      ui.openModelPicker({
        rows: [{ provider: 'faux', id: 'big', label: 'faux/big' }],
        onSelect: () => {},
      }),
    ).toBe(false);
    expect(ui.isModelPickerOpen()).toBe(false);
  });
});
