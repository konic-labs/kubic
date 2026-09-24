// Interactive TUI controller over the solo lane (issue #75).
// RED: createTuiApp does not exist yet.
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

  it('routes T/t to the tree toggle (per #24)', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    app.applyLaneEvent({
      type: 'tool-start',
      toolCallId: 't1',
      toolName: 'read',
    });
    expect(app.render(100).join('\n')).toContain('read');
    expect(app.handleInput('T')).toEqual({ quit: false, consumed: true });
    expect(app.render(100).join('\n')).toContain('…1 call');
    expect(app.handleInput('t')).toEqual({ quit: false, consumed: true });
    expect(app.render(100).join('\n')).toContain('read');
  });

  it('quits on Ctrl-C and passes other keys through', () => {
    const app = createTuiApp({ sessionId: SESSION, model: MODEL });
    expect(app.handleInput('\x03')).toEqual({ quit: true, consumed: true });
    expect(app.handleInput('x')).toEqual({ quit: false, consumed: false });
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
    const doc = app.finalDocument(100).join('\n');
    expect(doc).toContain(`session ${SESSION}`);
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
