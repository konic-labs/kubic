// `kubic doctor`: health readout over providers,
// deps, and approval-policy mismatches, with a skip flag. Presentation
// only — every probe is injected (faux-only, zero network): the command
// never dials a provider, it reports what the injected probers say.
// Provider shapes mirror packages/agent/src/models-config.ts read-only; policy
// validation reuses approvals/policy.ts. File access, if ever needed,
// goes through the exec FileBridge — this module never imports node:fs.

import {
  DEFAULT_RESERVE_TOKENS,
  KEEP_RECENT_TOKENS,
  roomAfterCompaction,
} from '@kubic/agent/compaction';
import {
  describeUnsupported,
  effectiveCredentialLevel,
  effectiveNetworkLevel,
} from '@kubic/agent/permissions';
// License identity: constants only, no file access —
// this module never imports node:fs, and the static LICENSE/package.json
// correspondence is guarded by scripts/license.test.mjs.
import {
  type CommandResult,
  EXIT_OK,
  EXIT_USAGE,
} from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import { formatLicenseDetail } from '@kubic/core/license';
import {
  alwaysAskAutoApprove,
  CAPABILITIES,
  validatePolicy,
} from '../approvals/index.js';
import { type CliIo, diagnosticsOf, themeOf } from '../cli/index.js';
import type { FullAccessSession } from './doctor-full-access.js';
// Honest limits: registration import only — no
// existing check builder in this file was modified. Exit codes
// route through the limits mapper so provider-down exits 6.
import {
  depsLimitCheck,
  limitsDoctorExit,
  policyEnforceabilityCheck,
  providerAvailabilityCheck,
  staticLimitChecks,
} from './doctor-limits.js';
import { renderDoctorGrouped } from './doctor-render.js';

// warn is informational only: it is
// rendered, counted, and never exit-flipping — only fail flips the exit.
type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

type DoctorReason =
  | 'ok'
  | 'provider-down'
  | 'policy-mismatch'
  | 'deps-missing'
  | 'full-access'
  | 'unsupported-level'
  | 'detection-only'
  | 'sink-unreachable'
  | 'window-default'
  | 'room-short'
  | 'skipped';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  reason: DoctorReason;
  detail: string;
}

// Provider probe input mirrors CustomProviderSpec (models-config.ts)
// plus reachability — set by an injected faux prober, never by dialing.
// `dialled` is the honesty switch: absent/false means the
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

// A models.json model that runs on the fallback context window.
interface ModelWindowProbe {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
}

// A model the room check measures: its registry window.
interface RoomModel {
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
}

// The room check's inputs: the configured compaction keys (absent: the lane
// defaults), the models the user defined in models.json (their window is theirs
// to set), and the default model the configuration selects. A built-in model is
// never measured: models.json cannot resize it. Read-only, nothing is dialled.
export interface ContextRoomProbe {
  readonly reserveTokens?: number;
  readonly keepRecentTokens?: number;
  readonly customModels: readonly RoomModel[];
  readonly defaultModel?: RoomModel;
}

