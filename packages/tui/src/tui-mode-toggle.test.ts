// The session mode toggle (issue #327; §17, §80, §81): Ctrl-G switches the
// session between solo and orchestrator between turns. The indicator takes
// the state, not the boot seed, and a running turn refuses the switch
// instead of silently changing the lane mid-flight.
import { describe, expect, it } from 'vitest';
import type { KubicPresentationState } from '../../core/src/presentation.js';
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

  it('flips the header badge, not just the state', () => {
    const target = app();
    expect(target.render(100).join('\n')).not.toMatch(/orchestrator/i);
    target.handleInput(CTRL_G);
    const frame = target.render(100);
    expect(frame[0]).toContain('[ORCHESTRATOR] approvals on');
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
    expect(target.render(100)[0]).not.toMatch(/orchestrator/i);
    expect(target.render(100)[0]).toContain('[SOLO]');
  });

  it('the footer hint names the toggle key', () => {
    expect(app().render(100).join('\n')).toContain('ctrl+g mode');
  });

  it('setMode is the same state the key writes (one writer, two callers)', () => {
    const target = app();
    target.setMode('orchestrator');
    expect(target.mode()).toBe('orchestrator');
    expect(target.render(100)[0]).toContain('[ORCHESTRATOR] approvals on');
  });
});

describe('the app owns its own mode and posture (issue #333 review)', () => {
  // The state's session facts are the SEED (the lane the boot selected): the
  // projector never updates them from events, so writing them back on every
  // applyPresentation silently reverts a Ctrl-G toggle or an approval
  // posture change — and the mode is read at submit time, so a toggled
  // session would route its next prompt to the lane it left.
  const staleSeed = (): KubicPresentationState => ({
    session: { sessionId: 's', mode: 'solo', approvalsSkipped: false },
    agents: new Map(),
    lanes: new Map(),
    workers: new Map(),
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  });

  it('keeps a toggled mode across a presentation apply', () => {
    const target = app();
    target.handleInput(CTRL_G);
    expect(target.mode()).toBe('orchestrator');
    target.applyPresentation(staleSeed());
    expect(target.mode()).toBe('orchestrator');
    expect(target.render(100)[0]).toContain('[ORCHESTRATOR]');
  });

  it('keeps the posture the policy installed across a presentation apply', () => {
    const target = app();
    target.setApprovalsSkipped(true);
    target.applyPresentation(staleSeed());
    expect(target.render(100).join('\n')).toContain('approvals OFF');
  });
});

// Issue #276: the switch is reported so the composition root can persist it
// with the session (reattach restores it); a no-op set reports nothing.
describe('session mode change reports (issue #276)', () => {
  it('reports each real change through onModeChange', () => {
    const changes: string[] = [];
    const target = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      mode: 'solo',
      approvalsSkipped: false,
      onModeChange: (mode) => changes.push(mode),
    });
    target.handleInput(CTRL_G);
    target.setMode('orchestrator');
    target.handleInput(CTRL_G);
    expect(changes).toEqual(['orchestrator', 'solo']);
  });
});
