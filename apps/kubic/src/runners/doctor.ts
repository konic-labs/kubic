// The production `kubic doctor` runner: every check's probe, wired from the
// same config load and derivations `kubic run` boots with.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  openSessionStore,
  SESSION_ID_PATTERN,
  sessionsTouchingWorkspace,
} from '@kubic/agent/lane/session-store';
import { BACKGROUND_CONTEXT } from '@kubic/agent/pi-boundary';
import { EXIT_USAGE } from '@kubic/core/cli/exit-codes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { scanStateModes } from '@kubic/exec/lock-file';
import { installedPolicyPosture } from '@kubic/host/approvals';
import {
  AUDIT_LEDGER_FILE,
  auditLedgerDirFor,
  auditSinkSnapshot,
  auditSinksDoctorChecks,
  buildConfiguredSinks,
  isSyslogTargetAvailable,
} from '@kubic/host/audit';
import { projectTrustStorePath } from '@kubic/host/config';
import type {
  DoctorDeps,
  FullAccessSession,
  SessionOverlapProbe,
} from '@kubic/host/doctor';
import {
  describeFullAccessSession,
  listFullAccessSessions,
  runDoctorCommand,
} from '@kubic/host/doctor';
import type { AssembledModels } from '@kubic/host/models';
import {
  assembleModels,
  contextRoomProbeOf,
  FAUX_NOTICE,
  fauxProviderActive,
  modelsSourcesProbe,
  providerProbesOf,
} from '@kubic/host/models';
import { enterpriseDoctorChecks } from '@kubic/host/policy';
import { rolesDoctorProbe } from '@kubic/host/roles';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import { skillsDoctorProbe } from '@kubic/host/skills';
import type { CliConfigResult } from '../config/load.js';
import {
  doctorConfigProbe,
  doctorPolicyLoader,
  projectTrustFor,
} from '../config/load.js';
import { runtimeModelPin, runtimePolicy } from '../config/model-selection.js';
import {
  installedPolicyClasses,
  installedPolicyDeps,
  runtimeCompactionDeps,
  runtimeLaneDeps,
  runtimeSkillsDeps,
} from '../config/projections.js';
import type { ProdRunnerIo, ProdRunners } from './shared.js';
import { auditProbes, presentation } from './shared.js';

// `kubic doctor`: every check's probe, wired from the same config load and
// the same derivations `kubic run` boots with, so doctor judges what a run
// would do. Providers are listed, never dialed.
export function doctorRunner(io: ProdRunnerIo): ProdRunners['doctor'] {
  return async (options, cliConfig) => {
    // `doctor --session <id>` checks one session — its
    // installed posture reads that session's posture.json. A value that
    // cannot name a session directory is refused before any path join.
    const doctorSession = options.session;
    if (
      doctorSession !== undefined &&
      !SESSION_ID_PATTERN.test(doctorSession)
    ) {
      io.debug(
        `error: invalid --session id ${JSON.stringify(doctorSession)} (use [A-Za-z0-9_-])`,
      );
      return { exitCode: EXIT_USAGE };
    }
    const sessionsRoot = defaultSessionsRoot();
    const view = presentation(io.out, io.debug, options.json === true);
    const assembled = await assembleModels(process.cwd(), process.env, {
      home: cliConfig.trust.home,
      projectTrust: projectTrustFor(cliConfig),
    });
    for (const note of assembled.notes) view.logger.info(note);
    if (fauxProviderActive(process.env)) view.logger.warn(FAUX_NOTICE);
    return runDoctorCommand(options, {
      ...view,
      // The grouped summary packs into the terminal's width.
      ...(process.stdout.columns === undefined
        ? {}
        : { columns: process.stdout.columns }),
      ...modelChecks(assembled, cliConfig),
      ...dependencyChecks(assembled, cliConfig),
      ...policyChecks(
        cliConfig,
        doctorSession === undefined
          ? undefined
          : join(sessionsRoot, doctorSession),
      ),
      ...projectChecks(cliConfig),
      // The paths the journal leaves out, with the layer that set them.
      probeJournalCoverage: () => {
        const outOfScope = cliConfig.runtime?.journal.outOfScope;
        return outOfScope === undefined
          ? undefined
          : {
              outOfScope,
              source:
                cliConfig.runtime?.sources['journal.outOfScope'] ?? 'defaults',
            };
      },
      ...(await sessionChecks(
        sessionsRoot,
        doctorSession,
        cliConfig.trust.home,
      )),
    });
  };
}

// The providers, the models on the fallback window, and the room a
// compaction leaves.
function modelChecks(
  assembled: AssembledModels,
  cliConfig: CliConfigResult,
): Pick<
  DoctorDeps,
  'probeProviders' | 'probeModelWindows' | 'probeContextRoom'
