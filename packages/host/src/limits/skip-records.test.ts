// Session-scoped loud full-access skip records (issue #58; §41.4).
// RED first: on top of #48's session record + audit + doctor, #58 adds
// the trajectory record, the log posture line (posture + timestamp), and
// per-session re-arm (session end expires the grant). Faux-only: pure
// data builders over #48 records, no I/O.
import { describe, expect, it } from 'vitest';
import type { SessionSkipRecord } from '../orchestrator/approvals/skip.js';
import { enableSessionSkip } from '../orchestrator/approvals/skip.js';
import {
  buildFullAccessDoctorCheck,
  buildFullAccessTrajectoryEvent,
  endSessionSkip,
  formatFullAccessLogLine,
  summarizeFullAccess,
} from './skip-records.js';

function grant(sessionId = 's1', at = 1700000000000): SessionSkipRecord {
  return enableSessionSkip({ sessionId }, { by: 'user', clock: () => at });
}

describe('loud full-access skip records (issue #58)', () => {
  it('fresh sessions start enforced with no timestamp', () => {
    const view = summarizeFullAccess('s1', []);
    expect(view.live).toBe(false);
    expect(view.posture).toBe('enforced');
    expect(view.enabledAt).toBeUndefined();
  });

  it('a live grant summarizes posture plus timestamp and owner', () => {
    const view = summarizeFullAccess('s1', [grant()]);
    expect(view.live).toBe(true);
    expect(view.posture).toBe('full-access');
    expect(view.enabledAt).toBe(1700000000000);
    expect(view.enabledBy).toBe('user');
  });

  it('grants never leak across sessions', () => {
    const view = summarizeFullAccess('s2', [grant('s1')]);
    expect(view.live).toBe(false);
    expect(view.posture).toBe('enforced');
  });

  it('log line carries posture and timestamp for queryable posture', () => {
    const line = formatFullAccessLogLine(summarizeFullAccess('s1', [grant()]));
    expect(line).toContain('[session]');
    expect(line).toContain('s1');
    expect(line).toContain('posture: full-access');
    expect(line).toContain('1700000000000');
    expect(line).toContain('user');
  });

  it('enforced log line names the posture without a timestamp', () => {
    const line = formatFullAccessLogLine(summarizeFullAccess('s1', []));
    expect(line).toContain('posture: approvals enforced');
  });

  it('trajectory event records session, owner, and timestamp', () => {
    const event = buildFullAccessTrajectoryEvent(
      summarizeFullAccess('s1', [grant()]),
      'enabled',
    );
    expect(event.type).toBe('session-skip');
    expect(event.action).toBe('enabled');
    expect(event.sessionId).toBe('s1');
    expect(event.scope).toBe('session');
    expect(event.enabledAt).toBe(1700000000000);
    expect(event.enabledBy).toBe('user');
  });

  it('disabled and expired trajectory events preserve owner and timestamp', () => {
    const live = summarizeFullAccess('s1', [grant()]);
    for (const action of ['disabled', 'expired'] as const) {
      const event = buildFullAccessTrajectoryEvent(live, action);
      expect(event.action).toBe(action);
      expect(event.sessionId).toBe('s1');
      // A trajectory is a historical record: the grant's provenance
      // survives the transition instead of being dropped.
      expect(event.enabledAt).toBe(1700000000000);
      expect(event.enabledBy).toBe('user');
    }
  });

  it('session end expires the grant and re-arms enforcement', () => {
    const ended = endSessionSkip('s1', [grant('s1'), grant('s2')]);
    expect(ended.ended?.sessionId).toBe('s1');
    expect(ended.records.map((record) => record.sessionId)).toEqual(['s2']);
    const view = summarizeFullAccess('s1', ended.records);
    expect(view.live).toBe(false);
    expect(view.posture).toBe('enforced');
  });

  it('an expired TTL reads enforced (fail closed)', () => {
    const record = enableSessionSkip(
      { sessionId: 's1' },
      { by: 'user', clock: () => 1000, ttlMs: 500 },
    );
    const view = summarizeFullAccess('s1', [record], 2000);
    expect(view.live).toBe(false);
    expect(view.posture).toBe('enforced');
  });

  it('doctor check fails loud with posture and timestamp while live', () => {
    const check = buildFullAccessDoctorCheck('s1', [grant()]);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/full-access/);
    expect(check.detail).toContain('1700000000000');
    const enforced = buildFullAccessDoctorCheck('s1', []);
    expect(enforced.status).toBe('pass');
    expect(enforced.detail).toMatch(/enforced/);
  });
});
