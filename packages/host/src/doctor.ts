// `kubic doctor` (issue #29; §41.4, §50): health readout over providers,
// deps, and approval-policy mismatches, with a skip flag. Presentation
// only — every probe is injected (faux-only, zero network): the command
// never dials a provider, it reports what the injected probers say.
// Provider shapes mirror worker/models-config.ts read-only; policy
// validation reuses host/approvals.ts. File access, if ever needed,
// goes through the exec FileBridge — this module never imports node:fs.

import { CAPABILITIES, validatePolicy } from './approvals.js';

export const DOCTOR_EXIT_OK = 0;
export const DOCTOR_EXIT_FAIL = 1;
export const DOCTOR_EXIT_USAGE = 2;

export type DoctorStatus = 'pass' | 'fail' | 'skip';

export type DoctorReason =
  | 'ok'
  | 'provider-down'
  | 'policy-mismatch'
  | 'deps-missing'
  | 'skipped';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  reason: DoctorReason;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  exitCode: number;
  checks: DoctorCheck[];
}

// Provider probe input mirrors CustomProviderSpec (models-config.ts)
// plus reachability — set by an injected faux prober, never by dialing.
export interface ProviderProbe {
  id: string;
  reachable: boolean;
  detail?: string;
  models?: string[];
}

export interface DepProbe {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface DoctorDeps {
  out: (line: string) => void;
  probeProviders: () => ProviderProbe[];
  checkDeps: () => DepProbe[];
  loadPolicy: () => unknown;
}

function providerChecks(probes: ProviderProbe[]): DoctorCheck[] {
  return probes.map((probe) => {
    if (probe.reachable) {
      const count = probe.models?.length ?? 0;
      return {
        id: `provider:${probe.id}`,
        label: `provider ${probe.id}`,
        status: 'pass' as DoctorStatus,
        reason: 'ok' as DoctorReason,
        detail: probe.detail ?? `reachable, ${count} model(s) registered`,
      };
    }
    return {
      id: `provider:${probe.id}`,
      label: `provider ${probe.id}`,
      status: 'fail' as DoctorStatus,
      reason: 'provider-down' as DoctorReason,
      detail: probe.detail ?? 'unreachable',
    };
  });
}

function depChecks(probes: DepProbe[]): DoctorCheck[] {
  return probes.map((probe) => ({
    id: `dep:${probe.id}`,
    label: `dep ${probe.id}`,
    status: (probe.ok ? 'pass' : 'fail') as DoctorStatus,
    reason: (probe.ok ? 'ok' : 'deps-missing') as DoctorReason,
    detail: probe.detail ?? (probe.ok ? 'present' : 'missing'),
  }));
}

// Policy mismatches (§41): unknown autoApprove capabilities (anything
// outside CAPABILITIES and the dynamic `requires:<tool>` triggers),
// autoApprove entries that can never apply under route=deny, and any
// policy that fails host validation outright.
function policyCheck(raw: unknown): DoctorCheck {
  const base = {
    id: 'policy:approvals',
    label: 'policy approvals',
  };
  let policy: { route: string; autoApprove: string[] };
  try {
    const validated = validatePolicy(raw);
    policy = { route: validated.route, autoApprove: validated.autoApprove };
  } catch (error) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const unknown = policy.autoApprove.filter(
    (cap) =>
      !(CAPABILITIES as readonly string[]).includes(cap) &&
      !cap.startsWith('requires:'),
  );
  if (unknown.length > 0) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: `unknown autoApprove capabilities: ${unknown.join(', ')}`,
    };
  }
  if (policy.route === 'deny' && policy.autoApprove.length > 0) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: 'route=deny ignores autoApprove — entries can never apply',
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail: `route=${policy.route}, ${policy.autoApprove.length} auto-approved`,
  };
}

function probeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function collectDoctorChecks(
  deps: DoctorDeps,
  skip: string[],
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  try {
    checks.push(...providerChecks(deps.probeProviders()));
  } catch (error) {
    checks.push({
      id: 'provider:probe',
      label: 'provider probe',
      status: 'fail',
      reason: 'provider-down',
      detail: probeMessage(error),
    });
  }
  try {
    checks.push(...depChecks(deps.checkDeps()));
  } catch (error) {
    checks.push({
      id: 'dep:check',
      label: 'dep check',
      status: 'fail',
      reason: 'deps-missing',
      detail: probeMessage(error),
    });
  }
  try {
    checks.push(policyCheck(deps.loadPolicy()));
  } catch (error) {
    checks.push({
      id: 'policy:approvals',
      label: 'policy approvals',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: probeMessage(error),
    });
  }
  return checks.map((check) =>
    skip.includes(check.id)
      ? {
          ...check,
          status: 'skip' as DoctorStatus,
          reason: 'skipped' as DoctorReason,
          detail: `skipped via --skip ${check.id}`,
        }
      : check,
  );
}

function summarize(checks: DoctorCheck[]): string {
  const pass = checks.filter((c) => c.status === 'pass').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  const skip = checks.filter((c) => c.status === 'skip').length;
  return `doctor: ${pass} pass, ${fail} fail, ${skip} skip`;
}

export async function runDoctorCommand(
  args: string[],
  deps: DoctorDeps,
): Promise<number> {
  const skip: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--skip') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --skip needs a value');
        return DOCTOR_EXIT_USAGE;
      }
      skip.push(...value.split(',').map((part) => part.trim()));
      i += 1;
    } else if (arg === '--json') {
      json = true;
    } else {
      deps.out(`error: unknown flag ${arg}`);
      return DOCTOR_EXIT_USAGE;
    }
  }
  const checks = collectDoctorChecks(deps, skip);
  const known = new Set(checks.map((check) => check.id));
  const unknownSkip = skip.find((id) => !known.has(id));
  if (unknownSkip !== undefined) {
    deps.out(`error: unknown check ${JSON.stringify(unknownSkip)}`);
    return DOCTOR_EXIT_USAGE;
  }
  const failed = checks.some((check) => check.status === 'fail');
  const exitCode = failed ? DOCTOR_EXIT_FAIL : DOCTOR_EXIT_OK;
  if (json) {
    deps.out(JSON.stringify({ ok: !failed, exitCode, checks }, null, 2));
    return exitCode;
  }
  for (const check of checks) {
    deps.out(
      `${check.status.toUpperCase()} ${check.id} (${check.reason}): ${check.detail}`,
    );
  }
  deps.out(summarize(checks));
  return exitCode;
}
