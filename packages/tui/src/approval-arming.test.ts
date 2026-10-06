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
  APPROVAL_QUIET_MS,
  APPROVAL_REPEAT_MS,
  type ApprovalViewRequest,
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
    time.advance(APPROVAL_QUIET_MS);
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
    time.advance(APPROVAL_QUIET_MS);
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
      // allow-once / deny / the comment input (#467 — it answers nothing).
      if (ch === 'a' || ch === 'd' || ch === 'c') continue;
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
    time.advance(APPROVAL_QUIET_MS);
    app.handleInput('d');
    await expect(pending).resolves.toMatchObject({ approved: false });
    app.handleInput('x');
    expect(app.editor.getText()).toBe('add x');
  });

  it('the card follows the surface arming state (issue #459)', () => {
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
    void app.requestApproval(REQUEST);
    expect(app.render(100).join('\n')).toContain('keys unlock');
    time.advance(APPROVAL_ARMING_MS);
    expect(app.render(100).join('\n')).toContain('a  allow once');
    surface.cancelPending();
  });
});

// Issue #315 (re-audit): the arming window measures QUIET time. Every key the
// modal swallows restarts it, so an operator who keeps typing prose after the
// overlay appears cannot have a later bare `a` resolve the request.
describe('the arming window restarts on every swallowed key (issue #315)', () => {
  function timedSurface() {
    const time = clock();
    const timers: Array<{ ms: number; fire: () => void; cancelled: boolean }> =
      [];
    let renders = 0;
    const surface = createApprovalSurface({
      now: time.now,
      setTimer: (ms, fire) => {
        const timer = { ms, fire, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });
    surface.renderRequest = () => {
      renders += 1;
    };
    return { time, timers, surface, renders: () => renders };
  }

  it('prose typed for a second after the overlay appears keeps a bare a locked', async () => {
    const { time, surface } = timedSurface();
    const pending = surface.ask(REQUEST);
    for (const ch of 'add tests for the parser') {
      time.advance(100);
      expect(surface.decide(ch)).toBe(false);
    }
    time.advance(100);
    expect(surface.isArmed()).toBe(false);
    expect(surface.decide('a')).toBe(false);
    expect(await settledState(pending)).toBe('pending');
    surface.cancelPending();
    await pending;
  });

  it('a decision needs a quiet period of exactly APPROVAL_QUIET_MS after the last swallowed key', async () => {
    const { time, surface } = timedSurface();
    const pending = surface.ask(REQUEST);
    time.advance(APPROVAL_QUIET_MS * 2);
    expect(surface.isArmed()).toBe(true);
    expect(surface.decide('x')).toBe(false);
    expect(surface.isArmed()).toBe(false);
    time.advance(APPROVAL_QUIET_MS - 1);
    expect(surface.isArmed()).toBe(false);
    time.advance(1);
    expect(surface.isArmed()).toBe(true);
    expect(surface.decide('d')).toBe(true);
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('a decision key dropped inside the window restarts it too, for the long quiet period', async () => {
    const { time, surface } = timedSurface();
    const pending = surface.ask(REQUEST);
    time.advance(300);
    expect(surface.decide('a')).toBe(false);
    // The short arming delay no longer unlocks it...
    time.advance(APPROVAL_ARMING_MS);
    expect(surface.isArmed()).toBe(false);
    time.advance(APPROVAL_QUIET_MS - APPROVAL_ARMING_MS - 1);
    expect(surface.isArmed()).toBe(false);
    // ...the long quiet period does.
    time.advance(1);
    expect(surface.isArmed()).toBe(true);
    expect(surface.decide('a')).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
  });

  it('a lone key after the window with no typing before it still decides at once', async () => {
    const { time, surface } = timedSurface();
    const pending = surface.ask(REQUEST);
    time.advance(APPROVAL_ARMING_MS);
    expect(surface.decide('a')).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
  });

  it('a global key the surface does not claim also restarts the window', () => {
    const { time, surface } = timedSurface();
    void surface.ask(REQUEST);
    time.advance(APPROVAL_ARMING_MS);
    expect(surface.decide('\x14')).toBe(false);
    expect(surface.isArmed()).toBe(false);
    surface.cancelPending();
  });

  it('Esc still denies at once after swallowed keys', async () => {
    const { time, surface } = timedSurface();
    const pending = surface.ask(REQUEST);
    time.advance(50);
    expect(surface.decide('x')).toBe(false);
    expect(surface.decide('\x1b')).toBe(true);
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('re-locks the hints with a repaint and a fresh timer that replaces the old one', () => {
    const { time, timers, surface, renders } = timedSurface();
    void surface.ask(REQUEST);
    expect(timers).toHaveLength(1);
    time.advance(APPROVAL_ARMING_MS);
    const first = timers[0];
    surface.decide('x');
    expect(first?.cancelled).toBe(true);
    expect(timers).toHaveLength(2);
    expect(timers[1]?.ms).toBe(APPROVAL_QUIET_MS);
    expect(timers[1]?.cancelled).toBe(false);
    const afterRelock = renders();
    // The stale timer never repaints; the live one does.
    first?.fire();
    expect(renders()).toBe(afterRelock);
    timers[1]?.fire();
    expect(renders()).toBe(afterRelock + 1);
    // A key that lands while the hints are already locked changes nothing on
    // screen (no repaint) but still pushes the unlock out.
    const locked = renders();
    surface.decide('y');
    expect(renders()).toBe(locked);
    expect(timers).toHaveLength(3);
    expect(timers[1]?.cancelled).toBe(true);
    surface.cancelPending();
  });

  it('a request that is not showing has no window to restart', () => {
    const { timers, surface } = timedSurface();
    surface.noteDroppedKey();
    expect(timers).toHaveLength(0);
    expect(surface.isArmed()).toBe(false);
  });

  it('with the arming delay off, swallowed keys never lock anything', async () => {
    let renders = 0;
    const timers: number[] = [];
    const surface = createApprovalSurface({
      armingMs: 0,
      setTimer: (ms) => {
        timers.push(ms);
        return () => {};
      },
    });
    surface.renderRequest = () => {
      renders += 1;
    };
    const pending = surface.ask(REQUEST);
    const shownRenders = renders;
    expect(surface.decide('x')).toBe(false);
    // No window, so nothing to restart: no timer and no repaint.
    expect(timers).toEqual([]);
    expect(renders).toBe(shownRenders);
    expect(surface.isArmed()).toBe(true);
    expect(surface.decide('a')).toBe(true);
    await pending;
  });

  describe('through the app', () => {
    const REPEAT_X = '\x1b[120;1:2u';

    function armedApp() {
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
      return { time, surface, app };
    }

    it('type-ahead prose that outlasts the window does not let the next bare a answer', async () => {
      const { time, app } = armedApp();
      for (const ch of 'add ') app.handleInput(ch);
      const pending = app.requestApproval(REQUEST);
      for (const ch of 'tests for the parser') {
        time.advance(100);
        expect(app.handleInput(ch).consumed).toBe(true);
      }
      time.advance(100);
      app.handleInput('a');
      expect(app.hasPendingApproval()).toBe(true);
      expect(await settledState(pending)).toBe('pending');
      expect(app.editor.getText()).toBe('add ');
      time.advance(APPROVAL_QUIET_MS);
      app.handleInput('a');
      await expect(pending).resolves.toEqual({
        approved: true,
        by: 'allow-once',
      });
    });

    it('a held key repeat restarts the window even though it never reaches decide', async () => {
      const { time, app } = armedApp();
      const pending = app.requestApproval(REQUEST);
      time.advance(APPROVAL_ARMING_MS);
      app.handleInput(REPEAT_X);
      time.advance(100);
      app.handleInput('d');
      expect(app.hasPendingApproval()).toBe(true);
      expect(await settledState(pending)).toBe('pending');
      time.advance(APPROVAL_QUIET_MS);
      app.handleInput('d');
      await expect(pending).resolves.toMatchObject({ approved: false });
    });

    it('paging a long command with v restarts the window', async () => {
      const { time, surface, app } = armedApp();
      const pending = app.requestApproval({
        ...REQUEST,
        command: Array.from({ length: 40 }, (_, i) => `echo ${i}`).join('\n'),
      });
      time.advance(APPROVAL_ARMING_MS);
      app.handleInput('v');
      expect(surface.commandPage()).toBe(1);
      time.advance(100);
      app.handleInput('d');
      expect(app.hasPendingApproval()).toBe(true);
      time.advance(APPROVAL_QUIET_MS);
      app.handleInput('d');
      await expect(pending).resolves.toMatchObject({ approved: false });
    });
  });
});

// Issue #315 (re-audit): after ANY swallowed key the unlock needs a longer
// quiet period than the first arming delay (a normal thinking pause in prose
// is ~0.5 s), and a decision key that arrives right after the same key is a
// terminal auto-repeat, not a decision — legacy terminals (Terminal.app, VTE,
// tmux) send a held `a` as plain repeated bytes, with no repeat flag.
describe('arming after typing and against auto-repeat (issue #315)', () => {
  function surfaceAt(options: { quietMs?: number; repeatMs?: number } = {}) {
    const time = clock(0);
    const surface = createApprovalSurface({
      now: time.now,
      setTimer: () => () => {},
      ...options,
    });
    return { time, surface };
  }

  it('pins the named periods', () => {
    expect(APPROVAL_ARMING_MS).toBe(400);
    expect(APPROVAL_QUIET_MS).toBe(1500);
    expect(APPROVAL_REPEAT_MS).toBe(700);
  });

  it('a held a on a legacy terminal (first repeat after 500 ms) never approves', async () => {
    const { time, surface } = surfaceAt();
    const pending = surface.ask(REQUEST);
    time.advance(30);
    expect(surface.decide('a')).toBe(false);
    time.advance(500);
    expect(surface.decide('a')).toBe(false);
    time.advance(35);
    expect(surface.decide('a')).toBe(false);
    expect(await settledState(pending)).toBe('pending');
    surface.cancelPending();
    await pending;
  });

  it('the quiet period alone stops it: a repeat 500 ms later is still locked', async () => {
    const { time, surface } = surfaceAt({ repeatMs: 0 });
    const pending = surface.ask(REQUEST);
    time.advance(30);
    expect(surface.decide('a')).toBe(false);
    time.advance(500);
    expect(surface.decide('a')).toBe(false);
    expect(await settledState(pending)).toBe('pending');
    time.advance(APPROVAL_QUIET_MS);
    expect(surface.decide('a')).toBe(true);
    await pending;
  });

  it('the repeat rule alone stops it: the same key inside the repeat window is swallowed', async () => {
    const { time, surface } = surfaceAt({ quietMs: 100 });
    const pending = surface.ask(REQUEST);
    time.advance(30);
    expect(surface.decide('a')).toBe(false);
    // 500 ms later the 100 ms quiet period is long over — a repeat anyway.
    time.advance(500);
    expect(surface.isArmed()).toBe(true);
    expect(surface.decide('a')).toBe(false);
    time.advance(APPROVAL_REPEAT_MS - 1);
    expect(surface.decide('a')).toBe(false);
    expect(await settledState(pending)).toBe('pending');
    // Exactly the repeat window after the previous a: a new press.
    time.advance(APPROVAL_REPEAT_MS);
    expect(surface.decide('a')).toBe(true);
    await pending;
  });

  it('a different key is not a repeat', async () => {
    const { time, surface } = surfaceAt({ quietMs: 100 });
    const pending = surface.ask(REQUEST);
    time.advance(50);
    expect(surface.decide('a')).toBe(false);
    time.advance(250);
    expect(surface.decide('d')).toBe(true);
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('a held Ctrl-S is swallowed the same way', async () => {
    const { time, surface } = surfaceAt({ quietMs: 100 });
    const pending = surface.ask(REQUEST);
    time.advance(APPROVAL_ARMING_MS);
    // Two Ctrl-S bytes 300 ms apart: the second is the terminal repeating.
    expect(surface.decide('x')).toBe(false);
    time.advance(200);
    expect(surface.decide('\x13')).toBe(true);
    await expect(pending).resolves.toMatchObject({ approved: true });
    const next = surface.ask({ ...REQUEST, key: 'k-next' });
    time.advance(APPROVAL_ARMING_MS);
    expect(surface.decide('\x13')).toBe(false);
    expect(await settledState(next)).toBe('pending');
    surface.cancelPending();
    await next;
  });

  it('a 450 ms thinking pause in prose does not unlock a bare a', async () => {
    const { time, surface } = surfaceAt();
    const pending = surface.ask(REQUEST);
    for (const ch of 'please ') {
      time.advance(120);
      expect(surface.decide(ch)).toBe(false);
    }
    time.advance(450);
    expect(surface.decide('a')).toBe(false);
    expect(await settledState(pending)).toBe('pending');
    // Only a real pause (the long quiet period) does.
    time.advance(APPROVAL_QUIET_MS);
    expect(surface.decide('a')).toBe(true);
    await pending;
  });

  it('Esc stays immediate and is never treated as a repeat', async () => {
    const { time, surface } = surfaceAt();
    const first = surface.ask(REQUEST);
    const second = surface.ask({ ...REQUEST, key: 'k-second' });
    time.advance(10);
    expect(surface.decide('x')).toBe(false);
    expect(surface.decide('\x1b')).toBe(true);
    await expect(first).resolves.toMatchObject({ approved: false });
    expect(surface.decide('\x1b')).toBe(true);
    await expect(second).resolves.toMatchObject({ approved: false });
  });

  it('with the arming delay off, swallowed keys and repeats lock nothing', async () => {
    const time = clock(0);
    const surface = createApprovalSurface({ armingMs: 0, now: time.now });
    const first = surface.ask(REQUEST);
    const second = surface.ask({ ...REQUEST, key: 'k-second' });
    expect(surface.decide('x')).toBe(false);
    expect(surface.decide('a')).toBe(true);
    await first;
    // Same key, same instant: still no repeat lock.
    expect(surface.decide('a')).toBe(true);
    await second;
  });

  describe('through the app', () => {
    it('the reviewer scenarios: legacy held a and a prose pause both stay pending', async () => {
      const time = clock(0);
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
      const pending = app.requestApproval(REQUEST);
      time.advance(30);
      app.handleInput('a');
      time.advance(500);
      app.handleInput('a');
      expect(app.hasPendingApproval()).toBe(true);
      expect(await settledState(pending)).toBe('pending');
      time.advance(APPROVAL_QUIET_MS);
      app.handleInput('d');
      await expect(pending).resolves.toMatchObject({ approved: false });
    });
  });
});
