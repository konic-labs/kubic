// Approval keys cannot be produced by type-ahead (issue #315; §14.2, §16.4,
// §16.9). An ask arrives asynchronously while the operator may be typing the
// next prompt: the overlay captures input, ignores decision keys for an
// arming delay after it appears, and allow-session needs a key that cannot
// occur in prose. Injected clock; headless renders only.
import { describe, expect, it } from 'vitest';
import { createApprovalSurface } from './approval-surface.js';
import {
  APPROVAL_ARMING_MS,
  APPROVAL_DEFAULT_KEYS,
  type ApprovalViewRequest,
  renderApprovalLines,
} from './approval-view.js';
import { createTuiApp } from './tui-app.js';

const REQUEST: ApprovalViewRequest = {
  key: 'k-315',
  capability: 'destructive-shell',
  toolName: 'bash',
  command: 'rm -rf build',
};

function clock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function settledState(promise: Promise<unknown>): Promise<string> {
  return Promise.race([
    promise.then(() => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 5)),
  ]);
}

describe('approval arming delay (issue #315)', () => {
  it('ignores a decision key 50 ms after the request appears', async () => {
    const time = clock();
    const surface = createApprovalSurface({
      now: time.now,
      setTimer: () => () => {},
    });
    const pending = surface.ask(REQUEST);
    time.advance(50);
    expect(surface.isArmed()).toBe(false);
    expect(surface.decide('a')).toBe(false);
    expect(surface.isShowing()).toBe(true);
    expect(await settledState(pending)).toBe('pending');
    surface.cancelPending();
    await pending;
  });

  it('resolves allow-once with the same key after the arming delay', async () => {
    const time = clock();
    const surface = createApprovalSurface({
      now: time.now,
      setTimer: () => () => {},
    });
    const pending = surface.ask(REQUEST);
    time.advance(50);
    surface.decide('a');
    time.advance(APPROVAL_ARMING_MS);
    expect(surface.isArmed()).toBe(true);
    expect(surface.decide('a')).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
  });

  it('re-arms for the next queued request', async () => {
    const time = clock();
    const surface = createApprovalSurface({
      now: time.now,
      setTimer: () => () => {},
    });
    const first = surface.ask(REQUEST);
    const second = surface.ask({ ...REQUEST, key: 'k-316' });
    time.advance(APPROVAL_ARMING_MS);
    expect(surface.decide('a')).toBe(true);
    await first;
    // The key that answered the first request cannot answer the second.
    expect(surface.decide('a')).toBe(false);
    expect(await settledState(second)).toBe('pending');
    time.advance(APPROVAL_ARMING_MS);
    expect(surface.decide('d')).toBe(true);
    await expect(second).resolves.toMatchObject({ approved: false });
  });

  it('repaints when the request arms', () => {
    const timers: Array<{ ms: number; fire: () => void }> = [];
    let renders = 0;
    const surface = createApprovalSurface({
      setTimer: (ms, fire) => {
        timers.push({ ms, fire });
        return () => {};
      },
    });
    surface.renderRequest = () => {
      renders += 1;
    };
    void surface.ask(REQUEST);
    expect(timers.map((timer) => timer.ms)).toEqual([APPROVAL_ARMING_MS]);
    const before = renders;
    timers[0]?.fire();
    expect(renders).toBe(before + 1);
    surface.cancelPending();
  });

  it('Esc during the arming window denies at once — the only immediate action', async () => {
    const time = clock();
    const surface = createApprovalSurface({
      now: time.now,
      setTimer: () => () => {},
    });
    const pending = surface.ask(REQUEST);
    time.advance(10);
    expect(surface.decide('d')).toBe(false);
    expect(surface.decide('\x1b')).toBe(true);
    await expect(pending).resolves.toMatchObject({ approved: false });
  });
});

describe('allow-session needs a key prose cannot produce (issue #315)', () => {
  it('no bare printable character resolves allow-session, even armed', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const pending = surface.ask(REQUEST);
    const printable = Array.from({ length: 95 }, (_, i) =>
      String.fromCharCode(32 + i),
    );
    for (const ch of printable) {
      if (ch === 'a' || ch === 'd') continue; // allow-once / deny
      expect(surface.decide(ch)).toBe(false);
    }
    expect(surface.isShowing()).toBe(true);
    expect(surface.decide('\x13')).toBe(true); // Ctrl-S
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-session',
    });
  });

  it('ships Ctrl-S for allow-session and refuses a printable override', () => {
    expect(APPROVAL_DEFAULT_KEYS['allow-session']).toEqual(['ctrl+s']);
    const surface = createApprovalSurface({
      keyOverrides: { 'allow-session': ['s'] },
    });
    expect(() => surface.checkKeys()).toThrow(/allow-session/);
    const shifted = createApprovalSurface({
      keyOverrides: { 'allow-session': ['shift+s'] },
    });
    expect(() => shifted.checkKeys()).toThrow(/allow-session/);
  });

  it('refuses an approval key that collides with a global loop key', () => {
    const surface = createApprovalSurface({
      keyOverrides: { 'allow-once': ['ctrl+o'] },
    });
    expect(() => surface.checkKeys(['ctrl+c', 'ctrl+o', 'ctrl+r'])).toThrow(
      /ctrl\+o/,
    );
  });
});

describe('the overlay captures input (issue #315)', () => {
  it('printable keys typed while the overlay shows never reach the draft', async () => {
    const time = clock();
    const surface = createApprovalSurface({
      now: time.now,
      setTimer: () => () => {},
    });
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    for (const ch of 'add ') app.handleInput(ch);
    const pending = app.requestApproval(REQUEST);
    for (const ch of 'tests as') {
      expect(app.handleInput(ch).consumed).toBe(true);
    }
    expect(app.editor.getText()).toBe('add ');
    expect(app.hasPendingApproval()).toBe(true);
    time.advance(APPROVAL_ARMING_MS);
    app.handleInput('d');
    await expect(pending).resolves.toMatchObject({ approved: false });
    app.handleInput('x');
    expect(app.editor.getText()).toBe('add x');
  });

  it('renders dimmed hints before arming and the live keys after', () => {
    const before = renderApprovalLines(REQUEST, 72, { armed: false });
    const after = renderApprovalLines(REQUEST, 72, { armed: true });
    expect(before.at(-1)).toMatchInlineSnapshot(
      `"… keys unlock in a moment · [Esc] deny now"`,
    );
    expect(after.at(-1)).toMatchInlineSnapshot(
      `"[a] allow once   [Ctrl-S] allow session   [d]/[Esc] deny"`,
    );
    expect(before.slice(0, -1)).toEqual(after.slice(0, -1));
  });

  it('the overlay view follows the surface arming state', () => {
    const time = clock();
    const surface = createApprovalSurface({
      now: time.now,
      setTimer: () => () => {},
    });
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    const shown: Array<{ render: (w: number) => string[] }> = [];
    app.attachApprovalOverlay({
      showOverlay: (component) => {
        shown.push(component as { render: (w: number) => string[] });
        return { unfocus: () => {}, hide: () => {} };
      },
    });
    void app.requestApproval(REQUEST);
    expect(shown[0]?.render(80).join('\n')).toContain('keys unlock');
    time.advance(APPROVAL_ARMING_MS);
    expect(shown[0]?.render(80).join('\n')).toContain('[a] allow once');
    surface.cancelPending();
  });
});