> {
  return {
    probeProviders: () => providerProbesOf(assembled),
    // Models on the fallback window: one warning each, naming the key.
    probeModelWindows: () => assembled.defaultedWindows,
    // The room a compaction leaves for the models the user can configure,
    // from the configured keys the lane boots with (absent: the defaults)
    // and the default model the configuration pins.
    probeContextRoom: () => {
      const keys = runtimeCompactionDeps(cliConfig);
      const pin = runtimeModelPin(cliConfig);
      return contextRoomProbeOf(assembled, {
        ...(pin === undefined
          ? {}
          : { defaultModel: { provider: pin.provider, id: pin.id } }),
        ...(keys?.reserveTokens === undefined
          ? {}
          : { reserveTokens: keys.reserveTokens }),
        ...(keys?.keepRecentTokens === undefined
          ? {}
          : { keepRecentTokens: keys.keepRecentTokens }),
      });
    },
  };
}

// The runtime, the config load and the models.json files.
function dependencyChecks(
  assembled: AssembledModels,
  cliConfig: CliConfigResult,
): Pick<DoctorDeps, 'checkDeps'> {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((part) => Number(part));
  return {
    checkDeps: () => [
      {
        id: 'node',
        ok: major > 22 || (major === 22 && minor >= 19),
        detail: `node ${process.versions.node} (need >=22.19)`,
      },
      // The config load is reported here — a refused config
      // (unknown/unsupported key, distrusted project layer, secret ref)
      // and an incomplete runtime ignore split both fail
      // closed with the named reason instead of being silently ignored.
      doctorConfigProbe(cliConfig),
      // Which models.json files were found, their scope and
      // trust state; an invalid file fails by name.
      modelsSourcesProbe(assembled),
    ],
  };
}

// The approval policy, the policy a run installs, the enterprise policy and
// the audit sinks.
function policyChecks(
  cliConfig: CliConfigResult,
  sessionDir: string | undefined,
): Pick<
  DoctorDeps,
  'loadPolicy' | 'installedPolicy' | 'enterpriseChecks' | 'probeAuditSinks'
> {
  const enterprisePolicy = runtimePolicy(cliConfig);
  // The enterprise checks run only when a `[policy]`
  // section is actually configured — the resolved policy is always
  // present (empty without one), and running the checks over an empty
  // policy would fail the default matrix for a config that never asked
  // for enterprise enforcement. `sources` carries one leaf per config
  // key, so a `policy.` prefix IS "a [policy] section exists".
  const policyConfigured = Object.keys(cliConfig.runtime?.sources ?? {}).some(
    (leaf) => leaf.startsWith('policy.'),
  );
  return {
    // Config-sourced approval policy: the route/autoApprove
    // come from the loaded layers, not a hardcoded default.
    loadPolicy: doctorPolicyLoader(cliConfig),
    // Installed policy: the classes, guards and source
    // a run from THIS cwd actually installs — the same derivation
    // (host/approvals.installedPolicyPosture) `kubic run` boots the lane
    // with, over the same config projection it uses. Doctor reports the
    // INSTALLED posture, so the line cannot describe a policy no run
    // enforces; the config-sourced route above stays its own check.
    installedPolicy: () =>
      installedPolicyPosture({
        workspace: process.cwd(),
        // With --session the installed posture reads that
        // session's posture.json, so a full-access session reports
        // FULL ACCESS instead of the workspace-level false.
        ...(sessionDir === undefined ? {} : { sessionDir }),
        ...installedPolicyDeps(cliConfig),
      }),
    // Enterprise policy: the SAME effective resolution
    // `kubic policy` reports, checked for enforceability. Every
    // enterprise syslog target must be reachable, or the check fails
    // closed instead of claiming an audit trail that does not exist. The
    // probe is wired only for a configured `[policy]`, so the default
    // matrix is unchanged.
    ...(enterprisePolicy === undefined || !policyConfigured
      ? {}
      : {
          enterpriseChecks: () =>
            enterpriseDoctorChecks(enterprisePolicy, {
              syslogAvailable: enterprisePolicy.audit.sinks.every(
                (sink) =>
                  sink.kind !== 'syslog' ||
                  isSyslogTargetAvailable(sink.target, auditProbes),
              ),
            }),
        }),
    // Configured `[[audit]]` sinks: the SAME tables
    // dispatch built this process's sinks from, probed for reachability
    // plus the runtime failures recorded so far. Wired only when tables
    // exist, so the default matrix is unchanged.
    ...(cliConfig.runtime?.config.audit === undefined ||
    cliConfig.runtime.config.audit.length === 0
      ? {}
      : {
          probeAuditSinks: () =>
            auditSinksDoctorChecks({
              tables: cliConfig.runtime?.config.audit ?? [],
              problems: buildConfiguredSinks(
                cliConfig.runtime?.config.audit ?? [],
              ).problems,
              snapshot: auditSinkSnapshot(),
              probes: auditProbes,
            }),
        }),
  };
}

