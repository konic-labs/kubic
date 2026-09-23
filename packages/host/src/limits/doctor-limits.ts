// Honest-limits doctor checks (issue #58; §59.1, §78, §50).
// Doctor reports exactly enforced-or-not. Static §59.1 notices pass when
// disclosed (a limit check passes because the limit IS reported, never
// because the limit is enforced). Degraded posture — no reachable
// provider, missing dep, unenforceable v1 policy value — fails with an
// honest message. Schema/consistency failures stay owned by #29's
// policy:approvals check: an invalid policy shape is not double-failed
// here, it points at its owner. Faux-only: injected values, no I/O.

import { validatePolicy } from '../approvals.js';
import type { DoctorCheck } from '../doctor.js';

// §78 provider-failure code, mirroring kubic run (§78): a doctor matrix
// with a provider-down failure exits 6. #29's command keeps its own
// exit contract; this mapper is what the composition root adopts.
export const LIMITS_DOCTOR_EXIT_OK = 0;
export const LIMITS_DOCTOR_EXIT_FAIL = 1;
export const LIMITS_DOCTOR_EXIT_PROVIDER = 6;

export interface LimitProviderProbe {
  id: string;
  reachable: boolean;
}

export interface LimitDepProbe {
  id: string;
  ok: boolean;
  detail?: string;
}

// Every applicable §59.1 limit, disclosed (pass/ok): the check passes
// because the limit is reported, never as a protection claim.
export function staticLimitChecks(): DoctorCheck[] {
  return [
    {
      id: 'limit:solo-no-isolation',
      label: 'limit solo no-isolation',
      status: 'pass',
      reason: 'ok',
      detail:
        'honest limit (not enforced): solo runs in-process with your user authority (files, network, credentials) — no isolation, no containment; controls are approvals + journal (§59.1, §3.7)',
    },
    {
      id: 'limit:worktrees-writers-only',
      label: 'limit worktrees writers-only',
      status: 'pass',
      reason: 'ok',
      detail:
        'honest limit (not enforced): orchestrator worktrees separate concurrent writers only — they are not isolation or containment (§59.1)',
    },
    {
      id: 'limit:no-injection-prevention',
      label: 'limit no injection prevention',
      status: 'pass',
      reason: 'ok',
      detail:
        'honest limit (not enforced): no prompt-injection prevention — untrusted output is data, never instruction; approvals + journal are the controls (§59.1)',
    },
    {
      id: 'limit:policy-offer',
      label: 'limit policy offer',
      status: 'pass',
      reason: 'ok',
      detail:
        'honest limit (not enforced): approval policy is an offer for routing, not enforcement — unenforceable values are reported, never honored (§59.1)',
    },
    {
      id: 'limit:journal-not-backup',
      label: 'limit journal not backup',
      status: 'pass',
      reason: 'ok',
      detail:
        'honest limit (not enforced): the change journal is a review/undo log, not a backup — it cannot restore outside state (§59.1)',
    },
    {
      id: 'limit:no-third-party-mcp',
      label: 'limit no third-party MCP',
      status: 'pass',
      reason: 'ok',
      detail:
        'honest limit (not enforced): v1 has no third-party tools or MCP servers — requests for them are refused (§59.1, §33)',
    },
  ];
}

