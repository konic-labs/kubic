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
  const octal = (mode: number) => mode.toString(8).padStart(3, '0');
  const scope =
    probe?.truncated === true
      ? ` (checked the first ${probe.checked} entries)`
      : '';
  if (probe === undefined || probe.count === 0) {
    return {
      ...base,
      status: 'pass',
      reason: 'ok',
      detail: `session, journal, audit and trust state is private (0700 directories, 0600 files) or absent${scope}`,
    };
  }
  const named = probe.loose
    .map(
      (entry) =>
        `${entry.path} is ${octal(entry.mode)}, expected ${octal(entry.expected)}`,
    )
    .join('; ');
  const more =
    probe.count > probe.loose.length
      ? ` (+${probe.count - probe.loose.length} more)`
      : '';
  return {
    ...base,
    status: 'warn',
    reason: 'ok',
    detail:
      `${named}${more}${scope} — every local user can read session ` +
      'transcripts, journaled file content and audit records; chmod 700 a ' +
      'directory and 600 a file to close it',
  };
}

// The paths `journal.outOfScope` leaves out of the journal: the baseline and
// the end-of-run sweep skip them, so a change there is never journaled and
// `kubic undo` cannot restore it.
export function journalCoverageCheck(coverage: {
  readonly outOfScope: readonly string[];
  readonly source: string;
}): DoctorCheck {
  return {
    id: 'journal:out-of-scope',
    label: 'journal out of scope',
    status: 'warn',
    reason: 'ok',
    detail: `journal.outOfScope (${coverage.source}) leaves ${coverage.outOfScope.length} path(s) out of the journal: ${coverage.outOfScope.join(', ')} — changes there are not journaled, and kubic undo cannot restore them`,
  };
}
