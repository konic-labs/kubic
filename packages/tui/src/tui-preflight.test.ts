// The first screen in the app: the preflight at the top of an empty
// transcript, gone after the first prompt, never on a session with history,
// and `?` listing every key.
import { describe, expect, it } from 'vitest';
import { createApprovalSurface } from './approval-surface.js';
import type { ApprovalOverlayTui } from './approval-view.js';
import { createKeyRegistry } from './keybindings.js';
import { createTuiApp, type TuiAppSeed } from './tui-app.js';
import type { Component } from './tui-boundary.js';

function setup(extra: Partial<TuiAppSeed> = {}, rows = 40) {
  const app = createTuiApp({
    sessionId: 'sess-462',
    model: 'anthropic/sonnet',
    approvalsSkipped: false,
    approvalSurface: createApprovalSurface({ armingMs: 0 }),
    cwdLabel: '~/proj',
    preflight: {
      version: '0.1.0',
      keySource: (provider) =>
        provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined,
      trust: 'loaded',
      isolation: () =>
        "runs with your user's authority; approvals are the control",
    },
    ...extra,
  });
  const shown: Array<{ component: Component; hidden: boolean }> = [];
  const host: ApprovalOverlayTui = {
    terminal: { columns: 120, rows },
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
  const overlay = (): string =>
    shown
      .find((entry) => !entry.hidden)
      ?.component.render(80)
      .join('\n') ?? '';
  return { app, overlay };
}

const doc = (app: ReturnType<typeof setup>['app']): string =>
  app.render(120).join('\n');

describe('the first screen (issue #462)', () => {
  it('opens on the preflight', () => {
    const { app } = setup();
    const frame = doc(app);
    expect(frame).toContain('PREFLIGHT');
    expect(frame).toContain(
      'provider     anthropic/sonnet  key from ANTHROPIC_API_KEY',
    );
    expect(frame).toContain('project      ~/proj');
    expect(frame).toContain('trust        .kubic/config.toml loaded');
    expect(frame).toContain("isolation    runs with your user's authority");
    expect(frame).toContain('/safety');
    // The git facts arrive with the workspace read.
    app.setWorkspace({ project: 'proj', branch: 'main', dirty: 2 });
    expect(doc(app)).toContain('~/proj  git main · 2 changed');
  });

  it('is gone after the first prompt, not after a command', () => {
    const { app } = setup();
    app.onSubmit((prompt) => (prompt.startsWith('/') ? 'command' : 'accepted'));
    app.editor.setText('/help');
    app.handleInput('\r');
    expect(doc(app)).toContain('PREFLIGHT');
    app.editor.setText('fix the cart');
    app.handleInput('\r');
    expect(doc(app)).not.toContain('PREFLIGHT');
  });

  it('never shows on a session with history, and comes back for a new one', () => {
    const { app } = setup();
    app.applyLaneEntries([
      {
        id: 'u1',
        seq: 1,
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
      },
    ]);
    expect(doc(app)).not.toContain('PREFLIGHT');
    app.resetSession({ sessionId: 'sess-new', model: 'anthropic/sonnet' });
    expect(doc(app)).toContain('PREFLIGHT');
  });

  it('lists this project’s recent sessions', () => {
    const { app } = setup();
    app.setRecentSessions([
      { title: 'fix the cart', age: '2m ago', detail: '4 turns · $0.03' },
    ]);
    const frame = doc(app);
    expect(frame).toContain('RECENT IN THIS PROJECT');
    expect(frame).toMatch(/2m ago {3}fix the cart +4 turns · \$0\.03/u);
    expect(frame).toContain('/resume to open one');
  });

  it('? lists every key on an empty editor, and is typed into a draft', () => {
    const { app, overlay } = setup(
      {
        keys: createKeyRegistry({
          'panel.diff': ['ctrl+g'],
          'panel.journal': [],
        }),
      },
      80,
    );
    app.handleInput('?');
    const keys = overlay();
    expect(keys).toContain('┌─ Keys');
    expect(keys).toContain('EDITOR');
    expect(keys).toContain('APPROVALS');
    expect(keys).toContain('toggle the diff panel');
    expect(keys).toContain('^G');
    expect(keys).toContain('unbound');
    app.handleInput('\x1b');
    app.editor.setText('why');
    app.handleInput('?');
    expect(app.editor.getText()).toBe('why?');
  });
});
