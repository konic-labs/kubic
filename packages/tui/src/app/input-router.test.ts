// The input routes run in one precedence order, and where two owners could
// claim the same key, the earlier route wins.
import { describe, expect, it } from 'vitest';
import { createApprovalSurface } from '../approval-surface.js';
import type {
  ApprovalOverlayTui,
  ApprovalViewRequest,
} from '../approval-view.js';
import { createTuiApp } from '../tui-app.js';
import { INPUT_ROUTES } from './input-router.js';

const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_T = '\x14';
const CTRL_S = '\x13';

const REQUEST: ApprovalViewRequest = {
  key: 'k-router',
  capability: 'destructive-shell',
  toolName: 'bash',
  command: 'rm -rf build',
};

function mounted() {
  const surface = createApprovalSurface({ armingMs: 0 });
  const app = createTuiApp({
    sessionId: 'sess-router',
    model: 'faux/m',
    approvalsSkipped: false,
    approvalSurface: surface,
  });
  const host: ApprovalOverlayTui = {
    terminal: { columns: 120, rows: 40 },
    showOverlay: () => ({ unfocus: () => {}, hide: () => {} }),
  };
  app.attachApprovalOverlay(host);
  return app;
}

describe('input routing', () => {
  it('runs the routes in precedence order', () => {
    expect(INPUT_ROUTES.map((route) => route.name)).toEqual([
      'release',
      'repeat',
      'approval',
      'palette',
      'block-viewer',
      'block-mode',
      'panel',
      'confirm',
      'picker',
      'global',
      'editor',
    ]);
  });

  it('lets a pending approval answer Esc before the global cancel', async () => {
    const app = mounted();
    const decision = app.requestApproval(REQUEST);
    const result = app.handleInput(ESC);
    expect(result).toMatchObject({ quit: false, cancel: false });
    expect(await decision).toMatchObject({ approved: false });
    expect(app.hasPendingApproval()).toBe(false);
  });

  it('keeps a global key from acting behind a picker, and closes it on Esc', () => {
    const app = mounted();
    let cancelled = 0;
    expect(
      app.openPicker({
        rows: [{ value: 'a', label: 'a' }],
        onSelect: () => {},
        onCancel: () => {
          cancelled += 1;
        },
      }),
    ).toBe(true);
    app.handleInput(CTRL_T);
    expect(app.tree.isCollapsed()).toBe(true);
    expect(app.isModelPickerOpen()).toBe(true);
    app.handleInput(ESC);
    expect(app.isModelPickerOpen()).toBe(false);
    expect(cancelled).toBe(1);
  });

  it('lets only the confirmation key accept a confirmation', () => {
    const app = mounted();
    const verdicts: string[] = [];
    app.openConfirm({
      title: 'sure?',
      body: [],
      confirmKey: 'ctrl+s',
      confirmLabel: 'Ctrl-S',
      onConfirm: () => verdicts.push('confirm'),
      onCancel: () => verdicts.push('cancel'),
    });
    app.handleInput('y');
    app.handleInput(CTRL_T);
    expect(verdicts).toEqual([]);
    expect(app.editor.getText()).toBe('');
    app.handleInput(CTRL_S);
    expect(verdicts).toEqual(['confirm']);
    expect(app.isConfirmOpen()).toBe(false);
  });

  it('arms the idle quit on an empty draft, and quits on the second press', () => {
    const app = mounted();
    expect(app.handleInput(CTRL_C)).toMatchObject({ quit: false });
    expect(app.handleInput(CTRL_C)).toMatchObject({ quit: true, cancel: true });
  });

  it('clears a draft before it arms the quit', () => {
    const app = mounted();
    app.handleInput('x');
    expect(app.handleInput(CTRL_C)).toMatchObject({ quit: false });
    expect(app.editor.getText()).toBe('');
    expect(app.handleInput(CTRL_C)).toMatchObject({ quit: false });
    expect(app.handleInput(CTRL_C)).toMatchObject({ quit: true });
  });

  it('interrupts a running turn on Esc and Ctrl-C instead of quitting idle-style', () => {
    const app = mounted();
    app.setBusy(true);
    expect(app.handleInput(ESC)).toMatchObject({
      quit: false,
      cancel: true,
      interrupt: true,
    });
    expect(app.handleInput(CTRL_C)).toMatchObject({ quit: true, cancel: true });
  });
});
