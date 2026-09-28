// `kubic doctor` (issue #29; §41.4, §50): health readout over providers,
// deps, and approval-policy mismatches, with a skip flag. Presentation
// only — every probe is injected (faux-only, zero network): the command
// never dials a provider, it reports what the injected probers say.
// Provider shapes mirror worker/models-config.ts read-only; policy
// validation reuses host/approvals.ts. File access, if ever needed,
// goes through the exec FileBridge — this module never imports node:fs.

// License identity (issue #59; §75.1): constants only, no file access —
// this module never imports node:fs, and the static LICENSE/package.json
// correspondence is guarded by scripts/license.test.mjs.
import { formatJson } from '../../core/src/cli/output.js';
import { formatLicenseDetail } from '../../core/src/license.js';
import { CAPABILITIES, validatePolicy } from './approvals.js';
import { type CliIo, diagnosticsOf, themeOf } from './cli-io.js';
// Issue #58 honest limits (§59.1, §78): registration import only — no
// existing check builder in this file was modified for #58. Exit codes
// route through the limits mapper so provider-down exits 6.
import {
  collectLimitChecksFromDeps,
  limitsDoctorExit,
} from './limits/doctor-limits.js';

export const DOCTOR_EXIT_OK = 0;
export const DOCTOR_EXIT_FAIL = 1;
export const DOCTOR_EXIT_USAGE = 2;
// §78 provider-failure code, mirroring kubic run: a doctor matrix with a
// provider-down failure exits 6 (see limitsDoctorExit).
export const DOCTOR_EXIT_PROVIDER = 6;

// warn is informational only (issue #58 static §59.1 notices): it is
// rendered, counted, and never exit-flipping — only fail flips the exit.
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

export type DoctorReason =
  | 'ok'
  | 'provider-down'
  | 'policy-mismatch'
  | 'deps-missing'
  | 'extension-posture'
  | 'full-access'
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
// `dialled` (issue #86) is the honesty switch: absent/false means the
// provider was only LISTED (registered in the catalog, never contacted),
// and the printed line says so. A probe that really contacted the provider
// sets it true, and only then may the line claim a dial.
export interface ProviderProbe {
  id: string;
  reachable: boolean;
  detail?: string;
  models?: string[];
  dialled?: boolean;
}

export interface DepProbe {
  id: string;
  ok: boolean;
  detail?: string;
}

export interface DoctorDeps extends CliIo {
  probeProviders: () => ProviderProbe[];
  checkDeps: () => DepProbe[];
  loadPolicy: () => unknown;
  // The INSTALLED policy (issue #86; §40.3, §41.4) — the same posture object
  // the lane booted with, so the line cannot print a posture the run does
  // not enforce. Absent (legacy callers/tests): no installed-policy check,
  // the existing matrix is unchanged.
  installedPolicy?: () => InstalledPolicyPosture;
  // First-party extension posture (issue #80): structural input so host
  // never imports the extensions package — the composition root maps the
  // real startup probe onto this shape. Absent (tests, unwired callers):
  // no extension check, the legacy matrix is unchanged.
  probeExtensions?: () => ExtensionPostureInput;
  // Role documents (issue #99; §41.4, §40.3): the loaded `.kubic/roles/*.md`
  // set projected onto DoctorChecks — a contradictory role reports
  // fail/policy-mismatch with the resolver's named reason, and a refused
  // run can never print green. Absent: no role checks (legacy matrices are
  // unchanged).
  probeRoles?: () => DoctorCheck[];
  // Repo-level session overlap (issue #118; §42.5): the local session
  // store's view of sessions recorded against one workspace — two or more
  // reports a warn note (concurrent different-session runs are legal; the
  // note states the sweep blind spot). Absent: no overlap check.
  probeSessionOverlap?: () => SessionOverlapProbe;
}

// The installed posture, described once in host/approvals.ts. Host owns the
// derivation (it is the module that also owns the approval service); doctor
// only renders it, which is why this import is type-only plus a structural
// re-declaration here — the value comes in through `installedPolicy`.
export interface InstalledPolicyPosture {
  source: 'config' | 'default';
  route: 'ask-user' | 'deny';
  classes: {
    filesystem: string;
    shell: boolean | string;
    network: string;
    git: boolean | string;
    credentials: string;
  };
  allowlist: string[];
  interceptors: string[];
  sessionScoped: boolean;
  maxPendingMs: number;
  fullAccess: boolean;
}

