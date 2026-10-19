// Collecting every check a doctor run reports, in report order.
import {
  depChecks,
  licenseCheck,
  platformCheck,
} from './checks/environment.js';
import {
  modelWindowChecks,
  probeMessage,
  providerChecks,
  roomChecks,
} from './checks/models.js';
import type { ConfiguredApprovals } from './checks/policy.js';
import {
  configuredApprovals,
  detectionOnlyCheck,
  installedPolicyCheck,
  policyCheck,
} from './checks/policy.js';
import {
  fullAccessSessionCheck,
  sessionOverlapCheck,
  statePermissionCheck,
} from './checks/sessions.js';
import {
  depsLimitCheck,
  policyEnforceabilityCheck,
  providerAvailabilityCheck,
  staticLimitChecks,
} from './doctor-limits.js';
import type {
  DepProbe,
  DoctorCheck,
  DoctorDeps,
  DoctorReason,
  DoctorStatus,
  ProviderProbe,
} from './types.js';

export function collectDoctorChecks(
  deps: DoctorDeps,
  skip: string[],
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  // Each probe runs ONCE here and the results are captured —
  // the limit aggregates at the end reuse these results and never re-call
  // the probes (a second call would double-bill expensive probes and let
  // a flaky probe answer differently twice).
  checks.push(...modelWindowChecks(deps.probeModelWindows?.() ?? []));
  if (deps.probeContextRoom !== undefined) {
    checks.push(...roomChecks(deps.probeContextRoom()));
  }
  const probed = captureCoreProbes(deps, checks);
  checks.push(...policyProbeChecks(deps, probed.configured));
  checks.push(...sessionProbeChecks(deps));
  checks.push(platformCheck(deps.platform ?? process.platform));
  // License identity: reported on every run, never skipped
  // implicitly — --skip license:kubic remains available like any check.
  checks.push(licenseCheck());
  // Honest limits plus: the limit aggregates
  // derive from the probes captured above — never a second probe call —
  // and from the POST-skip items, so skipping a failing item clears the
  // aggregate it would otherwise fail. A direct --skip of a limit id is
  // still honoured by the final pass below.
  checks.push(...limitChecksFromResults(probed, new Set(skip)));
  return applySkip(checks, skip);
}

// The provider, dep and policy probes, run once: their checks are appended
// to `checks`, and their results are kept for the limit aggregates.
interface CoreProbes {
  providerProbes: ProviderProbe[] | undefined;
  providerError: unknown;
  depProbes: DepProbe[] | undefined;
  depError: unknown;
  rawPolicy: unknown;
  policyLoaded: boolean;
  policyError: unknown;
  configured: ConfiguredApprovals | undefined;
}

function captureCoreProbes(deps: DoctorDeps, checks: DoctorCheck[]) {
  const probed: CoreProbes = {
    providerProbes: undefined,
    providerError: undefined,
    depProbes: undefined,
    depError: undefined,
    rawPolicy: undefined,
    policyLoaded: false,
    policyError: undefined,
    configured: undefined,
  };
  try {
    probed.providerProbes = deps.probeProviders();
    checks.push(...providerChecks(probed.providerProbes));
  } catch (error) {
    probed.providerError = error;
    checks.push(
      failedProbe('provider:probe', 'provider probe', 'provider-down', error),
    );
  }
  try {
    probed.depProbes = deps.checkDeps();
    checks.push(...depChecks(probed.depProbes));
  } catch (error) {
    probed.depError = error;
    checks.push(failedProbe('dep:check', 'dep check', 'deps-missing', error));
  }
  try {
    probed.rawPolicy = deps.loadPolicy();
    probed.policyLoaded = true;
    probed.configured = configuredApprovals(probed.rawPolicy);
    checks.push(policyCheck(probed.rawPolicy));
  } catch (error) {
    probed.policyError = error;
    checks.push(
      failedProbe(
        'policy:approvals',
        'policy approvals',
        'policy-mismatch',
        error,
      ),
    );
  }
  return probed;
}

// The opt-in policy probes. Each is absent unless injected, so matrices
// without it are unchanged, and a throwing probe becomes one named failing
// check, never a crash.
function policyProbeChecks(
  deps: DoctorDeps,
  configured: ConfiguredApprovals | undefined,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  // Installed policy: an unenforceable install must fail the matrix with
  // policy-mismatch, never pass quietly.
  if (deps.installedPolicy !== undefined) {
    try {
      const posture = deps.installedPolicy();
      checks.push(installedPolicyCheck(posture, configured));
      // The same posture names its lexical classes, so the
      // installed line is never read as enforcement.
      const detection = detectionOnlyCheck(posture);
      if (detection !== undefined) checks.push(detection);
    } catch (error) {
      checks.push(
        failedProbe(
          'policy:installed',
          'policy installed',
          'policy-mismatch',
          error,
        ),
      );
    }
  }
  // Role documents: every check the probe returns is passed through
  // verbatim (the probe owns the reason text; doctor does not rewrite it).
  if (deps.probeRoles !== undefined) {
    checks.push(
      ...probeOr(deps.probeRoles, (error) =>
        failedProbe(
          'role:documents',
          'role documents',
          'policy-mismatch',
          error,
        ),
      ),
    );
  }
  // Skills gate: the same fail-closed probe contract.
  if (deps.probeSkills !== undefined) {
    checks.push(
      ...probeOr(deps.probeSkills, (error) =>
        failedProbe(
          'skill:documents',
          'skill documents',
          'policy-mismatch',
          error,
        ),
      ),
    );
  }
  // Enterprise policy: the composition root builds it from the SAME
  // effective `[policy]` resolution `kubic policy` reports
  // (enterpriseDoctorChecks), and only when a `[policy]` section is actually
  // configured.
  if (deps.enterpriseChecks !== undefined) {
    checks.push(
      ...probeOr(deps.enterpriseChecks, (error) =>
        failedProbe(
          'policy:enterprise',
          'policy enterprise',
          'policy-mismatch',
          error,
        ),
      ),
    );
  }
  // Configured audit sinks.
  if (deps.probeAuditSinks !== undefined) {
    checks.push(
      ...probeOr(deps.probeAuditSinks, (error) =>
        failedProbe('audit:sinks', 'audit sinks', 'sink-unreachable', error),
      ),
    );
  }
  return checks;
}

