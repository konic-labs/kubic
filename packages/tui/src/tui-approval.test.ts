// The approval overlay inside the interactive loop (issue #96, criteria 1
// and 2).
//
// Headless: the app is rendered at a fixed width — at/above
// APPROVAL_MIN_WIDTH the surface must be handed to the overlay host (the
// composition root composites it), below it the inline body renders in the
// transcript's slot. Overlay COMPOSITING is asserted on the real alt-screen in
// the composition-root test; this file pins the loop's decisions.
import { describe, expect, it } from 'vitest';
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
  it('shows the overlay for a gated call and resolves it on approve', async () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const pending = app.requestApproval(request());
    expect(app.hasPendingApproval()).toBe(true);
    // The overlay host got a real component whose body is the request.
    expect(fake.shown).toHaveLength(1);
    const body = fake.shown[0]?.render(60).join('\n') ?? '';
    expect(body).toContain('destructive-shell');
    expect(body).toContain('rm -rf /tmp/x');
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
    expect(fake.hidden).toBe(1);
  });

  it('resolves deny on Escape without quitting the session', async () => {
    const app = createTuiApp({
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

  it('leaves Esc as quit when nothing is pending', () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(app.handleInput('\u001b')).toEqual({
      quit: true,
      consumed: true,
      cancel: false,
    });
  });

  it('does not leak the decision key into the draft', async () => {
    const app = createTuiApp({
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
    // Queued, not shown on top of the live one.
    expect(fake.shown).toHaveLength(1);
    app.handleInput('a');
    await expect(first).resolves.toEqual({ approved: true, by: 'allow-once' });
    // The second is now on the overlay (the first one's was hidden).
    expect(fake.shown).toHaveLength(2);
    expect(fake.hidden).toBe(1);
    const body = fake.shown[1]?.render(60).join('\n') ?? '';
    expect(body).toContain('write');
    app.handleInput('d');
    await expect(second).resolves.toEqual({
      approved: false,
      reason: 'denied by the user',
    });
  });

  it('denies a pending approval when the session quits (never hangs)', async () => {
    const app = createTuiApp({
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

describe('inline fallback (issue #96, criterion 2)', () => {
  it('renders the inline body below APPROVAL_MIN_WIDTH instead of the overlay', async () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const pending = app.requestApproval(request());
    const narrow = app.render(APPROVAL_MIN_WIDTH - 1).join('\n');
    expect(narrow).toContain('! approval (inline) — narrow terminal');
    expect(narrow).toContain('destructive-shell');
    expect(narrow).toContain('rm -rf /tmp/x');
    expect(narrow).toContain('deny');
    app.handleInput('d');
    await expect(pending).resolves.toMatchObject({ approved: false });
    // Once settled the inline body is gone from the narrow frame too.
    expect(app.render(APPROVAL_MIN_WIDTH - 1).join('\n')).not.toContain(
      '! approval (inline)',
    );
  });

  it('does NOT render the inline body at the minimum width (overlay owns it)', async () => {
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const fake = approvalHost();
    app.attachApprovalOverlay(fake.host);
    const pending = app.requestApproval(request());
    const wide = app.render(APPROVAL_MIN_WIDTH).join('\n');
    expect(wide).not.toContain('! approval (inline)');
    // ...because the overlay host really has it.
    expect(fake.shown).toHaveLength(1);
    app.handleInput('d');
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('still renders the inline body with no overlay host attached', async () => {
    // The viewer shell (an injected boot with no loop) must be able to show
    // the request too: an unanswered approval is a hang otherwise.
    const app = createTuiApp({
      sessionId: SESSION,
      model: MODEL,
      mode: 'solo',
      approvalsSkipped: false,
    });
    const pending = app.requestApproval(request());
    expect(app.render(APPROVAL_MIN_WIDTH - 1).join('\n')).toContain(
      '! approval (inline)',
    );
    app.handleInput('a');
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
  });
});
