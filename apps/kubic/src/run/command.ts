// `kubic run -p`: the composition root drives the real lane headless and
// derives the terminus from the lane's own settled outcome. Everything
// durable lands under <sessionsRoot>/<id>/: the transcript and usage rows in
// the session store, file effects in <id>/journal/ via lane interception,
// and the entry chain itself is the trajectory record, so every ref resolves
// to a real location. Resume keeps one chain: the -p prompt commits
// parent-linked to the last existing entry under a random id.
//
// The run is a sequence of phases over one RunState: the boot (boot.ts), the
// turn (turn.ts) under the guard (guard.ts), the terminus (outcome.ts), the
// close (close.ts) and the settled result (finish.ts).
import { killLaneProcesses } from '@kubic/agent/lane/abort';
import { SpendWatch, spentToday } from '@kubic/host/cost';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  type HeadlessRunResult,
} from '@kubic/host/run';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import type { SessionBoot } from '../session/bootstrap.js';
import { bootLane, createRunBoot, validateRun } from './boot.js';
import { closeRun } from './close.js';
import { finishRun } from './finish.js';
import { RunGuard } from './guard.js';
import type { HeadlessRunDeps, HeadlessRunOptions } from './options.js';
import { type RunStop, runResult } from './outcome.js';
import { announceNoIsolation } from './output.js';
import { RunState } from './state.js';
import { runTurn } from './turn.js';

export async function runHeadlessPrompt(
  prompt: string,
  options: HeadlessRunOptions,
  deps: HeadlessRunDeps = {},
): Promise<HeadlessRunResult> {
  const state = new RunState(prompt, options, deps);
  const result = await runSession(state);
  return finishRun(state, result);
}

// The session's part of the run: checked, opened, booted and turned, then
// closed on every exit path.
async function runSession(state: RunState): Promise<HeadlessRunResult> {
  const spend = await spendWatchFor(state.deps);
  const guard = new RunGuard(
    state.context,
    state.deps.signals ?? process,
    state.options.maxTurns,
    spend,
  );
  const boot = createRunBoot(state, guard);
  state.capture.liveSecrets = () => boot.liveSecrets();
  const invalid = validateRun(boot, state.options);
  if (invalid !== undefined) {
    return runResult({ kind: 'usage', message: invalid });
  }
  // A day whose cap is already spent refuses the run before a session
  // exists, so nothing is billed.
  const blocked = spend?.blocked();
  if (blocked !== undefined) {
    return runResult({ kind: 'spend-limit', message: blocked });
  }
  const opened = await boot.open();
  if (opened?.kind === 'store') {
    return runResult(
      { kind: 'caught', error: opened.error },
      state.options.sessionId,
    );
  }
  const id = state.attach(boot);
  const notice = announceNoIsolation(state.options.progress);
  try {
    const stop = await runBooted(state, boot, guard, notice);
    if (stop.kind === 'interrupted') state.capture.interrupted = true;
    return runResult(stop, id);
  } catch (error) {
    return runResult({ kind: 'caught', error }, id);
  } finally {
    await closeRun(state, boot, guard);
  }
}

// The run's spend against the `[policy]` caps; undefined when none is set.
// The day's spend is read only when a daily cap needs it.
async function spendWatchFor(
  deps: HeadlessRunDeps,
): Promise<SpendWatch | undefined> {
  const caps = deps.spend;
  if (
    caps === undefined ||
    (caps.run === undefined && caps.daily === undefined)
  ) {
    return undefined;
  }
  const today =
    caps.daily === undefined
      ? 0
      : await spentToday(deps.sessionsRoot ?? defaultSessionsRoot());
  return new SpendWatch(caps, today);
}

async function runBooted(
  state: RunState,
  boot: SessionBoot,
  guard: RunGuard,
  notice: boolean,
): Promise<RunStop> {
  // The first signal kills the running children synchronously: they sit in
  // their own process groups and never saw the signal.
  guard.start(state.options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, () =>
    killLaneProcesses(boot.lane),
  );
  const refused = await bootLane(state, boot);
  if (refused !== undefined) {
    return refused.kind === 'cancelled' && guard.interruptedBy !== undefined
      ? { kind: 'interrupted', signal: guard.interruptedBy }
      : { kind: 'refused', refusal: refused };
  }
  state.report.model =
    boot.liveModel === undefined ? undefined : boot.liveModelRef;
  state.options.progress?.begin({
    ...(state.report.model === undefined ? {} : { model: state.report.model }),
    ...(state.capture.role === undefined ? {} : { role: state.capture.role }),
    notice,
  });
  return runTurn(state, boot, guard);
}
