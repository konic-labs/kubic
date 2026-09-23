// Session-scoped approval skip (issue #48; §41.4).
// RED first: explicit per-session opt-in with indicator, record, audit,
// and doctor surfacing — never quiet, never cross-session.
import { describe, expect, it } from 'vitest';
import {
  buildSessionSkipAuditEvent,
  buildSessionSkipDoctorCheck,
  disableSessionSkip,
  enableSessionSkip,
  formatSessionSkipIndicator,
  isSessionSkipEnabled,
} from './skip.js';

describe('session-scoped skip (issue #48)', () => {
  it('starts disabled for every fresh session', () => {
    expect(isSessionSkipEnabled({ sessionId: 's1' })).toBe(false);
  });

  it('enables explicitly with indicator + record (session scope)', () => {
    const record = enableSessionSkip(
      { sessionId: 's1' },
      { by: 'user', clock: () => 1700000000000 },
    );
    expect(record.sessionId).toBe('s1');
    expect(record.scope).toBe('session');
    expect(record.enabledBy).toBe('user');
    expect(record.enabledAt).toBe(1700000000000);
    expect(isSessionSkipEnabled({ sessionId: 's1' }, [record])).toBe(true);
    expect(isSessionSkipEnabled({ sessionId: 's2' }, [record])).toBe(false);
    expect(formatSessionSkipIndicator(record)).toMatch(/full-access/i);
    expect(formatSessionSkipIndicator(record)).toContain('s1');
  });

  it('disables back to enforced', () => {
    const record = enableSessionSkip(
      { sessionId: 's1' },
      { by: 'user', clock: () => 1 },
    );
    const records = disableSessionSkip('s1', [record]);
    expect(isSessionSkipEnabled({ sessionId: 's1' }, records)).toBe(false);
  });

  it('emits an audit event for enable/disable', () => {
    const record = enableSessionSkip(
      { sessionId: 's1' },
      { by: 'user', clock: () => 7 },
    );
    const event = buildSessionSkipAuditEvent(record, 'enabled');
    expect(event.type).toBe('session-skip');
    expect(JSON.stringify(event)).toContain('s1');
    const off = buildSessionSkipAuditEvent(record, 'disabled');
    expect(off.action).toBe('disabled');
  });

  it('surfaces a doctor check naming the posture', () => {
    const record = enableSessionSkip(
      { sessionId: 's1' },
      { by: 'user', clock: () => 7 },
    );
    const check = buildSessionSkipDoctorCheck('s1', [record]);
    expect(check.id).toBe('approvals:session-skip');
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/full-access/);
    const enforced = buildSessionSkipDoctorCheck('s2', [record]);
    expect(enforced.detail).toMatch(/enforced/);
  });
});