// The session probes. These report warn, never fail, when a probe throws:
// the notes are informational by design (overlap is legal), so a store
// hiccup must not flip doctor's exit code.
function sessionProbeChecks(deps: DoctorDeps): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  // State permissions: always present — a clean posture is a pass, so the
  // matrix shape stays stable and a loose directory is named rather than
  // silent.
  checks.push(
    ...probeOr(
      () => [
        statePermissionCheck(
          deps.probeStatePermissions === undefined
            ? undefined
            : deps.probeStatePermissions(),
        ),
      ],
      (error) =>
        unverifiedProbe(
          'state:permissions',
          'state permissions',
          `state permissions unverified: ${probeMessage(error)}`,
        ),
    ),
  );
  // Repo-level session overlap: opt-in via the injected probe.
  if (deps.probeSessionOverlap !== undefined) {
    const probeSessionOverlap = deps.probeSessionOverlap;
    checks.push(
      ...probeOr(
        () => [sessionOverlapCheck(probeSessionOverlap())],
        (error) =>
          unverifiedProbe(
            'session:overlap',
            'session overlap',
            `overlap unverified (session store not listable): ${probeMessage(error)}`,
          ),
      ),
    );
  }
  // Full-access sessions: one warning per live session
  // running with approvals off (see fullAccessSessionCheck).
  if (deps.probeFullAccessSessions !== undefined) {
    try {
      for (const session of deps.probeFullAccessSessions()) {
        checks.push(fullAccessSessionCheck(session));
      }
    } catch (error) {
      checks.push(
        unverifiedProbe(
          'session:full-access',
          'session full access',
          `full-access sessions unverified (session store not listable): ${probeMessage(error)}`,
        ),
      );
    }
  }
  return checks;
}

// A probe's checks, or the one check its failure becomes.
function probeOr(
  run: () => DoctorCheck[],
  onError: (error: unknown) => DoctorCheck,
): DoctorCheck[] {
  try {
    return run();
  } catch (error) {
    return [onError(error)];
  }
}

function failedProbe(
  id: string,
  label: string,
  reason: DoctorReason,
  error: unknown,
): DoctorCheck {
  return { id, label, status: 'fail', reason, detail: probeMessage(error) };
}

function unverifiedProbe(id: string, label: string, detail: string) {
  const check: DoctorCheck = {
    id,
    label,
    status: 'warn',
    reason: 'ok',
    detail,
  };
  return check;
}

// Limit aggregates from captured probe results. Probes whose
// per-item check was skipped are excluded, so a skipped refusal does not
// fail the aggregate; when skipping empties a section entirely the
// aggregate reports skip (it has nothing to assess), never a failure.
function limitChecksFromResults(
  probed: {
    providerProbes: ProviderProbe[] | undefined;
    providerError: unknown;
    depProbes: DepProbe[] | undefined;
    depError: unknown;
    rawPolicy: unknown;
    policyLoaded: boolean;
    policyError: unknown;
  },
  skipped: Set<string>,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [...staticLimitChecks()];
  if (probed.providerProbes === undefined) {
    checks.push({
      id: 'limit:provider-availability',
      label: 'limit provider availability',
      status: 'fail',
      reason: 'provider-down',
      detail: probeMessage(probed.providerError),
    });
  } else {
    const live = probed.providerProbes.filter(
      (probe) => !skipped.has(`provider:${probe.id}`),
    );
    checks.push(
      aggregateOrSkipped(
        providerAvailabilityCheck(live),
        probed.providerProbes.length,
        live.length,
      ),
    );
  }
  if (probed.depProbes === undefined) {
    checks.push({
      id: 'limit:deps-present',
      label: 'limit deps present',
      status: 'fail',
      reason: 'deps-missing',
      detail: probeMessage(probed.depError),
    });
  } else {
    const live = probed.depProbes.filter(
      (probe) => !skipped.has(`dep:${probe.id}`),
    );
    checks.push(
      aggregateOrSkipped(
        depsLimitCheck(live),
        probed.depProbes.length,
        live.length,
      ),
    );
  }
  if (!probed.policyLoaded) {
    checks.push({
      id: 'policy:enforceability',
      label: 'policy enforceability',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: probeMessage(probed.policyError),
    });
  } else {
    // A skipped policy:approvals changes nothing here: the check reads the
    // raw policy and already passes with a pointer when it is invalid.
    checks.push(policyEnforceabilityCheck(probed.rawPolicy));
  }
  return checks;
}

// When --skip emptied a section entirely, the aggregate has nothing to
// assess: it reports skip, never a failure (or a vacuous pass).
function aggregateOrSkipped(
  built: DoctorCheck,
  total: number,
  live: number,
): DoctorCheck {
  if (live === 0 && total > 0) {
    return {
      ...built,
      status: 'skip' as DoctorStatus,
      reason: 'skipped' as DoctorReason,
      detail: `skipped via --skip (all inputs skipped)`,
    };
  }
  return built;
}

function applySkip(checks: DoctorCheck[], skip: string[]): DoctorCheck[] {
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
