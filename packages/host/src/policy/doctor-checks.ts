// What `kubic doctor` reports about the effective enterprise policy.
import type { EffectivePolicy } from './types.js';

export interface EnterpriseDoctorEnv {
  syslogAvailable: boolean;
}

// Unenforceable policy is never silent: every check below is always
// emitted — enforceable leaves report pass, unenforceable ones report fail
// with the reason. Check ids are enterprise-scoped so they never collide
// with the host doctor or honest-limits checks (read-only, unmodified).
export function enterpriseDoctorChecks(
  policy: EffectivePolicy,
  env: EnterpriseDoctorEnv,
): import('../doctor/index.js').DoctorCheck[] {
  const sinks = policy.audit.sinks;
  let sinksCheck: import('../doctor/index.js').DoctorCheck;
  if (sinks.length === 0) {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: 'no audit sinks: privileged actions would go unaudited',
    };
  } else if (sinks[0]?.kind !== 'syslog') {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: 'audit sinks must be syslog-first ([[audit]] order)',
    };
  } else if (
    sinks.some((sink) => sink.kind === 'syslog') &&
    !env.syslogAvailable
  ) {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: 'syslog sink is unenforceable: syslog unavailable',
    };
  } else {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'pass',
      reason: 'ok',
      detail: `syslog-first, ${sinks.length} sink(s) configured`,
    };
  }
  const allowlistEmpty =
    policy.network.mode === 'allowlist' &&
    (policy.network.domains === undefined ||
      policy.network.domains.length === 0);
  const networkCheck: import('../doctor/index.js').DoctorCheck = allowlistEmpty
    ? {
        id: 'policy:enterprise-network',
        label: 'policy enterprise network',
        status: 'fail',
        reason: 'policy-mismatch',
        detail: 'network allowlist mode with no domains is unenforceable',
      }
    : {
        id: 'policy:enterprise-network',
        label: 'policy enterprise network',
        status: 'pass',
        reason: 'ok',
        detail: `network mode ${policy.network.mode ?? 'unset (deny-by-default)'}`,
      };
  const failed = [sinksCheck, networkCheck].filter(
    (check) => check.status === 'fail',
  ).length;
  const enforceability: import('../doctor/index.js').DoctorCheck =
    failed === 0
      ? {
          id: 'policy:enterprise-enforceability',
          label: 'policy enterprise enforceability',
          status: 'pass',
          reason: 'ok',
          detail: 'enterprise policy enforceable on this host',
        }
      : {
          id: 'policy:enterprise-enforceability',
          label: 'policy enterprise enforceability',
          status: 'fail',
          reason: 'policy-mismatch',
          detail: `${failed} unenforceable enterprise policy item(s)`,
        };
  return [sinksCheck, networkCheck, enforceability];
}