function installedPolicyCheck(posture: InstalledPolicyPosture): DoctorCheck {
  const base = { id: 'policy:installed', label: 'policy installed' };
  // §40.3: what doctor prints must be what the lane enforces. The posture
  // carries both halves, so a contradiction is detectable from the object
  // itself — an empty allowlist is a real posture (filesystem none), a
  // missing guard list is not.
  if (posture.interceptors.length === 0) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail:
        'installed policy declares no interceptors — nothing would guard a destructive command',
    };
  }
  if (
    posture.route === 'ask-user' &&
    !posture.interceptors.includes('approval')
  ) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail:
        'installed policy routes to ask-user without an approval interceptor — a challenged call could never be decided',
    };
  }
  if (posture.classes.credentials !== 'none' && posture.fullAccess) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail:
        'installed policy combines credential access with full-access posture — contradictory install',
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail:
      `source=${posture.source}, filesystem=${posture.classes.filesystem}, ` +
      `shell=${String(posture.classes.shell)}, network=${posture.classes.network}, ` +
      `git=${String(posture.classes.git)}, credentials=${posture.classes.credentials}; ` +
      `${posture.allowlist.length} allowed tool(s): ${posture.allowlist.join(', ')}; ` +
      `guards: ${posture.interceptors.join(', ')}; route=${posture.route}` +
      `${
        posture.fullAccess
          ? '; FULL ACCESS recorded for this session — every guard stands down for challenged calls'
          : ''
      }`,
  };
}

// Structural posture from the extensions startup probe
// (packages/extensions/src/startup.ts): loaded bundle names plus the
// refused-attempt count, both produced by the same trust checks.
export interface ExtensionPostureInput {
  ok: boolean;
  loaded: string[];
  refusedCount: number;
  detail: string;
}

// Repo-level session overlap input (issue #118; §42.5): the workspace and
// the ids of every session recorded against it in the local session store.
// The store lists sessions — it cannot prove one is RUNNING — so the check
// warns about a possible overlap, never about a verified one.
export interface SessionOverlapProbe {
  workspace: string;
  sessionIds: string[];
}