// The project's role documents and skills, judged as a run would see them.
function projectChecks(
  cliConfig: CliConfigResult,
): Pick<DoctorDeps, 'probeRoles' | 'probeSkills'> {
  const enterprisePolicy = runtimePolicy(cliConfig);
  const roleLayers = runtimeLaneDeps(cliConfig).roles?.layers;
  return {
    // Role-document posture: the SAME probe `kubic run
    // --role <name>` uses to select and validate a role, run over this
    // cwd's `.kubic/roles/*.md`. A contradictory document (declared
    // classes vs tool set) or a parse refusal is reported here with the
    // resolver's named reason, so a role the lane would refuse is
    // visible before the run instead of at boot. Absent or empty
    // directory reports clean.
    probeRoles: () =>
      rolesDoctorProbe({
        cwd: process.cwd(),
        bridge: createNodeFileBridge(process.cwd()),
        // Judge the roles the run would resolve — the
        // project root's documents, not the subdir's (absent) ones.
        projectRoot: cliConfig.projectRoot,
        // A role declaring an enterprise-denied tool is
        // refused by `kubic run --role`, so it is red here too.
        ...(enterprisePolicy === undefined
          ? {}
          : { toolPolicy: enterprisePolicy }),
        // The config `[roles.<name>]` layers `kubic run --role` merges
        // under each document: a role is judged as it would run.
        ...(roleLayers === undefined ? {} : { layers: roleLayers }),
        // Judge the effective classes the lane
        // would install — the most restrictive merge with each role.
        ...installedPolicyClasses(cliConfig),
        // Judge the trust the run would see —
        // an untrusted root's withheld roles warn here, never green.
        trustProject: projectTrustFor(cliConfig),
        // Judge the global roles the run would see —
        // absent (tests and embeddings with no home) means no source.
        ...(cliConfig.trust.home === '' ? {} : { home: cliConfig.trust.home }),
      }),
    // Skills gate: the same boot the lane runs,
    // judged with the lane's classes and no role — a skill the lane
    // would not offer warns with the gate's reason, never green. The
    // trust inputs mirror `kubic run`'s (env opt-in + the per-path
    // project check), so doctor judges the tree the run would see.
    probeSkills: () =>
      skillsDoctorProbe({
        bridge: createNodeFileBridge(process.cwd()),
        cwd: process.cwd(),
        homeDir: homedir(),
        trusted:
          process.env.KUBIC_TRUST_PROJECT === '1' ||
          process.env.KUBIC_TRUST_PROJECT === 'true',
        trustProject: projectTrustFor(cliConfig),
        ...runtimeSkillsDeps(cliConfig),
        ...installedPolicyClasses(cliConfig),
      }),
  };
}

// The sessions recorded against this workspace, the live full-access
// sessions, and the sessions root's permissions.
async function sessionChecks(
  sessionsRoot: string,
  doctorSession: string | undefined,
  home: string,
): Promise<
  Pick<
    DoctorDeps,
    'probeSessionOverlap' | 'probeFullAccessSessions' | 'probeStatePermissions'
  >
> {
  // Repo-level session overlap: the local session
  // store's view of the sessions recorded against this cwd. Best-effort:
  // an unlistable store makes NO claim (the probe stays un-injected)
  // rather than crashing doctor — the note is informational, so an
  // unreadable store must not turn into a failure of its own. A warning
  // only: it never flips the exit code.
  let sessionOverlapProbe: (() => SessionOverlapProbe) | undefined;
  try {
    const sessionIds = await sessionsTouchingWorkspace(
      openSessionStore(sessionsRoot, createNodeFileBridge(sessionsRoot)),
      process.cwd(),
      BACKGROUND_CONTEXT,
    );
    sessionOverlapProbe = () => ({ workspace: process.cwd(), sessionIds });
  } catch {
    sessionOverlapProbe = undefined;
  }
  // Full-access sessions: the workspace's live
  // sessions running with approvals off — enumerated eagerly like the
  // overlap probe, so the check cannot disagree with the store doctor
  // just listed. With --session exactly one session is checked (the
  // workspace filter is bypassed: the operator named it). Best-effort
  // like the overlap probe: an unlistable store makes no claim.
  let fullAccessProbe: (() => FullAccessSession[]) | undefined;
  try {
    const fullAccess =
      doctorSession === undefined
        ? await listFullAccessSessions({
            sessionsRoot,
            workspace: process.cwd(),
          })
        : await describeFullAccessSession(sessionsRoot, doctorSession).then(
            (session) => (session === undefined ? [] : [session]),
          );
    fullAccessProbe = () => fullAccess;
  } catch {
    fullAccessProbe = undefined;
  }
  return {
    ...(sessionOverlapProbe === undefined
      ? {}
      : { probeSessionOverlap: sessionOverlapProbe }),
    ...(fullAccessProbe === undefined
      ? {}
      : { probeFullAccessSessions: fullAccessProbe }),
    // Always injected: the check itself passes when the sessions root is
    // private. Best-effort like the overlap probe: an unreadable root makes
    // no claim.
    // The trust store and its directory, this workspace's audit ledger and
    // its directory, then every session below the root: the walk is bounded
    // and names what it skipped.
    probeStatePermissions: () => {
      const ledgerDir = auditLedgerDirFor(process.cwd());
      return scanStateModes(
        [
          ...(home === ''
            ? []
            : [join(home, '.kubic'), projectTrustStorePath(home)]),
          ledgerDir,
          join(ledgerDir, AUDIT_LEDGER_FILE),
        ],
        [sessionsRoot],
      );
    },
  };
}