// Missing provider (§78): no reachable provider fails provider-down and
// names the run exit code so the message stays honest end to end.
export function providerAvailabilityCheck(
  probes: readonly LimitProviderProbe[],
): DoctorCheck {
  const base = {
    id: 'limit:provider-availability',
    label: 'limit provider availability',
  };
  const reachable = probes.filter((probe) => probe.reachable);
  if (reachable.length === 0) {
    const known = probes.map((probe) => probe.id).join(', ');
    return {
      ...base,
      status: 'fail',
      reason: 'provider-down',
      detail:
        known.length > 0
          ? `no reachable provider (known: ${known}) — configure a provider; \`kubic run\` exits 6 on provider failure (§78)`
          : 'no providers configured — configure a provider; `kubic run` exits 6 on provider failure (§78)',
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail: `reachable: ${reachable.map((probe) => probe.id).join(', ')}`,
  };
}

export function depsLimitCheck(deps: readonly LimitDepProbe[]): DoctorCheck {
  const base = { id: 'limit:deps-present', label: 'limit deps present' };
  const missing = deps.filter((dep) => !dep.ok);
  if (missing.length > 0) {
    return {
      ...base,
      status: 'fail',
      reason: 'deps-missing',
      detail: `missing: ${missing.map((dep) => dep.id).join(', ')}`,
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail:
      deps.length > 0
        ? `present: ${deps.map((dep) => dep.id).join(', ')}`
        : 'no dep probes registered',
  };
}

const MCP_REQUEST_PATTERN = /^(mcp|extensions?|third-party)(:|$)/;
const MCP_REQUEST_EXACT = new Set(['mcp', 'extensions', 'extension']);

// v1 enforceability: third-party/MCP requests are valid-shaped policy
// values that v1 cannot honor, so they fail here with the refusal.
// Invalid shapes are #29's to fail — this check passes with a pointer
// instead of double-failing the same root cause.
export function policyEnforceabilityCheck(raw: unknown): DoctorCheck {
  const base = {
    id: 'policy:enforceability',
    label: 'policy enforceability',
  };
  let autoApprove: string[];
  let route: string;
  try {
    const policy = validatePolicy(raw);
    autoApprove = [...policy.autoApprove];
    route = policy.route;
  } catch (error) {
    return {
      ...base,
      status: 'pass',
      reason: 'ok',
      detail: `not assessed: policy invalid — see policy:approvals (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'mcp')) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail:
        'config key [mcp] is unsupported in v1 (Phase-4 arrival; §33, §59.1)',
    };
  }
  const refused = autoApprove.filter(
    (cap) => MCP_REQUEST_PATTERN.test(cap) || MCP_REQUEST_EXACT.has(cap),
  );
  if (refused.length > 0) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: `${refused.join(', ')} unsupported in v1: no third-party tools or MCP servers (Phase-4 arrival; §33, §59.1)`,
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail: `route=${route}, ${autoApprove.length} auto-approved — policy offers routing, not enforcement`,
  };
}

export function limitsDoctorExit(checks: readonly DoctorCheck[]): number {
  if (
    checks.some(
      (check) => check.status === 'fail' && check.reason === 'provider-down',
    )
  ) {
    return LIMITS_DOCTOR_EXIT_PROVIDER;
  }
  if (checks.some((check) => check.status === 'fail')) {
    return LIMITS_DOCTOR_EXIT_FAIL;
  }
  return LIMITS_DOCTOR_EXIT_OK;
}

export interface LimitsJsonReport {
  ok: boolean;
  exitCode: number;
  checks: DoctorCheck[];
}

// --json envelope (§50/78): the same {ok, exitCode, checks} shape the
// doctor command emits, so human and machine readers agree.
export function buildLimitsJsonReport(checks: DoctorCheck[]): LimitsJsonReport {
  const exitCode = limitsDoctorExit(checks);
  return { ok: exitCode === LIMITS_DOCTOR_EXIT_OK, exitCode, checks };
}

export interface LimitProbeInputs {
  providers: readonly LimitProviderProbe[];
  deps: readonly LimitDepProbe[];
  policy: unknown;
}

export function collectLimitChecks(input: LimitProbeInputs): DoctorCheck[] {
  return [
    ...staticLimitChecks(),
    providerAvailabilityCheck(input.providers),
    depsLimitCheck(input.deps),
    policyEnforceabilityCheck(input.policy),
  ];
}

export interface LimitProbeDeps {
  probeProviders: () => LimitProviderProbe[];
  checkDeps: () => LimitDepProbe[];
  loadPolicy: () => unknown;
}

function probeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Registration entry for #29's doctor.ts (append-only): every section is
// total — a throwing probe becomes a failing check, never a crash — so
// the appended lines cannot break the doctor command.
export function collectLimitChecksFromDeps(
  deps: LimitProbeDeps,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [...staticLimitChecks()];
  try {
    checks.push(providerAvailabilityCheck(deps.probeProviders()));
  } catch (error) {
    checks.push({
      id: 'limit:provider-availability',
      label: 'limit provider availability',
      status: 'fail',
      reason: 'provider-down',
      detail: probeMessage(error),
    });
  }
  try {
    checks.push(depsLimitCheck(deps.checkDeps()));
  } catch (error) {
    checks.push({
      id: 'limit:deps-present',
      label: 'limit deps present',
      status: 'fail',
      reason: 'deps-missing',
      detail: probeMessage(error),
    });
  }
  try {
    checks.push(policyEnforceabilityCheck(deps.loadPolicy()));
  } catch (error) {
    checks.push({
      id: 'policy:enforceability',
      label: 'policy enforceability',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: probeMessage(error),
    });
  }
  return checks;
}
