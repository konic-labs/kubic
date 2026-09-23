// Session-scoped approval skip (issue #48; §41.4 full-access posture).
// Explicit per-session opt-in only: fresh sessions start enforced, the
// record is keyed by sessionId (never shared across sessions), and every
// transition is indicated on the surface, recorded, and surfaced to audit
// and doctor — never quiet.
import type { DoctorCheck } from '../../doctor.js';

export interface SessionSkipRecord {
  sessionId: string;
  scope: 'session';
  enabledAt: number;
  enabledBy: string;
}

export interface SessionRef {
  sessionId: string;
}

export function enableSessionSkip(
  session: SessionRef,
  deps: { by: string; clock?: () => number },
): SessionSkipRecord {
  return {
    sessionId: session.sessionId,
    scope: 'session',
    enabledAt: (deps.clock ?? Date.now)(),
    enabledBy: deps.by,
  };
}

export function disableSessionSkip(
  sessionId: string,
  records: readonly SessionSkipRecord[],
): SessionSkipRecord[] {
  return records.filter((record) => record.sessionId !== sessionId);
}

export function isSessionSkipEnabled(
  session: SessionRef,
  records: readonly SessionSkipRecord[] = [],
): boolean {
  return records.some((record) => record.sessionId === session.sessionId);
}

export function formatSessionSkipIndicator(record: SessionSkipRecord): string {
  return `full-access approvals skipped for session ${record.sessionId} (enabled ${record.enabledAt} by ${record.enabledBy}, session scope)`;
}

export interface SessionSkipAuditEvent {
  type: 'session-skip';
  action: 'enabled' | 'disabled';
  sessionId: string;
  scope: 'session';
  enabledBy?: string;
  enabledAt?: number;
}

export function buildSessionSkipAuditEvent(
  record: SessionSkipRecord,
  action: 'enabled' | 'disabled',
): SessionSkipAuditEvent {
  return {
    type: 'session-skip',
    action,
    sessionId: record.sessionId,
    scope: 'session',
    ...(action === 'enabled'
      ? { enabledBy: record.enabledBy, enabledAt: record.enabledAt }
      : {}),
  };
}

export function buildSessionSkipDoctorCheck(
  sessionId: string,
  records: readonly SessionSkipRecord[] = [],
): DoctorCheck {
  const record = records.find((entry) => entry.sessionId === sessionId);
  if (record === undefined) {
    return {
      id: 'approvals:session-skip',
      label: 'approvals session skip',
      status: 'pass',
      reason: 'ok',
      detail: `session ${sessionId}: approvals enforced`,
    };
  }
  return {
    id: 'approvals:session-skip',
    label: 'approvals session skip',
    status: 'pass',
    reason: 'ok',
    detail:
      `session ${sessionId}: full-access (enabled ${record.enabledAt} ` +
      `by ${record.enabledBy}, session scope)`,
  };
}
