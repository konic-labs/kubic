// The approval inside the interactive loop (issue #96, criteria 1 and 2).
//
// Issue #459: an approval is an inline card in the editor's slot at every
// width — never an overlay — so the transcript above stays readable. The app
// is rendered headless at a fixed width; this file pins the loop's
// decisions.
import { describe, expect, it } from 'vitest';
import { createApprovalSurface } from './approval-surface.js';
import { APPROVAL_MIN_WIDTH } from './approval-view.js';
import { createTuiApp, type TuiApprovalRequest } from './tui-app.js';

const SESSION = 'sess-96';
const MODEL = 'test-model';

function request(
  overrides: Partial<TuiApprovalRequest> = {},
): TuiApprovalRequest {
  return {
    key: 'k-1',
    capability: 'destructive-shell',
    toolName: 'bash',
    command: 'rm -rf /tmp/x',
    ...overrides,
  };
}

// A pending approval host: the app calls showOverlay with the view while a
// request is live, so the test observes the same component the operator would.
function approvalHost() {
  const shown: Array<{ render: (w: number) => string[] }> = [];
  let hidden = 0;
  return {
    shown,
    get hidden() {
      return hidden;
    },
    host: {
      showOverlay: (component: unknown) => {
        shown.push(component as { render: (w: number) => string[] });
        return {
          unfocus: () => {},
          hide: () => {
            hidden += 1;
          },
        };
      },
    },
  };
}

describe('approval in the loop (issue #96, criterion 1)', () => {
  it('shows the card for a gated call and resolves it on approve', async () => {
    const app = createTuiApp({
      approvalSurface: createApprovalSurface({ armingMs: 0 }),
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const pending = app.requestApproval(request());
    expect(app.hasPendingApproval()).toBe(true);
    // The card replaces the editor; no overlay is shown.
    expect(fake.shown).toHaveLength(0);
    const body = app.render(100).join('\n');
    expect(body).toContain('▲ destructive');
    expect(body).toContain('$ rm -rf /tmp/x');
    // 'a' is the shipped allow-once binding, routed through the app's own
    // handleInput (which classifies through parseKey first).
    const routed = app.handleInput('a');
    expect(routed.consumed).toBe(true);
    expect(routed.quit).toBe(false);
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
    expect(app.hasPendingApproval()).toBe(false);
    // The editor is back.
    expect(app.render(100).join('\n')).not.toContain('[APPROVAL]');
  });

  it('resolves deny on Escape without quitting the session', async () => {
    const app = createTuiApp({
      approvalSurface: createApprovalSurface({ armingMs: 0 }),
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const pending = app.requestApproval(request());
    const routed = app.handleInput('\u001b');
    // Esc answered the request — it must NOT also mean "quit".
    expect(routed.quit).toBe(false);
    expect(routed.consumed).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: false,
      reason: 'denied by the user',
    });
  });

  it('leaves Esc a harmless no-op when nothing is pending (issue #454)', () => {
    const app = createTuiApp({
      approvalSurface: createApprovalSurface({ armingMs: 0 }),
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(app.handleInput('\u001b')).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
  });

  it('does not leak the decision key into the draft', async () => {
    const app = createTuiApp({
      approvalSurface: createApprovalSurface({ armingMs: 0 }),
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const pending = app.requestApproval(request());
    app.handleInput('a');
    await pending;
    expect(app.editor.getText()).toBe('');
  });

  it('queues a second challenged call instead of dropping it', async () => {
    const app = createTuiApp({
      approvalSurface: createApprovalSurface({ armingMs: 0 }),
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const first = app.requestApproval(request());
    const second = app.requestApproval(
      request({ key: 'k-2', toolName: 'write' }),
    );
    // Queued, not shown on top of the live one: the card says what is next.
    const card = app.render(100).join('\n');
    expect(card).toContain(' 1 of 2 ');
    expect(card).toContain('next: write');
    app.handleInput('a');
    await expect(first).resolves.toEqual({ approved: true, by: 'allow-once' });
    // The second now holds the card.
    const body = app.render(100).join('\n');
    expect(body).toContain('[APPROVAL] ━ write');
    expect(body).toContain(' 1 of 1 ');
    app.handleInput('d');
    await expect(second).resolves.toEqual({
      approved: false,
      reason: 'denied by the user',
    });
  });

  it('denies a pending approval when the session quits (never hangs)', async () => {
    const app = createTuiApp({
      approvalSurface: createApprovalSurface({ armingMs: 0 }),
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const pending = app.requestApproval(request());
    app.handleInput('\u0003');
    await expect(pending).resolves.toMatchObject({ approved: false });
    expect(app.hasPendingApproval()).toBe(false);
  });
});

describe('the card at every width (issue #96 criterion 2; #459)', () => {
  it('renders the card on a narrow terminal, and the editor once settled', async () => {
    const app = createTuiApp({
      approvalSurface: createApprovalSurface({ armingMs: 0 }),
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const pending = app.requestApproval(request());
    const narrow = app.render(APPROVAL_MIN_WIDTH - 1).join('\n');
    expect(narrow).toContain('[APPROVAL] ━ bash');
    expect(narrow).toContain('$ rm -rf /tmp/x');
    expect(narrow).toContain('deny');
    expect(fake.shown).toHaveLength(0);
    app.handleInput('d');
    await expect(pending).resolves.toMatchObject({ approved: false });
    expect(app.render(APPROVAL_MIN_WIDTH - 1).join('\n')).not.toContain(
      '[APPROVAL]',
    );
  });

  it('renders the same card at and above the old overlay width', async () => {
    const app = createTuiApp({
      approvalSurface: createApprovalSurface({ armingMs: 0 }),
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const pending = app.requestApproval(request());
    expect(app.render(APPROVAL_MIN_WIDTH).join('\n')).toContain(
      '[APPROVAL] ━ bash',
    );
    expect(fake.shown).toHaveLength(0);
    app.handleInput('d');
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('renders the card with no overlay host attached', async () => {
    // The viewer shell (an injected boot with no loop) must be able to show
    // the request too: an unanswered approval is a hang otherwise.
    const app = createTuiApp({
      approvalSurface: createApprovalSurface({ armingMs: 0 }),
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const pending = app.requestApproval(request());
    expect(app.render(APPROVAL_MIN_WIDTH - 1).join('\n')).toContain(
      '[APPROVAL]',
    );
    app.handleInput('a');
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
  });
});
