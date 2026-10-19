// The settled result of a `kubic run`, after its session closed: the report
// fields, the session's own usage, the secret scrub, the `[verify]` gates and
// the trajectory.
import { DEFAULT_RUN_ROLE } from '@kubic/core/run-role';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { withDetachedCheckout } from '@kubic/exec/git-clean';
import {
  appendToLedger,
  auditLedgerDirFor,
  verifyCommandAudit,
} from '@kubic/host/audit';
import { readSessionRunUsage } from '@kubic/host/cost';
import {
  type GateObserver,
  type HeadlessRunResult,
  hasVerifyCommands,
  runVerifier,
  verifierLabels,
} from '@kubic/host/run';
import { matchableSecrets, redactSecretValues } from '@kubic/host/secret-refs';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import type { RunReport, RunState } from './state.js';
import { persistRunTrajectory } from './trajectory.js';

export async function finishRun(
  state: RunState,
  result: HeadlessRunResult,
): Promise<HeadlessRunResult> {
  const measured = await withUsage(state, withReport(result, state.report));
  // A provider that echoes the key it rejected puts the value in
  // the run's own failure text. The result (the --json envelope) and the
  // trajectory's prompt are scrubbed of every live provider key before either
  // leaves the run; the session JSONL (which the trajectory's entries are
  // read back from) is scrubbed at its write bridge.
  const liveKeys = matchableSecrets(state.capture.liveSecrets());
  const scrub = <T>(value: T): T =>
    liveKeys.length === 0 ? value : (redactSecretValues(value, liveKeys) as T);
  const settled = scrub(measured);
  // kubic run -p plus its trajectory: every run that
  // attached a session writes <sessions-root>/<id>/trajectory.json when it
  // settles — completed or not — and the result's trajectory ref names that
  // file. A trajectory that cannot be written is reported on the warning
  // channel; it never changes the run's own result.
  const { sessionId, sessionsRoot } = state.capture;
  if (sessionId === undefined || sessionsRoot === undefined) return settled;
  const cwd = state.capture.cwd ?? state.deps.env?.cwd;
  const evalLabels = await verifyGates(state, sessionId, cwd);
  const { capture, deps } = state;
  try {
    const path = persistRunTrajectory({
      sessionsRoot,
      sessionId,
      agentId: resolveRunAgentId(deps.agentId),
      role: capture.role ?? DEFAULT_RUN_ROLE,
      prompt: scrub(state.prompt),
      entries: capture.entries,
      ...(capture.model === undefined ? {} : { model: capture.model }),
      ...(capture.thinking === undefined ? {} : { thinking: capture.thinking }),
      cwd: cwd ?? process.cwd(),
      skills: capture.skills,
      startedAt: capture.startedAt,
      endedAt: Date.now(),
      base: state.base,
      evalLabels,
      warn: state.sinks.warn,
      outcome: {
        terminus: settled.terminus,
        summary: settled.summary,
        ...(capture.lane === undefined ? {} : { lane: capture.lane }),
        interrupted: capture.interrupted,
      },
    });
    return { ...settled, trajectoryRef: path };
  } catch (error) {
    state.sinks.warn(
      `trajectory not written for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return settled;
  }
}

// Every result after the lane booted names the model the
// lane actually ran (the live lane model, never the bare selection), and
// the approval posture and the session's mode ride along.
function withReport(
  result: HeadlessRunResult,
  report: RunReport,
): HeadlessRunResult {
  return {
    ...result,
    ...(report.model === undefined ? {} : { model: report.model }),
    ...(report.posture === undefined ? {} : { posture: report.posture }),
    ...(report.mode === undefined ? {} : { mode: report.mode }),
  };
}

// The finished run reports its OWN usage — the session's usage
// rollup (what `kubic cost` reads), the tool calls it executed and the
// model that answered. Read after the session is closed; a run that never
// created a session, or a read that fails, keeps the refs-only report
// (never invented numbers).
async function withUsage(
  state: RunState,
  result: HeadlessRunResult,
): Promise<HeadlessRunResult> {
  if (result.sessionId === 'unassigned') return result;
  try {
    const measured = await readSessionRunUsage(
      state.deps.sessionsRoot ?? defaultSessionsRoot(),
      result.sessionId,
    );
    return {
      ...result,
      usage: measured.usage,
      // The live lane model reported by the boot wins over the
      // session's recorded usage model — a pin may have switched models in
      // this run, and the result must name the one that actually ran.
      ...(result.model !== undefined || measured.model === undefined
        ? {}
        : { model: measured.model }),
    };
  } catch {
    return result;
  }
}

// Gates after settlement: the configured `[verify]`
// commands run in the run's worktree — the same workspace the lane ran
// in — and their verdicts become the trajectory's `signal:*` labels. A
// run that never reached a workspace (a refused boot) has nothing to
// verify, so its gates stay unknown. A verifier failure never changes
// the run's own result; it is reported on the warning channel.
async function verifyGates(
  state: RunState,
  sessionId: string,
  cwd: string | undefined,
): Promise<Record<string, string>> {
  if (cwd === undefined) return {};
  try {
    if (hasVerifyCommands(state.deps.verify?.commands)) {
      return await verifyRun(cwd, state, sessionId);
    }
  } catch (error) {
    state.sinks.warn(
      `verify: gates not recorded for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {};
}

// The `[verify]` commands run in
// the run's worktree, then — when the run started from a git revision — in
// a throwaway detached checkout of that revision, so a gate that passed
// before the run and fails after it is recorded as a regression. The
// checkout is removed whatever happens; outside git no regression is
// claimed. Each command is shell from the config, run outside the approval
// interceptors, so each run of one is announced on stderr when it starts
// and lands a `verify:<gate>` row in the workspace's audit ledger.
async function verifyRun(
  cwd: string,
  state: RunState,
  sessionId: string,
): Promise<Record<string, string>> {
  const { deps, base } = state;
  const commands = deps.verify?.commands ?? {};
  const observer = (baseline: boolean): GateObserver => ({
    started: (gate, command) =>
      state.sinks.notice(
        `verify: running the ${gate} gate${baseline ? ' at the base revision' : ''}: ${command}`,
      ),
    settled: (gate, command, verdict) =>
      appendToLedger(
        auditLedgerDirFor(cwd),
        verifyCommandAudit({
          sessionId,
          workspace: cwd,
          base: base?.revision ?? 'none',
          gate,
          command,
          verdict,
          baseline,
        }),
        (message) =>
          state.sinks.warn(`audit: verify:${gate} not recorded: ${message}`),
      ),
  });
  const options = (baseline: boolean) => ({
    ...(deps.verify?.timeoutMs === undefined
      ? {}
      : { timeoutMs: deps.verify.timeoutMs }),
    observer: observer(baseline),
  });
  const current = await runVerifier(
    deps.env ?? new NodeExecutionEnv(cwd),
    commands,
    options(false),
  );
  const baseline =
    base === null
      ? null
      : await withDetachedCheckout(cwd, base.revision, (checkout) =>
          runVerifier(new NodeExecutionEnv(checkout), commands, options(true)),
        );
  return verifierLabels(current, baseline ?? undefined);
}

// The run's agent id: the configured `[agent].name`, else 'root'. It tags
// the run's journal, reconcile and trajectory entries.
function resolveRunAgentId(depsAgentId: string | undefined): string {
  return depsAgentId ?? 'root';
}
