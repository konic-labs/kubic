// Interactive TUI controller over the solo lane (issue #75, #88).
//
// Headless snapshots only (no VirtualTerminal in Pi 0.85.1): the root
// VStack renders pure, like renderLayout in layout.test.ts. Faux-only,
// zero network.
import { describe, expect, it, vi } from 'vitest';
import type {
  KubicPresentationState,
  LaneSnapshot,
} from '../../core/src/presentation.js';
import { createApprovalSurface } from './approval-surface.js';
import type {
  ApprovalOverlayTui,
  ApprovalViewRequest,
} from './approval-view.js';
import { createKeyRegistry } from './keybindings.js';
import { createTuiApp, seedFromPresentation } from './tui-app.js';

const SESSION = 'sess-1';
const MODEL = 'test-model';

// Issue #333: the app renders replicated state, so a test builds the state a
// projector would produce (the projector itself lives in host).
function presentation(
  over: Partial<LaneSnapshot> = {},
): KubicPresentationState {
  return {
    session: { sessionId: SESSION, mode: 'solo', approvalsSkipped: false },
    agents: new Map(),
    lanes: new Map([
      [
        SESSION,
        {
          laneId: SESSION,
          agentId: 'root',
          status: 'running',
          tools: [],
          queued: [],
          compacting: false,
          ...over,
        },
      ],
    ]),
    workers: new Map(),
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  };
}

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

  it('clears a composed draft on Esc before quitting (issue #302)', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    for (const ch of 'hello') app.handleInput(ch);
    expect(app.editor.getText()).toBe('hello');
    // The first Esc clears the draft — one press must never throw away a
    // composed prompt — and the session stays.
    expect(app.handleInput('\x1b')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(app.editor.getText()).toBe('');
    // Only a second Esc, on the now-empty draft, quits.
    expect(app.handleInput('\x1b')).toEqual({
      quit: true,
      consumed: true,
      cancel: false,
    });
  });

  it('clears a composed draft on idle Ctrl-C before quitting (issue #302)', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    for (const ch of 'hi') app.handleInput(ch);
    expect(app.handleInput('\x03')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(app.editor.getText()).toBe('');
    expect(app.handleInput('\x03')).toEqual({
      quit: true,
      consumed: true,
      cancel: true,
    });
  });

  it('routes Esc through the cancel-first path while a turn runs (issue #302)', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    app.setBusy(true);
    for (const ch of 'queued thought') app.handleInput(ch);
    // Busy: Esc is a cancel, exactly like Ctrl-C — the root aborts the turn
    // and keeps the session, so the draft is NOT silently dropped either.
    expect(app.handleInput('\x1b')).toEqual({
      quit: true,
      consumed: true,
      cancel: true,
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
    app.applyPresentation(presentation());
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
        session: {
          sessionId: 'abc',
          mode: 'solo',
          approvalsSkipped: false,
        },
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
    ui.applyPresentation(presentation({ queued: ['queued prompt'] }));
    expect(ui.render(100).join('\n')).toContain('queued: queued prompt');
    // The inbox placed it: the row goes, the pending echo takes over.
    ui.applyPresentation(presentation());
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

  it('refuses the picker on a terminal below the overlay minimum (#328 review)', () => {
    const ui = app();
    const shown: unknown[] = [];
    // A 50-column host: Pi's own visible() gate would refuse to composite
    // the overlay, so the picker must not become an invisible modal.
    ui.attachApprovalOverlay({
      showOverlay: (component: unknown) => {
        shown.push(component);
        return { unfocus: () => {}, hide: () => {} };
      },
      terminal: { columns: 50, rows: 30 },
    } as unknown as ApprovalOverlayTui);
    expect(
      ui.openModelPicker({
        rows: [{ provider: 'faux', id: 'big', label: 'faux/big' }],
        onSelect: () => {},
      }),
    ).toBe(false);
    expect(ui.isModelPickerOpen()).toBe(false);
    expect(shown).toEqual([]);
    // Input still reaches the editor: the refused picker is not modal.
    for (const ch of 'hi') ui.handleInput(ch);
    expect(ui.editor.getText()).toBe('hi');
  });

  it('closes the picker when the terminal shrinks below the minimum (#328 review)', () => {
    const ui = app();
    let columns = 120;
    const seat = {
      showOverlay: () => ({ unfocus: () => {}, hide: () => {} }),
      terminal: {
        get columns() {
          return columns;
        },
        rows: 30,
      },
    } as unknown as ApprovalOverlayTui;
    ui.attachApprovalOverlay(seat);
    let cancelled = 0;
    expect(
      ui.openPicker({
        rows: [{ value: '/help', label: '/help' }],
        onSelect: () => {},
        onCancel: () => {
          cancelled += 1;
        },
      }),
    ).toBe(true);
    expect(ui.isModelPickerOpen()).toBe(true);
    // The overlay can no longer be composited: the next key closes the
    // picker (a cancel) and goes to the editor instead of vanishing.
    columns = 50;
    ui.handleInput('x');
    expect(ui.isModelPickerOpen()).toBe(false);
    expect(cancelled).toBe(1);
    expect(ui.editor.getText()).toBe('x');
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

describe('slash commands in the app (issue #305)', () => {
  const app = () =>
    createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
  // Pi's editor resolves the autocomplete provider asynchronously; two turns
  // of the microtask queue are enough for the suggestions to be rendered.
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('lists the registry commands as soon as a slash is typed', async () => {
    const ui = app();
    ui.handleInput('/');
    await settle();
    const frame = ui.render(100).join('\n');
    // The popup shows the first rows of the registry (Pi caps the list).
    expect(frame).toContain('/help');
    expect(frame).toContain('/session');
    expect(frame).toContain('/new');
    // The draft is still the operator's text.
    expect(ui.editor.getText()).toBe('/');
  });

  it('renders a command notice in the transcript, and a lane snapshot clears it', () => {
    const ui = app();
    ui.appendNotice(['/help — the commands', '/session — id, tokens, cost']);
    const doc = ui.render(100).join('\n');
    expect(doc).toContain('/help — the commands');
    expect(doc).toContain('/session — id, tokens, cost');
    // A lane snapshot is the session's own transcript: the notice goes, and
    // the NEXT notice starts from an empty list (review fix: a stale list
    // must not be re-applied under the new report).
    ui.applyLaneEntries([]);
    expect(ui.render(100).join('\n')).not.toContain('/help — the commands');
    ui.appendNotice(['/session — the second one']);
    const after = ui.render(100).join('\n');
    expect(after).toContain('/session — the second one');
    expect(after).not.toContain('/help — the commands');
    expect(after).not.toContain('/session — id, tokens, cost');
  });

  it('reports the session id, tokens and cost from the status rows', () => {
    const ui = app();
    ui.setUsage([
      {
        model: MODEL,
        provider: 'faux',
        usage: {
          input: 1200,
          output: 340,
          cacheRead: 10,
          cacheWrite: 0,
          totalTokens: 1550,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.25,
          },
        },
      },
    ]);
    const report = ui.sessionReport('/work/repo');
    expect(report).toContain(`session ${SESSION}`);
    expect(report).toContain('in /work/repo');
    expect(report).toContain(MODEL);
    expect(report).toContain('in 1200 out 340');
    expect(report).toContain('$0.25');
    // Without a known workspace the report simply omits it.
    expect(ui.sessionReport()).not.toContain('in /work/repo');
  });

  it('resets every session-scoped surface for /new and /resume', () => {
    const ui = app();
    ui.setUsage([
      {
        model: MODEL,
        provider: 'faux',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        },
      },
    ]);
    ui.appendNotice(['old turn']);
    ui.applyPresentation(
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
    ui.setPendingEcho('old echo');
    ui.applyPresentation(presentation({ queued: ['old queue'] }));
    expect(ui.render(100).join('\n')).toContain('old turn');

    ui.resetSession({ sessionId: 'sess-2', model: 'alt/m2', thinking: 'high' });

    const doc = ui.render(100).join('\n');
    expect(doc).not.toContain('old turn');
    expect(doc).not.toContain('old echo');
    expect(doc).not.toContain('old queue');
    expect(doc).not.toContain('● read');
    expect(doc).toContain('alt/m2');
    expect(doc).toContain('sess-2');
    // The usage rows are the new session's (none here), not the old totals.
    expect(ui.sessionReport()).toContain('in 0 out 0');
    expect(ui.sessionReport()).toContain('session sess-2');
  });

  it('opens the generic picker for the palette and the session list', () => {
    const ui = app();
    const shown: Array<{ render: (width: number) => string[] }> = [];
    ui.attachApprovalOverlay({
      showOverlay: (component: unknown) => {
        shown.push(component as { render: (width: number) => string[] });
        return { unfocus: () => {}, hide: () => {} };
      },
    } as unknown as ApprovalOverlayTui);
    const picked: string[] = [];
    expect(
      ui.openPicker({
        rows: [
          { value: '/help', label: '/help', description: 'list the commands' },
          { value: '/quit', label: '/quit', description: 'leave the TUI' },
        ],
        onSelect: (value) => picked.push(value),
      }),
    ).toBe(true);
    const frame = shown[0]?.render(80).join('\n') ?? '';
    expect(frame).toContain('/help');
    expect(frame).toContain('list the commands');
    ui.handleInput('\r');
    expect(picked).toEqual(['/help']);
    expect(ui.isModelPickerOpen()).toBe(false);
  });
});

describe('app-level wiring that no test executed (issue #320)', () => {
  const REQUEST: ApprovalViewRequest = {
    key: 'k-320',
    capability: 'destructive-shell',
    toolName: 'bash',
    command: 'rm -rf build',
  };

  function seat(): {
    host: ApprovalOverlayTui;
    shown: unknown[];
    renders: number;
  } {
    const state = { shown: [] as unknown[], renders: 0 };
    const host = {
      showOverlay: (component: unknown) => {
        state.shown.push(component);
        return { unfocus: () => {}, hide: () => {} };
      },
      requestRender: () => {
        state.renders += 1;
      },
      terminal: { columns: 120, rows: 30 },
    } as unknown as ApprovalOverlayTui;
    return Object.assign(state, { host });
  }

  it('repaints the live screen when an ask arrives after the overlay is attached', async () => {
    // armingMs 0: this test is about the repaint, not the arming delay.
    const surface = createApprovalSurface({ armingMs: 0 });
    const ui = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    const seatState = seat();
    ui.attachApprovalOverlay(seatState.host);
    expect(ui.hasPendingApproval()).toBe(false);
    const before = seatState.renders;
    const pending = ui.requestApproval(REQUEST);
    // The ask itself asks for a frame: an async lane turn must not wait for
    // the next keypress to show its dialog.
    expect(seatState.renders).toBeGreaterThan(before);
    expect(seatState.shown).toHaveLength(1);
    expect(ui.hasPendingApproval()).toBe(true);
    surface.decide('d');
    await pending;
  });

  it('shows an ask that arrived before the overlay was attached', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const ui = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    // The lane asked while the app had no seat (the boot order in tui-run).
    const pending = ui.requestApproval(REQUEST);
    const seatState = seat();
    ui.attachApprovalOverlay(seatState.host);
    // Attaching syncs the overlay to the surface's pending request.
    expect(seatState.shown).toHaveLength(1);
    expect(ui.hasPendingApproval()).toBe(true);
    surface.decide('d');
    await pending;
  });

  it('clears the echoed prompt when a busy turn ends with no lane commit', () => {
    const ui = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    ui.onSubmit(() => 'accepted');
    ui.setBusy(true);
    for (const ch of 'zzz echo me') ui.handleInput(ch);
    ui.handleInput('\r');
    // The prompt is echoed while the lane works (#88).
    expect(ui.render(100).join('\n')).toContain('› zzz echo me');
    // The turn ends without committing the entry (an abort, or a settle with
    // no commit): the echo must not outlive the turn it belongs to.
    ui.setBusy(false);
    const doc = ui.render(100).join('\n');
    expect(doc).not.toContain('› zzz echo me');
    expect(doc).not.toContain('zzz echo me');
  });

  it('has no uncalled setNotice on the app surface (issue #320)', () => {
    const ui = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect('setNotice' in ui).toBe(false);
  });
});

// Issue #303 (§16.6/§16.9): the app dispatches through the keybinding
// registry, so an override rebinds the action everywhere — the dispatch,
// the global-key claim ahead of the editor and the hints.
describe('keybinding overrides in the app (issue #303)', () => {
  const rebound = () =>
    createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
      keys: createKeyRegistry({
        'panel.diff': ['ctrl+g'],
        'session.mode': ['alt+g'],
      }),
    });

  it('ctrl+g toggles the diff panel and ctrl+o reaches the editor', () => {
    const ui = rebound();
    ui.handleInput('\x07');
    expect(ui.panelMode()).toBe('diff');
    ui.handleInput('\x07');
    expect(ui.panelMode()).toBe('closed');
    const toEditor = vi.spyOn(ui.editor, 'handleInput');
    ui.handleInput('\x0f');
    expect(toEditor).toHaveBeenCalledWith('\x0f');
    expect(ui.panelMode()).toBe('closed');
  });

  it('the key hints name the rebound key', () => {
    const frame = rebound().render(160).join('\n');
    expect(frame).toContain('ctrl+g diff');
    expect(frame).not.toContain('ctrl+o diff');
  });
});
