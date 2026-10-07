// The always-visible approvals indicator reads the seed, never literals: a
// full-access session must never render 'approvals on'. The indicator lives
// in the one-row header.
import { describe, expect, it } from 'vitest';
import { createTuiApp } from './tui-app.js';

const WARNING = 'approvals OFF (full-access)';

describe('approvals indicator seeded from the installed posture', () => {
  it('renders the full-access warning when the seed says approvals are skipped', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: true,
    });
    const frame = app.render(100).join('\n');
    expect(frame).toContain(WARNING);
    expect(frame).not.toContain('approvals on');
  });

  it("renders 'approvals on' for a session with approvals in force", () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: false,
    });
    expect(app.render(100)[0]).toContain('approvals on');
  });

  it('a posture change updates the indicator on the next frame', () => {
    const app = createTuiApp({
      sessionId: 's',
      model: 'faux/m',
      approvalsSkipped: false,
    });
    app.setApprovalsSkipped(true);
    expect(app.render(100).join('\n')).toContain(WARNING);
    app.setApprovalsSkipped(false);
    expect(app.render(100).join('\n')).toContain('approvals on');
  });

  it('requires the posture field on every seed (no silent default to on)', () => {
    const missing = () =>
      // @ts-expect-error — approvalsSkipped is required on TuiAppSeed.
      createTuiApp({ sessionId: 's', model: 'm' });
    expect(typeof missing).toBe('function');
  });
});
