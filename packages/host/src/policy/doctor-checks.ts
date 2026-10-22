// What `kubic doctor` reports about the effective enterprise policy.
import type { EffectivePolicy } from './types.js';

export interface EnterpriseDoctorEnv {
  // The configured `[[audit]]` sinks, in order. Absent: the policy's own
  // engine-level sinks (a programmatic policy).
  sinks?: ReadonlyArray<{ readonly kind: string }>;
  syslogAvailable: boolean;
}

// The sinks that take records off this machine.
const COLLECTORS: ReadonlySet<string> = new Set(['syslog', 'https', 'otlp']);

// Unenforceable policy is never silent: every check below is always
// emitted — enforceable leaves report pass, unenforceable ones report fail
// with the reason. Check ids are enterprise-scoped so they never collide
// with the host doctor or honest-limits checks (read-only, unmodified).
export function enterpriseDoctorChecks(
  policy: EffectivePolicy,
  env: EnterpriseDoctorEnv,
): import('../doctor/index.js').DoctorCheck[] {
  const sinks = env.sinks ?? policy.audit.sinks;
  let sinksCheck: import('../doctor/index.js').DoctorCheck;
  if (sinks.length === 0) {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: 'no audit sinks: privileged actions would go unaudited',
    };
  } else if (!COLLECTORS.has(sinks[0]?.kind ?? '')) {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'fail',
      reason: 'policy-mismatch',
      detail:
        'the first audit sink must be a collector — syslog, https or otlp ([[audit]] order) — so records leave the machine',
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
      detail: `collector-first (${sinks[0]?.kind}), ${sinks.length} sink(s) configured`,
    };
  }
  // `network_policy = "proxy"` with `allowed_domains` is enforced by the
  // egress proxy each run starts. Any other configured value is parsed and
  // reported but enforced by nothing beyond the [permissions] class's
  // lexical bash detector, so it is a failure, and the enforceability
  // summary cannot pass while it is set.
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
      : mode === 'allowlist' && domains > 0
        ? {
            id: 'policy:enterprise-network',
            label: 'policy enterprise network',
            status: 'pass',
            reason: 'ok',
            detail: `network_policy proxy: the bash tool reaches only ${domains} allowed domain(s), through the egress proxy each run starts (honoured by proxy-aware clients; with [sandbox] on macOS, the only connection a command can open)`,
          }
        : {
            id: 'policy:enterprise-network',
            label: 'policy enterprise network',
            status: 'fail',
            reason: 'policy-mismatch',
            detail: `network_policy is not enforced: mode ${mode}${domains > 0 ? ` with ${domains} allowed domain(s)` : ' with no allowed domain'} is parsed, but only "proxy" with allowed_domains starts the egress proxy — the [permissions] network class is a lexical bash detector`,
          };
  const dataCheck = dataPolicyCheck(policy.data.policy);
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
  return [
    sinksCheck,
    networkCheck,
    ...(dataCheck === undefined ? [] : [dataCheck]),
    enforceability,
  ];
}

// `data_policy`: what the value enforces, or that it enforces nothing.
function dataPolicyCheck(
  value: string | undefined,
): import('../doctor/index.js').DoctorCheck | undefined {
  if (value === undefined) return undefined;
  const base = { id: 'policy:data', label: 'policy data' } as const;
  if (value === 'redact' || value === 'redact-model') {
    return {
      ...base,
      status: 'pass',
      reason: 'ok',
      detail: `data_policy ${value}: secrets are scanned out of everything a session stores (its transcript, trajectory and spans; the journal keeps file content for undo) and out of the raw transcript sessions attach prints${
        value === 'redact-model'
          ? ', and out of tool output before the model reads it'
          : ''
      }`,
    };
  }
  return {
    ...base,
    status: 'warn',
    reason: 'policy-mismatch',
    detail: `data_policy ${JSON.stringify(value)} is carried and reported, not enforced: Kubic enforces "redact" and "redact-model"`,
  };
}
