// The session checks: live full-access sessions, sessions that overlap on one
// workspace, and the permissions of the sessions root.
import type { FullAccessSession } from '../doctor-full-access.js';
import type {
  DoctorCheck,
  SessionOverlapProbe,
  StatePermissionProbe,
} from '../types.js';

export function fullAccessSessionCheck(
  session: FullAccessSession,
): DoctorCheck {
  // Warn, never fail: full access is operator intent (flag or toggle),
  // doctor informs. The detail names the grant when the posture recorded
  // one, and the way back to enforcement.
  const granted =
    session.enabledAt === undefined && session.enabledBy === undefined
      ? 'grant details not recorded'
      : `enabled ${session.enabledAt ?? 'at an unknown time'} by ${session.enabledBy ?? 'an unknown operator'}`;
  return {
    id: `session:full-access:${session.sessionId}`,
    label: 'session full access',
    status: 'warn',
    reason: 'full-access',
    detail:
      `session ${session.sessionId}: approvals FULL ACCESS (${granted}) — ` +
      'end the session or switch approvals back on; new sessions start enforced',
  };
}

export function sessionOverlapCheck(probe: SessionOverlapProbe): DoctorCheck {
  const base = { id: 'session:overlap', label: 'session overlap' };
  // Warn, never fail: concurrent different-session runs in one
  // repo are LEGAL — warn is informational and never exit-flipping. The
  // note states the sweep's blind spot: each run's end-of-run sweep
  // compares against its own boot baseline, so a sibling's in-flight
  // changes are recorded as unattributed, non-reversible entries.
  if (probe.sessionIds.length > 1) {
    return {
      ...base,
      status: 'warn',
      reason: 'ok',
      detail:
        `${probe.sessionIds.length} sessions recorded against ${probe.workspace} (${probe.sessionIds.join(', ')}) — ` +
        "if two are live at once, each run records the other's in-flight changes as unattributed, non-reversible journal entries",
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail:
      probe.sessionIds.length === 1
        ? `1 session recorded against ${probe.workspace} — no sweep overlap`
        : `no sessions recorded against ${probe.workspace} — no sweep overlap`,
  };
}

export function statePermissionCheck(
  probe: StatePermissionProbe | undefined,
): DoctorCheck {
  const base = { id: 'state:permissions', label: 'state permissions' };
  if (probe === undefined) {
    return {
      ...base,
      status: 'pass',
      reason: 'ok',
      detail:
        'session and journal state directories are private (0700) or absent',
    };
  }
  return {
    ...base,
    status: 'warn',
    reason: 'ok',
    detail:
      `${probe.path} is ${probe.mode.toString(8).padStart(3, '0')} — every local user can read ` +
      'session transcripts and journaled file content; the next open tightens it to 0700 ' +
      '(or run chmod 700 on it)',
  };
}
