// Session-scoped approval skip (issue #48; §41.4 full-access posture).
// Explicit per-session opt-in only: fresh sessions start enforced, the
// record is keyed by sessionId (never shared across sessions), and every
// transition is indicated on the surface, recorded, and surfaced to audit
// and doctor — never quiet.
import type { DoctorCheck } from '../../doctor.js';

export class SessionSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionSkipError';
  }
}

export interface SessionSkipRecord {
  sessionId: string;
  scope: 'session';
  enabledAt: number;
  enabledBy: string;
  expiresAt?: number;
}

export interface SessionRef {
  sessionId: string;
}

export function enableSessionSkip(
  session: SessionRef,
  deps: { by: string; clock?: () => number; ttlMs?: number },
): SessionSkipRecord {
  if (
    typeof session.sessionId !== 'string' ||
    session.sessionId.trim().length === 0
  ) {
    throw new SessionSkipError('sessionId must be a non-empty string');
  }
  // Full-access is an explicit user opt-in: a worker/agent can never
  // enable it for itself — only deps.by === 'user' carries authority.
  if (deps.by !== 'user') {
    throw new SessionSkipError(
      `session skip must be enabled by the user (got by:${deps.by})`,
    );
  }
  if (deps.ttlMs !== undefined && !(deps.ttlMs > 0)) {
    throw new SessionSkipError('ttlMs must be a positive number when provided');
  }
  const enabledAt = (deps.clock ?? Date.now)();
  return {
    sessionId: session.sessionId,
    scope: 'session',
    enabledAt,
    enabledBy: deps.by,
    ...(deps.ttlMs !== undefined ? { expiresAt: enabledAt + deps.ttlMs } : {}),
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
  now: number = Date.now(),
): boolean {
  return records.some(
    (record) =>
      record.sessionId === session.sessionId &&
      (record.expiresAt === undefined || now < record.expiresAt),
  );
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
    status: 'fail',
    reason: 'full-access',
    detail:
      `session ${sessionId}: full-access approvals SKIPPED (enabled ${record.enabledAt} ` +
      `by ${record.enabledBy}, session scope) — re-enable enforcement to pass`,
  };
}
