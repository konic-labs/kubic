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
  // `network_policy` and `allowed_domains` are parsed and resolved, but
  // nothing enforces them: Kubic has no proxy or socket-level network
  // control, and the lane's network guard is the [permissions] class's
  // lexical bash detector. A configured value is therefore a failure, never
  // a pass, and the enforceability summary cannot pass while it is set.
  const mode = policy.network.mode;
  const domains = policy.network.domains?.length ?? 0;
  const networkCheck: import('../doctor/index.js').DoctorCheck =
    mode === undefined
      ? {
          id: 'policy:enterprise-network',
          label: 'policy enterprise network',
          status: 'pass',
          reason: 'ok',
          detail:
            'network_policy unset — the [permissions] network class governs network commands (a lexical bash detector)',
        }
      : {
          id: 'policy:enterprise-network',
          label: 'policy enterprise network',
          status: 'fail',
          reason: 'policy-mismatch',
          detail: `network_policy is not enforced: mode ${mode}${domains > 0 ? ` with ${domains} allowed domain(s)` : ''} is parsed, but no proxy or socket-level control applies it — the [permissions] network class is a lexical bash detector`,
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
