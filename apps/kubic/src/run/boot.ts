// The boot of a `kubic run`: the shared session bootstrap with the run's own
// hooks (the run-start audit, `--invoke-skill`, the tool spans), and the
// checks that refuse a request before any store exists.
import { expandSkillInvocation } from '@kubic/agent/skills';
import { fullAccessInForceWarning } from '@kubic/host/approvals';
import {
  appendToLedger,
  auditLedgerDirFor,
  runStartAudit,
} from '@kubic/host/audit';
import { MAX_RUN_TIMEOUT_MS, runSpanHooks } from '@kubic/host/run';
import { offeredSkillNames } from '@kubic/host/skills';
import { type BootRefusal, SessionBoot } from '../session/bootstrap.js';
import type { RunGuard } from './guard.js';
import type { HeadlessRunOptions } from './options.js';
import type { RunCapture, RunState } from './state.js';

export function createRunBoot(state: RunState, guard: RunGuard): SessionBoot {
  const { options, deps, sinks } = state;
  return new SessionBoot(
    {
      command: 'run',
      context: state.context,
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      // The run's mode is always recorded — explicit `--autonomous` or off
      // by default.
      sessionMode: options.autonomous === true ? 'autonomous' : 'interactive',
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
      ...(options.noSkills === undefined ? {} : { noSkills: options.noSkills }),
      ...(options.skills === undefined ? {} : { cliSkills: options.skills }),
      ...(options.dangerouslySkipApprovals === undefined
        ? {}
        : { dangerouslySkipApprovals: options.dangerouslySkipApprovals }),
      // The tool spans, installed after policy so a blocked call never
      // opens one.
      spanHooks: () => runSpanHooks(state.spans),
      cancelled: () => guard.interruptedBy !== undefined,
      onPolicyInstalled: (booted) => recordRunStart(state, booted),
      onSkillsBooted: (booted) => invokeSkill(state, booted),
    },
    {
      sessionsRoot: deps.sessionsRoot,
      env: deps.env,
      classes: deps.policyClasses,
      policySource: deps.policySource,
      approvals: deps.approvals,
      policy: deps.policy,
      models: deps.models,
      modelsCwd: deps.modelsCwd,
      model: deps.model,
      streamTuning: deps.streamTuning,
      thinking: deps.thinking,
      compaction: deps.compaction,
      agentId: deps.agentId,
      journalRetention: deps.journalRetention,
      reconcileOutOfScope: deps.reconcileOutOfScope,
      systemPromptSection: deps.systemPromptSection,
      projectInstructions: deps.projectInstructions,
      projectProvidersRefusal: deps.projectProvidersRefusal,
      modelPolicy: deps.modelPolicy,
      trustProject: deps.trustProject,
      skills: deps.skills,
      roles: deps.roles,
    },
    {
      ...(sinks.debug === undefined ? {} : { debug: sinks.debug }),
      warn: sinks.warn,
      fauxNotice: sinks.warn,
      modelNotice: sinks.notice,
      // An unresolvable explicit --skill warns on stderr — never only on
      // the debug channel — so a typo cannot read as loaded.
      skillsWarn: sinks.warn,
      skillsLog: (line) => sinks.debug?.(`skills: ${line}`),
      instructionsNotice: (line) =>
        sinks.notice(`project instructions: ${line}`),
    },
  );
}

// Defense-in-depth with run-cli's checks: direct callers bypass the CLI,
// so a path-unsafe session id, an invalid guard bound or a contradictory
// tool selection fails closed with the usage terminus (exit 2) before any
// store or lane exists. Returns the usage message, or undefined.
export function validateRun(
  boot: SessionBoot,
  options: HeadlessRunOptions,
): string | undefined {
  return (
    usageRefusal(boot.validateSessionId()) ??
    guardBoundsRefusal(options) ??
    usageRefusal(boot.validateTools())
  );
}

// The boot itself. What it settled is the trajectory's, whichever step
// stopped it.
export async function bootLane(
  state: RunState,
  boot: SessionBoot,
): Promise<BootRefusal | undefined> {
  try {
    return await boot.boot();
  } finally {
    captureBoot(boot, state.capture);
  }
}

