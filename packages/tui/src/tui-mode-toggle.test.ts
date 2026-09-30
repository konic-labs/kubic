// The session mode toggle (issue #327; §17, §80, §81): Ctrl-G switches the
// session between solo and orchestrator between turns. The indicator takes
// the state, not the boot seed, and a running turn refuses the switch
// instead of silently changing the lane mid-flight.
import { describe, expect, it } from 'vitest';
import { createTuiApp, type TuiApp } from './tui-app.js';

// Legacy byte form of Ctrl-G: parseKey maps it to 'ctrl+g' like the loop's
// other global keys (the Kitty CSI-u form is covered by the key-event suite).
const CTRL_G = '\x07';

function app(
  seed: { mode: 'solo' | 'orchestrator'; approvalsSkipped?: boolean } = {
    mode: 'solo',
  },
): TuiApp {
  return createTuiApp({
    sessionId: 's',
    model: 'faux/m',
    mode: seed.mode,
    approvalsSkipped: seed.approvalsSkipped ?? false,
  });
}

describe('session mode toggle (issue #327)', () => {
  it('starts in the seeded mode and flips it with ctrl+g', () => {
    const target = app();
    expect(target.mode()).toBe('solo');
    target.handleInput(CTRL_G);
    expect(target.mode()).toBe('orchestrator');
    target.handleInput(CTRL_G);
    expect(target.mode()).toBe('solo');
  });

  it('flips the header and the status indicator, not just the state', () => {
    const target = app();
    expect(target.render(100).join('\n')).not.toContain('orchestrator');
    target.handleInput(CTRL_G);
    const frame = target.render(100);
    expect(frame[0]).toContain('orchestrator');
    expect(frame.join('\n')).toContain('orchestrator • approvals:on');
  });

  it('refuses the switch while a turn runs, and says why', () => {
    const target = app();
    target.setBusy(true);
    expect(target.handleInput(CTRL_G)).toEqual({
      quit: false,
      consumed: true,
      cancel: false,
    });
    expect(target.mode()).toBe('solo');
    expect(target.render(120).join('\n')).toContain(
      'finish the current turn before switching',
    );
    target.setBusy(false);
    target.handleInput(CTRL_G);
    expect(target.mode()).toBe('orchestrator');
  });

  it('a seeded orchestrator session can toggle back to solo', () => {
    const target = app({ mode: 'orchestrator' });
    expect(target.mode()).toBe('orchestrator');
    target.handleInput(CTRL_G);
    expect(target.mode()).toBe('solo');
    expect(target.render(100)[0]).not.toContain('orchestrator');
  });

  it('the footer hint names the toggle key', () => {
    expect(app().render(100).join('\n')).toContain('ctrl+g mode');
  });

  it('setMode is the same state the key writes (one writer, two callers)', () => {
    const target = app();
    target.setMode('orchestrator');
    expect(target.mode()).toBe('orchestrator');
    expect(target.render(100).join('\n')).toContain(
      'orchestrator • approvals:on',
    );
  });
});
