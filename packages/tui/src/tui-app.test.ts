// Interactive TUI controller over the solo lane (issue #75, #88).
//
// Headless snapshots only (no VirtualTerminal in Pi 0.85.1): the root
// VStack renders pure, like renderLayout in layout.test.ts. Faux-only,
// zero network.
import { describe, expect, it } from 'vitest';
import { createTuiApp, seedFromPresentation } from './tui-app.js';

const SESSION = 'sess-1';
const MODEL = 'test-model';

describe('tui app root (issue #75)', () => {
  it('orders tree / transcript / status top to bottom at 100 cols', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    const doc = app.render(100).join('\n');
    const order = ['◌ solo', `session ${SESSION}`, 'approvals:on'].map(
      (marker) => doc.indexOf(marker),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('hides the tree only below 80 columns', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    const wide = app.render(100).join('\n');
    expect(wide).toContain('◌ solo');
    const narrow = app.render(70).join('\n');
    expect(narrow).not.toMatch(/[✓●◌]/);
    expect(narrow).toContain(`session ${SESSION}`);
    expect(narrow).toContain('approvals:on');
  });

  it('routes Ctrl-T to the tree toggle and keeps T/t for the draft', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
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
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
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
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
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
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
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
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
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

  it('prints the final document with transcript and status', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
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
    );
    expect(seed).toEqual({ sessionId: 'abc', model: MODEL });
  });
});

describe('prompt loop routing (issue #88)', () => {
  it('submits a typed prompt from the editor through Enter', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    const submitted: string[] = [];
    app.onSubmit((text) => submitted.push(text));
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
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    const submitted: string[] = [];
    app.onSubmit((text) => submitted.push(text));
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
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    for (const ch of 'hello') app.handleInput(ch);
    expect(app.render(100).join('\n')).toContain('hello');
  });

  it('accepts a multi-line prompt with Ctrl-J then submits it whole', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    const submitted: string[] = [];
    app.onSubmit((text) => submitted.push(text));
    for (const ch of 'first') app.handleInput(ch);
    app.handleInput('\n');
    for (const ch of 'second') app.handleInput(ch);
    app.handleInput('\r');
    expect(submitted).toEqual(['first\nsecond']);
  });

  it('ignores Enter on an empty draft', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    const submitted: string[] = [];
    app.onSubmit((text) => submitted.push(text));
    expect(app.handleInput('\r')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(submitted).toEqual([]);
  });

  it('reports the loop as busy only while a turn is in flight', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    expect(app.isBusy()).toBe(false);
    app.setBusy(true);
    expect(app.isBusy()).toBe(true);
    app.setBusy(false);
    expect(app.isBusy()).toBe(false);
  });
});

describe('lane snapshot feed (issue #88)', () => {
  it('lands committed lane entries in the transcript view', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
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
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
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
});
