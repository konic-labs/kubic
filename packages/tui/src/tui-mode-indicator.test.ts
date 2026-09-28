// The always-visible mode indicator reads the seed, never literals (issue
// #307; §17, §18): a full-access session must never render 'approvals:on'.
import { describe, expect, it } from 'vitest';
import { createTuiApp } from './tui-app.js';

const WARNING = '! warning: approvals OFF (full-access)';

describe('mode indicator seeded from the installed posture (issue #307)', () => {
  it('renders the full-access warning when the seed says approvals are skipped', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      mode: 'solo',
      approvalsSkipped: true,
    });
    const frame = app.render(100).join('\n');
    expect(frame).toContain(WARNING);
    expect(frame).not.toContain('approvals:on');
  });

  it("renders 'approvals:on' for a session with approvals in force", () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(app.render(100).join('\n')).toContain('approvals:on');
  });

  it('takes the header and status mode label from the seed', () => {
    const solo = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      mode: 'solo',
      approvalsSkipped: false,
    });
    expect(solo.render(100).join('\n')).not.toContain('orchestrator');
    const orchestrator = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      mode: 'orchestrator',
      approvalsSkipped: false,
    });
    const frame = orchestrator.render(100);
    expect(frame[0]).toContain('orchestrator');
    expect(frame.join('\n')).toContain('orchestrator • approvals:on');
  });

  it('a posture change updates the indicator on the next frame', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      mode: 'solo',
      approvalsSkipped: false,
    });
    app.setApprovalsSkipped(true);
    expect(app.render(100).join('\n')).toContain(WARNING);
    app.setApprovalsSkipped(false);
    expect(app.render(100).join('\n')).toContain('approvals:on');
  });

  it('requires the posture fields on every seed (no silent default to on)', () => {
    const missing = () =>
      // @ts-expect-error — approvalsSkipped is required on TuiAppSeed.
      createTuiApp({ sessionId: 's', model: 'm', mode: 'solo' });
    const noMode = () =>
      // @ts-expect-error — mode is required on TuiAppSeed.
      createTuiApp({ sessionId: 's', model: 'm', approvalsSkipped: false });
    expect(typeof missing).toBe('function');
    expect(typeof noMode).toBe('function');
  });
});