export interface DoctorDeps extends CliIo {
  // The terminal width the grouped summary packs into.
  readonly columns?: number;
  probeProviders: () => ProviderProbe[];
  // Models on the fallback context window: one warn each. Absent: no check.
  probeModelWindows?: () => readonly ModelWindowProbe[];
  // The room a compaction leaves for each model: one warn when a model has
  // less than the floor. Absent: no check.
  probeContextRoom?: () => ContextRoomProbe;
  checkDeps: () => DepProbe[];
  loadPolicy: () => unknown;
  // The INSTALLED policy — the same posture object
  // the lane booted with, so the line cannot print a posture the run does
  // not enforce. Absent (legacy callers/tests): no installed-policy check,
  // the existing matrix is unchanged.
  installedPolicy?: () => InstalledPolicyPosture;
  // Role documents: the loaded `.kubic/roles/*.md`
  // set projected onto DoctorChecks — a contradictory role reports
  // fail/policy-mismatch with the resolver's named reason, and a refused
  // run can never print green. Absent: no role checks (matrices without it are
  // unchanged).
  probeRoles?: () => DoctorCheck[];
  // The skills gate probe — absent means no skills
  // checks. Same contract as probeRoles: a throwing probe becomes one
  // failing check, returned checks pass through verbatim.
  probeSkills?: () => DoctorCheck[];
  // Enterprise policy: the checks `enterpriseDoctorChecks`
  // derives from the resolved `[policy]` section, built by the composition
  // root (host never imports the app). Absent — including when no `[policy]`
  // is configured at all — means no enterprise checks and an unchanged
  // default matrix. A throwing probe becomes one named failing check.
  enterpriseChecks?: () => DoctorCheck[];
  // Configured audit sinks: the checks
  // `auditSinksDoctorChecks` derives from the loaded `[[audit]]` tables,
  // built by the composition root with real reachability probes. Absent
  // means no sink checks and an unchanged default matrix. A throwing
  // probe becomes one named failing check, never a crash.
  probeAuditSinks?: () => DoctorCheck[];
  // Repo-level session overlap: the local session
  // store's view of sessions recorded against one workspace — two or more
  // reports a warn note (concurrent different-session runs are legal; the
  // note states the sweep blind spot). Absent: no overlap check.
  probeSessionOverlap?: () => SessionOverlapProbe;
  // Full-access sessions: the composition root's
  // enumeration of the workspace's live sessions whose posture.json
  // records fullAccess (host/doctor-full-access). Absent: no per-session
  // checks (matrices without it are unchanged). A throwing probe becomes one
  // warn check, never a crash: an unlistable store must not flip the exit.
  probeFullAccessSessions?: () => FullAccessSession[];
  // A state directory that other local users can read (session
  // transcripts, journaled file content). undefined means private or absent.
  probeStatePermissions?: () => StatePermissionProbe | undefined;
}

// The installed posture, described once in approvals/installed-policy.ts. Host owns the
// derivation (it is the module that also owns the approval service); doctor
// only renders it, which is why this import is type-only plus a structural
// re-declaration here — the value comes in through `installedPolicy`.
interface InstalledPolicyPosture {
  source: 'config' | 'default';
  route: 'ask-user' | 'deny';
  classes: {
    filesystem: 'none' | 'read' | 'workspace-write' | 'full';
    shell: false | 'read-only-allowlist' | true;
    network: 'none' | 'allowlist' | 'full';
    git: false | 'workspace' | 'full';
    credentials: 'none' | 'allowlist';
  };
  allowlist: string[];
  interceptors: string[];
  sessionScoped: boolean;
  maxPendingMs: number;
  autoApprove?: string[];
  requireJustification?: boolean;
  fullAccess: boolean;
  // Declared levels the tool set cannot express.
  unsupported?: readonly {
    class: string;
    level: string;
    enforcedAs: string;
    reason: string;
  }[];
}

// The config-sourced approval policy as policy:approvals validated it — the
// half the installed posture must agree with.
interface ConfiguredApprovals {
  route: string;
  maxPendingMs: number;
}

function configuredApprovals(raw: unknown): ConfiguredApprovals | undefined {
  try {
    const policy = validatePolicy(raw);
    return { route: policy.route, maxPendingMs: policy.maxPendingMs };
  } catch {
    return undefined;
  }
}

function installedPolicyCheck(
  posture: InstalledPolicyPosture,
  configured?: ConfiguredApprovals,
): DoctorCheck {
  const base = { id: 'policy:installed', label: 'policy installed' };
  // The route and bound the lane installs must be the
  // ones config declares — two contradictory green lines are the false
  // confidence doctor exists to prevent.
  if (
    configured !== undefined &&
    (configured.route !== posture.route ||
      configured.maxPendingMs !== posture.maxPendingMs)
  ) {
    return {
      ...base,
      status: 'fail',
      reason: 'policy-mismatch',
      detail: `installed approval policy (route=${posture.route}, maxPendingMs=${posture.maxPendingMs}) differs from config (route=${configured.route}, maxPendingMs=${configured.maxPendingMs})`,
    };
  }
  // What doctor prints must be what the lane enforces. The posture
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
  const unsupported = posture.unsupported ?? [];
  // A level the lane cannot express is never printed green —
  // the check warns and names each one with the level actually enforced.
  const unsupportedTail =
    unsupported.length === 0
      ? ''
      : `; unsupported: ${unsupported.map(describeUnsupported).join('; ')}`;
  return {
    ...base,
    status: unsupported.length === 0 ? 'pass' : 'warn',
    reason: unsupported.length === 0 ? 'ok' : 'unsupported-level',
    detail:
      `source=${posture.source}, filesystem=${posture.classes.filesystem}, ` +
      `shell=${String(posture.classes.shell)}, network=${posture.classes.network}, ` +
      `git=${String(posture.classes.git)}, credentials=${posture.classes.credentials}; ` +
      `${posture.allowlist.length} allowed tool(s): ${posture.allowlist.join(', ')}; ` +
      `guards: ${posture.interceptors.join(', ')}; route=${posture.route}, ` +
      `maxPendingMs=${posture.maxPendingMs}, ` +
      `autoApprove=${(posture.autoApprove ?? []).join(',') || 'none'}` +
      `${posture.requireJustification === true ? ', requireJustification' : ''}` +
      `${
        posture.fullAccess
          ? '; FULL ACCESS recorded for this session — every guard stands down for challenged calls'
          : ''
      }${unsupportedTail}`,
  };
}