// The run's start names the mode in the ledger — a fresh session only (a
// resume continues the recorded run) — and a run on a full-access session
// is never silent: the grant's own warning when this run enabled it,
// otherwise the named in-force warning, on stderr so stdout stays
// consumable. Best-effort: a dead ledger never fails the run.
function recordRunStart(state: RunState, booted: SessionBoot): void {
  const { options, report, sinks } = state;
  const installed = booted.installed;
  const env = booted.env;
  if (installed === undefined || env === undefined) return;
  report.posture = installed.posture.fullAccess ? 'full-access' : 'approvals';
  if (options.sessionId === undefined) {
    appendToLedger(
      auditLedgerDirFor(env.cwd),
      runStartAudit({
        sessionId: booted.id,
        command: 'kubic run',
        runMode: options.autonomous === true ? 'autonomous' : 'interactive',
        workspace: env.cwd,
        posture: report.posture,
        autonomous: options.autonomous === true,
        base: booted.base ?? 'unknown',
      }),
      (message) => sinks.debug?.(`audit: run start not recorded: ${message}`),
    );
  }
  if (installed.posture.fullAccess) {
    sinks.warn(booted.fullAccessWarning ?? fullAccessInForceWarning(booted.id));
  }
}

// `--invoke-skill` expands against the invocable set (admitted +
// gate-passed, hidden included, withheld excluded) — the skill
// content runs as the turn prompt with the operator's prompt as
// instructions. An unknown name fails the run with the named error
// (exit 1, like a refused --role): the invocation IS the run.
function invokeSkill(
  state: RunState,
  booted: SessionBoot,
): BootRefusal | undefined {
  const { options, sinks } = state;
  if (options.invokeSkill !== undefined) {
    try {
      state.effectivePrompt = expandSkillInvocation(
        booted.skills?.invocable ?? [],
        options.invokeSkill,
        state.prompt,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: 'failed', message };
    }
  }
  const loaded = booted.skills?.skills ?? [];
  if (loaded.length > 0) {
    sinks.debug?.(
      `skills: ${loaded.length} loaded (${loaded
        .map((skill) => `${skill.name}@${skill.source}`)
        .join(', ')})`,
    );
  }
  return undefined;
}

// A refusal from the session checks, as the usage message, or undefined.
function usageRefusal(refusal: BootRefusal | undefined): string | undefined {
  return refusal?.kind === 'usage' ? refusal.message : undefined;
}

// Guard overrides are validated before any store or lane exists: an
// invalid bound fails closed with the usage terminus (exit 2) and never
// boots a lane. Unset bounds fall through to the CLI default.
function guardBoundsRefusal(options: HeadlessRunOptions): string | undefined {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    return `invalid timeoutMs ${JSON.stringify(options.timeoutMs)} (need a positive integer of milliseconds)`;
  }
  // Same ceiling as the CLI (defense-in-depth for direct callers): above
  // 2^31-1 ms setTimeout clamps to 1 ms, which would fire the "bound"
  // immediately and misreport a timeout.
  if (
    options.timeoutMs !== undefined &&
    options.timeoutMs > MAX_RUN_TIMEOUT_MS
  ) {
    return `invalid timeoutMs ${JSON.stringify(options.timeoutMs)} (max ${MAX_RUN_TIMEOUT_MS})`;
  }
  if (
    options.maxTurns !== undefined &&
    (!Number.isInteger(options.maxTurns) || options.maxTurns <= 0)
  ) {
    return `invalid maxTurns ${JSON.stringify(options.maxTurns)} (need a positive integer of turns)`;
  }
  return undefined;
}

// What the boot settled, for the trajectory: the role, the model the lane
// runs (else the selection), the workspace, the loaded skills and the
// thinking level the lane booted with (post-clamp; unset stays unset).
function captureBoot(boot: SessionBoot, capture: RunCapture): void {
  if (boot.role !== undefined) capture.role = boot.role.resolved.name;
  const model = boot.liveModel ?? boot.model;
  if (model !== undefined) {
    capture.model = { provider: model.provider, id: model.id };
  }
  if (boot.env !== undefined) capture.cwd = boot.env.cwd;
  if (boot.skills !== undefined)
    capture.skills = offeredSkillNames(boot.skills);
  if (boot.thinkingLevel !== undefined) capture.thinking = boot.thinkingLevel;
}
