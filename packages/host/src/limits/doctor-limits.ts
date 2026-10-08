// Honest-limits doctor checks.
// Doctor reports exactly enforced-or-not. Static notices report
// warn (informational: the limit IS disclosed, never enforced and never
// a protection claim) — warn never flips the doctor exit code. Degraded
// posture — no available provider, missing dep, unenforceable v1 policy
// value — fails with an honest message (provider-down exits 6, the rest
// exit 1, via limitsDoctorExit). Schema/consistency failures stay owned
// by the policy:approvals check: an invalid policy shape is not
// double-failed here, it points at its owner. Faux-only: injected
// values, no I/O.

import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
  type ExitCode,
} from '../../../core/src/cli/exit-codes.js';
import { alwaysAskAutoApprove, validatePolicy } from '../approvals.js';
import { mcpRefusalMessage } from '../config/stances.js';
import type { DoctorCheck } from '../doctor.js';

export interface LimitProviderProbe {
  id: string;
  reachable: boolean;
  /** Honesty switch: true only when a real dial produced this. */
  dialled?: boolean;
}

export interface LimitDepProbe {
  id: string;
  ok: boolean;
  detail?: string;
}

// Every applicable limit, disclosed as warn (informational, never
// exit-flipping): the notice is honest because the limit is reported,
// never as a protection claim.
export function staticLimitChecks(): DoctorCheck[] {
  return [
    {
      id: 'limit:no-isolation',
      label: 'limit no-isolation',
      status: 'warn',
      reason: 'ok',
      detail:
        'honest limit (not enforced): Kubic runs in-process with your user authority (files, network, credentials) — no isolation, no containment; controls are approvals + journal',
    },
    {
      id: 'limit:no-injection-prevention',
      label: 'limit no injection prevention',
      status: 'warn',
      reason: 'ok',
      detail:
        'honest limit (not enforced): no prompt-injection prevention — untrusted output is data, never instruction; approvals + journal are the controls',
    },
    {
      id: 'limit:policy-offer',
      label: 'limit policy offer',
      status: 'warn',
      reason: 'ok',
      detail:
        'honest limit (not enforced): approval policy is an offer for routing, not enforcement — unenforceable values are reported, never honored',
    },
    {
      id: 'limit:journal-not-backup',
      label: 'limit journal not backup',
      status: 'warn',
      reason: 'ok',
      detail:
        'honest limit (not enforced): the change journal is a review/undo log, not a backup — it cannot restore outside state',
    },
    {
      id: 'limit:no-third-party-mcp',
      label: 'limit no third-party MCP',
      status: 'warn',
      reason: 'ok',
      detail:
        'honest limit (not enforced): no third-party tools or MCP servers — requests for them are refused',
    },
  ];
}

// Missing provider: no provider is configured, which is a different
// statement from "a provider was dialled and did not answer" — the line never
// implies a dial that did not happen. Failing here names
// the run exit code, so the message stays honest end to end.
export function providerAvailabilityCheck(
  probes: readonly LimitProviderProbe[],
): DoctorCheck {
  const base = {
    id: 'limit:provider-availability',
    label: 'limit provider availability',
  };
  // `dialled` is the honesty switch (mirrors ProviderProbe): absent
  // means the provider was only LISTED, and the line says so rather than
  // claiming reachability it never measured.
  const dialled = (
    probe: LimitProviderProbe & { dialled?: boolean },
  ): boolean => probe.dialled === true;
  const available = probes.filter((probe) => probe.reachable);
  const proven = available.filter((probe) => dialled(probe));
  if (available.length === 0) {
    const known = probes.map((probe) => probe.id).join(', ');
    return {
      ...base,
      status: 'fail',
      reason: 'provider-down',
      detail:
        known.length > 0
          ? `no provider is available (listed: ${known}) — configure a provider; \`kubic run\` exits 6 on provider failure`
          : 'no providers configured — configure a provider; `kubic run` exits 6 on provider failure',
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail:
      proven.length > 0
        ? `dialled and reachable: ${proven.map((probe) => probe.id).join(', ')}`
        : `listed, not dialled: ${available.map((probe) => probe.id).join(', ')}`,
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
// Invalid shapes are the to fail — this check passes with a pointer
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
      // The refusal names the settled arrival
      // requirements — built from the same constant the config-load
      // refusal throws, so the two can never disagree.
      detail: mcpRefusalMessage(),
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
      detail: `${refused.join(', ')} unsupported: no third-party tools or MCP servers yet`,
    };
  }
  // Same honest count as policy:approvals and `kubic config`: an
  // always-ask capability in autoApprove never applies, so it is not counted.
  const ignored = alwaysAskAutoApprove(autoApprove);
  const effective = autoApprove.filter((cap) => !ignored.includes(cap)).length;
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail: `route=${route}, ${effective} auto-approved — policy offers routing, not enforcement`,
  };
}

// Provider-failure code, mirroring kubic run: a doctor matrix
// with a provider-down failure exits 6. the command keeps its own
// exit contract; this mapper is what the composition root adopts.
export function limitsDoctorExit(checks: readonly DoctorCheck[]): ExitCode {
  if (
    checks.some(
      (check) => check.status === 'fail' && check.reason === 'provider-down',
    )
  ) {
    return EXIT_PROVIDER;
  }
  if (checks.some((check) => check.status === 'fail')) {
    return EXIT_FAILED;
  }
  return EXIT_OK;
}