// An installed class whose restriction is LEXICAL
// DETECTION, not enforcement. `policy:installed` prints the classes as facts;
// this check names the ones a run cannot actually hold, so the line is never
// read as a sandbox. Warn only — it discloses a limit, it does not flip the
// exit (the same contract as the static notices). Omitted entirely when
// every installed class is structurally enforced (or unrestricted), so a
// matrix that has nothing to disclose gains no line.
function detectionOnlyCheck(
  posture: InstalledPolicyPosture,
): DoctorCheck | undefined {
  const lexical: string[] = [];
  if (effectiveNetworkLevel(posture.classes.network) === 'none') {
    lexical.push(
      'network=none is a lexical bash command detector — a script the agent writes and runs can reach the network',
    );
  }
  if (posture.classes.filesystem !== 'none') {
    lexical.push(
      `filesystem=${posture.classes.filesystem} is lexical path confinement — symlinks are not resolved and the shell can still read anything the command does not name`,
    );
  }
  if (effectiveCredentialLevel(posture.classes.credentials) === 'none') {
    lexical.push(
      'credentials=none is a lexical credential-path detector — only the listed paths are challenged',
    );
  }
  if (lexical.length === 0) return undefined;
  return {
    id: 'policy:detection-only',
    label: 'policy detection only',
    status: 'warn',
    reason: 'detection-only',
    detail: `detection only (not enforcement): ${lexical.join('; ')}`,
  };
}

// Repo-level session overlap input: the workspace and
// the ids of every session recorded against it in the local session store.
// The store lists sessions — it cannot prove one is RUNNING — so the check
// warns about a possible overlap, never about a verified one.
export interface SessionOverlapProbe {
  workspace: string;
  sessionIds: string[];
}