function sessionOverlapCheck(probe: SessionOverlapProbe): DoctorCheck {
  const base = { id: 'session:overlap', label: 'session overlap' };
  // Warn, never fail (issue #118): concurrent different-session runs in one
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

function providerChecks(probes: ProviderProbe[]): DoctorCheck[] {
  return probes.map((probe) => {
    const count = probe.models?.length ?? 0;
    // Honesty (issue #86; §59.1): a provider that was never dialled must not
    // be reported as reachable. The default line states listed-vs-dialled
    // plainly; a probe that supplies its own detail keeps it (that is where
    // a real dial's outcome, or a real failure, is named).
    const listed = probe.dialled === true ? 'dialled' : 'listed, not dialled';
    if (probe.reachable) {
      return {
        id: `provider:${probe.id}`,
        label: `provider ${probe.id}`,
        status: 'pass' as DoctorStatus,
        reason: 'ok' as DoctorReason,
        detail: probe.detail ?? `${listed}, ${count} model(s) registered`,
      };
    }
    return {
      id: `provider:${probe.id}`,
      label: `provider ${probe.id}`,
      status: 'fail' as DoctorStatus,
      reason: 'provider-down' as DoctorReason,
      detail: probe.detail ?? `${listed} — unreachable`,
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

// First-party extension posture (issue #80): the composition root feeds
// the live startup probe here, so doctor reports the same loaded/refused
// counts the trust checks produce. A degraded posture fails with reason
// extension-posture (exit 1 via limitsDoctorExit); warn never applies —
// a half-loaded bundle is a failure, not a disclosure. Defense in depth:
// the ok path must carry proof both live tripwires fired (≥1 loaded
// bundle, ≥2 refused attempts) — a structural {ok:true} with no refusals
// fails, so a probe that skips its checks cannot report green.
const EXTENSION_TRIPWIRES = 2;
function extensionCheck(posture: ExtensionPostureInput): DoctorCheck {
  const base = {
    id: 'extension:bundle',
    label: 'extension bundle',
  };
  if (
    posture.ok &&
    posture.loaded.length >= 1 &&
    posture.refusedCount >= EXTENSION_TRIPWIRES
  ) {
    return {
      ...base,
      status: 'pass',
      reason: 'ok',
      detail: posture.detail,
    };
  }
  if (posture.ok) {
    return {
      ...base,
      status: 'fail',
      reason: 'extension-posture',
      detail: `extension posture degraded: ok reported with loaded=[${posture.loaded.join(', ')}] refused=${posture.refusedCount} (need >=1 loaded bundle and ${EXTENSION_TRIPWIRES} refused tripwires) — failing closed`,
    };
  }
  return {
    ...base,
    status: 'fail',
    reason: 'extension-posture',
    detail: posture.detail,
  };
}

// License identity (issue #59; §75.1): Kubic is MIT-licensed. The check
// always passes — it surfaces the license at runtime and can never flip
// the doctor exit code. The static correspondence (LICENSE text and the
// package.json license fields matching these constants) is guarded by
// scripts/license.test.mjs instead of by a runtime probe.
function licenseCheck(): DoctorCheck {
  return {
    id: 'license:kubic',
    label: 'license kubic',
    status: 'pass',
    reason: 'ok',
    detail: formatLicenseDetail(),
  };
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
  // Installed policy (issue #86): opt-in via the injected probe — absent
  // means no check, so legacy matrices are unchanged. A throwing probe
  // becomes a failing check, never a crash: an unenforceable install must
  // fail the matrix with policy-mismatch, never pass quietly.
  if (deps.installedPolicy !== undefined) {
    try {
      checks.push(installedPolicyCheck(deps.installedPolicy()));
    } catch (error) {
      checks.push({
        id: 'policy:installed',
        label: 'policy installed',
        status: 'fail',
        reason: 'policy-mismatch',
        detail: probeMessage(error),
      });
    }
  }
  // First-party extension posture (issue #80): opt-in via the injected
  // probe — absent means no check (legacy matrices are unchanged). A
  // throwing probe becomes a failing check, never a crash.
  if (deps.probeExtensions !== undefined) {
    try {
      checks.push(extensionCheck(deps.probeExtensions()));
    } catch (error) {
      checks.push({
        id: 'extension:bundle',
        label: 'extension bundle',
        status: 'fail',
        reason: 'extension-posture',
        detail: probeMessage(error),
      });
    }
  }
  // Role documents (issue #99): opt-in via the injected probe — absent
  // means no role checks. A throwing probe becomes one failing check, and
  // every check the probe returns is passed through verbatim (the probe
  // owns the §40.3 reason text; doctor does not rewrite it).
  if (deps.probeRoles !== undefined) {
    try {
      checks.push(...deps.probeRoles());
    } catch (error) {
      checks.push({
        id: 'role:documents',
        label: 'role documents',
        status: 'fail',
        reason: 'policy-mismatch',
        detail: probeMessage(error),
      });
    }
  }
  // Repo-level session overlap (issue #118): opt-in via the injected probe —
  // absent means no check (legacy matrices are unchanged). A throwing probe
  // reports warn with the named reason, never fail: the note is
  // informational by design (overlap is legal), so a store hiccup must not
  // flip doctor's exit code.
  if (deps.probeSessionOverlap !== undefined) {
    try {
      checks.push(sessionOverlapCheck(deps.probeSessionOverlap()));
    } catch (error) {
      checks.push({
        id: 'session:overlap',
        label: 'session overlap',
        status: 'warn',
        reason: 'ok',
        detail: `overlap unverified (session store not listable): ${probeMessage(error)}`,
      });
    }
  }
  // License identity (issue #59): reported on every run, never skipped
  // implicitly — --skip license:kubic remains available like any check.
  checks.push(licenseCheck());
  // Issue #58 honest limits (§59.1): registration only — the limit
  // checks ride the same --skip and exit path as #29. The builder is
  // total (a throwing probe becomes a failing check). Static §59.1
  // notices report warn (informational, never exit-flipping); only
  // fail (provider-down, deps-missing, policy-mismatch) flips the exit,
  // via limitsDoctorExit below (6 for provider-down, 1 otherwise).
  checks.push(...collectLimitChecksFromDeps(deps));
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
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  const skip = checks.filter((c) => c.status === 'skip').length;
  return `doctor: ${pass} pass, ${warn} warn, ${fail} fail, ${skip} skip`;
}

// The parsed `kubic doctor` invocation (commander owns the argv:
// apps/kubic/src/commands/solo.ts). Each `skip` entry may list several
// comma-separated check ids.
export interface DoctorCommandOptions {
  readonly skip?: readonly string[];
  readonly json?: boolean;
}

export async function runDoctorCommand(
  options: DoctorCommandOptions,
  deps: DoctorDeps,
): Promise<number> {
  const skip = (options.skip ?? [])
    .flatMap((value) => value.split(','))
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const checks = collectDoctorChecks(deps, skip);
  const known = new Set(checks.map((check) => check.id));
  const unknownSkip = skip.find((id) => !known.has(id));
  if (unknownSkip !== undefined) {
    diagnosticsOf(deps).error(`unknown check ${JSON.stringify(unknownSkip)}`);
    return DOCTOR_EXIT_USAGE;
  }
  const exitCode = limitsDoctorExit(checks);
  const failed = exitCode !== DOCTOR_EXIT_OK;
  if (options.json === true) {
    deps.out(formatJson({ ok: !failed, exitCode, checks }));
    return exitCode;
  }
  const theme = themeOf(deps);
  const paint: Record<DoctorStatus, (text: string) => string> = {
    pass: theme.success,
    warn: theme.warning,
    fail: theme.error,
    skip: theme.muted,
  };
  for (const check of checks) {
    deps.out(
      `${paint[check.status](check.status.toUpperCase())} ${theme.bold(check.id)} ${theme.muted(`(${check.reason})`)}: ${check.detail}`,
    );
  }
  const summary = summarize(checks);
  deps.out(failed ? theme.error(summary) : theme.success(summary));
  return exitCode;
}
