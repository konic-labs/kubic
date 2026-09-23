// Session-scoped loud full-access skip records (issue #58; §41.4).
// #48 owns the session grant (enable/isSessionSkipEnabled), the audit
// event, and the doctor check. This module adds the #58 slice: the
// trajectory record, the queryable log posture line (posture +
// timestamp), and per-session re-arm — session end expires the grant so
// every fresh session starts enforced and must opt in again. Pure data
// builders; persistence and wiring belong to other issues.
import type { DoctorCheck } from '../doctor.js';
import type { SessionSkipRecord } from '../orchestrator/approvals/skip.js';
import {
  buildSessionSkipDoctorCheck,
  isSessionSkipEnabled,
} from '../orchestrator/approvals/skip.js';

export interface FullAccessView {
  sessionId: string;
  posture: 'full-access' | 'enforced';
  live: boolean;
  enabledAt?: number;
  enabledBy?: string;
}

export function summarizeFullAccess(
  sessionId: string,
  records: readonly SessionSkipRecord[],
  now: number = Date.now(),
): FullAccessView {
  const record = records.find(
    (entry) =>
      entry.sessionId === sessionId &&
      isSessionSkipEnabled({ sessionId }, [entry], now),
  );
  if (record === undefined) {
    return { sessionId, posture: 'enforced', live: false };
  }
  return {
    sessionId,
    posture: 'full-access',
    live: true,
    enabledAt: record.enabledAt,
    enabledBy: record.enabledBy,
  };
}

// Queryable log posture (§50 [session] class): posture plus the grant
// timestamp while live, plain enforced posture otherwise.
export function formatFullAccessLogLine(view: FullAccessView): string {
  if (!view.live) {
    return `[session] session ${view.sessionId} posture: approvals enforced`;
  }
  return (
    `[session] session ${view.sessionId} posture: full-access ` +
    `enabledAt=${view.enabledAt} enabledBy=${view.enabledBy}`
  );
}

export interface FullAccessTrajectoryEvent {
  type: 'session-skip';
  action: 'enabled' | 'disabled' | 'expired';
  sessionId: string;
  scope: 'session';
  enabledBy?: string;
  enabledAt?: number;
}

export function buildFullAccessTrajectoryEvent(
  view: FullAccessView,
  action: 'enabled' | 'disabled' | 'expired',
): FullAccessTrajectoryEvent {
  return {
    type: 'session-skip',
    action,
    sessionId: view.sessionId,
    scope: 'session',
    ...(action === 'enabled'
      ? { enabledBy: view.enabledBy, enabledAt: view.enabledAt }
      : {}),
  };
}

// Per-session re-arm: ending a session drops its grants (full-access
// expires at session end) and hands back the ended record for the
// audit trail. Other sessions are untouched.
export function endSessionSkip(
  sessionId: string,
  records: readonly SessionSkipRecord[],
): { records: SessionSkipRecord[]; ended: SessionSkipRecord | undefined } {
  const ended = records.find((record) => record.sessionId === sessionId);
  return {
    records: records.filter((record) => record.sessionId !== sessionId),
    ended,
  };
}

// Doctor query carries #48's failing check (posture + timestamp) so
// full-access stays queryable after the grant.
export function buildFullAccessDoctorCheck(
  sessionId: string,
  records: readonly SessionSkipRecord[],
  now: number = Date.now(),
): DoctorCheck {
  return buildSessionSkipDoctorCheck(sessionId, records, now);
}