function fullAccessSessionCheck(session: FullAccessSession): DoctorCheck {
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

function sessionOverlapCheck(probe: SessionOverlapProbe): DoctorCheck {
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

// A group- or world-accessible state directory. The probe
// reports it (and the next open tightens it); doctor warns, never fails —
// a loose directory is a real exposure but not a broken installation.
interface StatePermissionProbe {
  path: string;
  mode: number;
}

function statePermissionCheck(
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

function providerChecks(probes: ProviderProbe[]): DoctorCheck[] {
  return probes.map((probe) => {
    const count = probe.models?.length ?? 0;
    // Honesty: a provider that was never dialled must not
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

// A model on the fallback window is a warning, never a failure: it runs, but
// the gauge and the compaction threshold use a window the model may not have.
// The detail names the key that declares the real one.
function modelWindowChecks(probes: readonly ModelWindowProbe[]): DoctorCheck[] {
  return probes.map((probe) => ({
    id: `models-window:${probe.provider}/${probe.model}`,
    label: `model ${probe.provider}/${probe.model} window`,
    status: 'warn' as DoctorStatus,
    reason: 'window-default' as DoctorReason,
    detail: `window ${probe.contextWindow} is the default: set "contextWindow" for ${probe.model} in models.json (the gauge and compaction use it)`,
  }));
}

// The room a compaction leaves below this many estimated tokens means the next
// exchange compacts again: compaction then runs every turn or two.
const MIN_ROOM_AFTER_COMPACTION = 4096;

// One warn-only check for the models the user can configure: the models in
// models.json and the default model the configuration selects. A built-in model
// is never named. A healthy set is one pass line; nothing in scope, no check.
function roomChecks(probe: ContextRoomProbe): DoctorCheck[] {
  const customKeys = new Set(probe.customModels.map(modelKey));
  const defaultIsCustom =
    probe.defaultModel !== undefined &&
    customKeys.has(modelKey(probe.defaultModel));
  const scope = [
    ...probe.customModels.map((model) => ({ model, custom: true })),
    ...(probe.defaultModel === undefined || defaultIsCustom
      ? []
      : [{ model: probe.defaultModel, custom: false }]),
  ];
  if (scope.length === 0) return [];
  const label = 'context room after a compaction';
  const rooms = scope.map(({ model, custom }) => ({
    name: modelKey(model),
    window: model.contextWindow,
    room: roomAfterCompaction(
      model.contextWindow,
      probe.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
      probe.keepRecentTokens ?? KEEP_RECENT_TOKENS,
    ),
    custom,
  }));
  const short = rooms.filter((room) => room.room < MIN_ROOM_AFTER_COMPACTION);
  if (short.length === 0) {
    return [
      {
        id: 'context-room',
        label,
        status: 'pass' as DoctorStatus,
        reason: 'ok' as DoctorReason,
        detail: `every model you can configure keeps at least ${MIN_ROOM_AFTER_COMPACTION} estimated tokens of room after a compaction`,
      },
    ];
  }
  const names = short
    .map(
      (room) =>
        `${room.name} (window ${room.window}, about ${room.room} tokens of room)`,
    )
    .join('; ');
  const fixes: string[] = [];
  const custom = short.filter((room) => room.custom).map((room) => room.name);
  if (custom.length > 0) {
    fixes.push(
      `set "contextWindow" in models.json for ${custom.join(', ')} to the model's real window`,
    );
  }
  const chosen = short.filter((room) => !room.custom).map((room) => room.name);
  if (chosen.length > 0) {
    fixes.push(
      `for the default model ${chosen.join(', ')}, choose one with a larger window (kubic setup, or [model] in configuration), or offer it fewer tools (\`[policy] denied_tools\`)`,
    );
  }
  return [
    {
      id: 'context-room',
      label,
      status: 'warn' as DoctorStatus,
      reason: 'room-short' as DoctorReason,
      detail: `${names}: below ${MIN_ROOM_AFTER_COMPACTION} tokens, so compaction will run every turn or two. Fix: ${fixes.join('; ')}.`,
    },
  ];
}

function modelKey(model: RoomModel): string {
  return `${model.provider}/${model.model}`;
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

// Policy mismatches: unknown autoApprove capabilities (anything
// outside CAPABILITIES and the dynamic `requires:<tool>` triggers),
// autoApprove entries that can never apply under route=deny, and any
// policy that fails host validation outright. An always-ask capability
// (kubic-state-write) in autoApprove is a named warning, not a failure: the
// config contract keeps accepting it and the lane ignores it.
function policyCheck(raw: unknown): DoctorCheck {
  const base = {
    id: 'policy:approvals',
    label: 'policy approvals',
  };
  let policy: { route: string; autoApprove: string[]; maxPendingMs: number };
  try {
    const validated = validatePolicy(raw);
    policy = {
      route: validated.route,
      autoApprove: validated.autoApprove,
      maxPendingMs: validated.maxPendingMs,
    };
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
  // An always-ask capability in autoApprove can never apply:
  // named as a warning (informational, exit-neutral) and left out of the
  // count, so the line never claims an approval the lane will not grant.
  const ignored = [...new Set(alwaysAskAutoApprove(policy.autoApprove))];
  const effective = policy.autoApprove.filter(
    (cap) => !ignored.includes(cap),
  ).length;
  const summary = `route=${policy.route}, ${effective} auto-approved, maxPendingMs=${policy.maxPendingMs}`;
  if (ignored.length > 0) {
    return {
      ...base,
      status: 'warn',
      reason: 'policy-mismatch',
      detail: `${ignored.join(', ')} always asks — an autoApprove entry never answers it and is ignored; ${summary}`,
    };
  }
  return {
    ...base,
    status: 'pass',
    reason: 'ok',
    detail: summary,
  };
}

function probeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// License identity: Kubic is MIT-licensed. The check
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
  // Each probe runs ONCE here and the results are captured —
  // the limit aggregates at the end reuse these results and never re-call
  // the probes (a second call would double-bill expensive probes and let
  // a flaky probe answer differently twice).
  checks.push(...modelWindowChecks(deps.probeModelWindows?.() ?? []));
  if (deps.probeContextRoom !== undefined) {
    checks.push(...roomChecks(deps.probeContextRoom()));
  }
  let providerProbes: ProviderProbe[] | undefined;
  let providerError: unknown;
  try {
    providerProbes = deps.probeProviders();
    checks.push(...providerChecks(providerProbes));
  } catch (error) {
    providerError = error;
    checks.push({
      id: 'provider:probe',
      label: 'provider probe',
      status: 'fail',
      reason: 'provider-down',
      detail: probeMessage(error),
    });
  }
  let depProbes: DepProbe[] | undefined;
  let depError: unknown;
  try {
    depProbes = deps.checkDeps();
    checks.push(...depChecks(depProbes));
  } catch (error) {
    depError = error;
    checks.push({
      id: 'dep:check',
      label: 'dep check',
      status: 'fail',
      reason: 'deps-missing',
      detail: probeMessage(error),
    });
  }
  let configured: ConfiguredApprovals | undefined;
  let rawPolicy: unknown;
  let policyLoaded = false;
  let policyError: unknown;
  try {
    rawPolicy = deps.loadPolicy();
    policyLoaded = true;
    configured = configuredApprovals(rawPolicy);
    checks.push(policyCheck(rawPolicy));
  } catch (error) {
    policyError = error;
    checks.push({
      id: 'policy:approvals',
      label: 'policy approvals',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: probeMessage(error),
    });
  }
  // Installed policy: opt-in via the injected probe — absent
  // means no check, so matrices without it are unchanged. A throwing probe
  // becomes a failing check, never a crash: an unenforceable install must
  // fail the matrix with policy-mismatch, never pass quietly.
  if (deps.installedPolicy !== undefined) {
    try {
      const posture = deps.installedPolicy();
      checks.push(installedPolicyCheck(posture, configured));
      // The same posture names its lexical classes, so the
      // installed line is never read as enforcement.
      const detection = detectionOnlyCheck(posture);
      if (detection !== undefined) checks.push(detection);
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
  // Role documents: opt-in via the injected probe — absent
  // means no role checks. A throwing probe becomes one failing check, and
  // every check the probe returns is passed through verbatim (the probe
  // owns the reason text; doctor does not rewrite it).
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
  // Skills gate: opt-in via the injected probe —
  // absent means no skills checks, same fail-closed probe contract.
  if (deps.probeSkills !== undefined) {
    try {
      checks.push(...deps.probeSkills());
    } catch (error) {
      checks.push({
        id: 'skill:documents',
        label: 'skill documents',
        status: 'fail',
        reason: 'policy-mismatch',
        detail: probeMessage(error),
      });
    }
  }
  // Enterprise policy: opt-in via the injected probe — the
  // composition root builds it from the SAME effective `[policy]` resolution
  // `kubic policy` reports (enterpriseDoctorChecks), and only when a
  // `[policy]` section is actually configured. Absent means no enterprise
  // checks, so the default matrix is unchanged. A throwing probe becomes one
  // named failing check, never a crash.
  if (deps.enterpriseChecks !== undefined) {
    try {
      checks.push(...deps.enterpriseChecks());
    } catch (error) {
      checks.push({
        id: 'policy:enterprise',
        label: 'policy enterprise',
        status: 'fail',
        reason: 'policy-mismatch',
        detail: probeMessage(error),
      });
    }
  }
  // Configured audit sinks: opt-in via the injected
  // probe — absent means no sink checks, so matrices without it are unchanged.
  // A throwing probe becomes one named failing check, never a crash.
  if (deps.probeAuditSinks !== undefined) {
    try {
      checks.push(...deps.probeAuditSinks());
    } catch (error) {
      checks.push({
        id: 'audit:sinks',
        label: 'audit sinks',
        status: 'fail',
        reason: 'sink-unreachable',
        detail: probeMessage(error),
      });
    }
  }
  // Repo-level session overlap: opt-in via the injected probe —
  // absent means no check (matrices without it are unchanged). A throwing probe
  // reports warn with the named reason, never fail: the note is
  // informational by design (overlap is legal), so a store hiccup must not
  // flip doctor's exit code.
  // Always present — a clean posture is a pass, so the matrix
  // shape stays stable and a loose directory is named rather than silent.
  try {
    checks.push(
      statePermissionCheck(
        deps.probeStatePermissions === undefined
          ? undefined
          : deps.probeStatePermissions(),
      ),
    );
  } catch (error) {
    checks.push({
      id: 'state:permissions',
      label: 'state permissions',
      status: 'warn',
      reason: 'ok',
      detail: `state permissions unverified: ${probeMessage(error)}`,
    });
  }
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
  // Full-access sessions: one warning per live session
  // running with approvals off (see fullAccessSessionCheck). A throwing
  // probe becomes one warn check, never a crash.
  if (deps.probeFullAccessSessions !== undefined) {
    try {
      for (const session of deps.probeFullAccessSessions()) {
        checks.push(fullAccessSessionCheck(session));
      }
    } catch (error) {
      checks.push({
        id: 'session:full-access',
        label: 'session full access',
        status: 'warn',
        reason: 'ok',
        detail: `full-access sessions unverified (session store not listable): ${probeMessage(error)}`,
      });
    }
  }
  // License identity: reported on every run, never skipped
  // implicitly — --skip license:kubic remains available like any check.
  checks.push(licenseCheck());
  // Honest limits plus: the limit aggregates
  // derive from the probes captured above — never a second probe call —
  // and from the POST-skip items, so skipping a failing item clears the
  // aggregate it would otherwise fail. A direct --skip of a limit id is
  // still honoured by the final pass below.
  const skipped = new Set(skip);
  checks.push(
    ...limitChecksFromResults(
      {
        providerProbes,
        providerError,
        depProbes,
        depError,
        rawPolicy,
        policyLoaded,
        policyError,
      },
      skipped,
    ),
  );
  return applySkip(checks, skip);
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

function summarize(checks: DoctorCheck[]): string {
  const pass = checks.filter((c) => c.status === 'pass').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  const skip = checks.filter((c) => c.status === 'skip').length;
  return `doctor: ${pass} pass, ${warn} warn, ${fail} fail, ${skip} skip`;
}

// The parsed `kubic doctor` invocation (commander owns the argv:
// apps/kubic/src/commands/session.ts). Each `skip` entry may list several
// comma-separated check ids.
export interface DoctorCommandOptions {
  readonly skip?: readonly string[];
  readonly json?: boolean;
  // The full per-check report on an interactive terminal
  // (the grouped summary is the default there). Piped output is always the
  // full report.
  readonly verbose?: boolean;
  // Check one session — its installed posture reads that
  // session's posture.json, and the full-access enumeration covers
  // exactly it (workspace filter bypassed).
  readonly session?: string;
}

export async function runDoctorCommand(
  options: DoctorCommandOptions,
  deps: DoctorDeps,
): Promise<CommandResult> {
  const skip = (options.skip ?? [])
    .flatMap((value) => value.split(','))
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const checks = collectDoctorChecks(deps, skip);
  const known = new Set(checks.map((check) => check.id));
  const unknownSkip = skip.find((id) => !known.has(id));
  if (unknownSkip !== undefined) {
    diagnosticsOf(deps).error(`unknown check ${JSON.stringify(unknownSkip)}`);
    return { exitCode: EXIT_USAGE };
  }
  const exitCode = limitsDoctorExit(checks);
  const failed = exitCode !== EXIT_OK;
  if (options.json === true) {
    deps.out(formatJson({ ok: !failed, exitCode, checks }));
    return { exitCode };
  }
  const theme = themeOf(deps);
  if (deps.fancy === true && options.verbose !== true) {
    for (const line of renderDoctorGrouped(checks, theme, {
      exitCode,
      ...(deps.columns === undefined ? {} : { columns: deps.columns }),
    })) {
      deps.out(line);
    }
    return { exitCode };
  }
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
  return { exitCode };
}
