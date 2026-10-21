// Prod suite runner for `kubic eval --task` / `kubic benchmark`. Each built-in
// suite carries a FIXTURE (prompt, starting files, gate commands); this runner
// materializes it, drives the real lane through runHeadlessPrompt, and
// scores the trajectory the run wrote with the eval package's own signal
// derivation — the same computeSignals/gatesPass the reference verifier reads,
// never a re-guess.
//
// Workspaces:
//   inline (default)  a fresh temp fixture directory, removed afterwards
//   worktree          a fresh detached checkout of the --worktree repo at
//                     its HEAD (`git worktree add --detach`), removed and
//                     pruned afterwards, so the matrix proves the task in
//                     a clean checkout
// The lane's own verifier runs the suite's gate commands in
// that workspace after the run settles, so the trajectory carries the
// signal:* labels the score is built from.
import { dirname, join } from 'node:path';
import { ModelSelectError, parseModelFlag } from '@kubic/agent/model-select';
import { EVAL_DEFAULT_MODEL, type EvalOptions } from '@kubic/eval/cli';
import { EvalRunnerError, type SuiteRunOutcome } from '@kubic/eval/runner';
import { computeSignals, gatesPass } from '@kubic/eval/signals';
import { type EvalSuite, findSuite } from '@kubic/eval/suites';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { gitHeadOf, withDetachedCheckout } from '@kubic/exec/git-clean';
import { assembleModels, FAUX_PROVIDER_ID } from '@kubic/host/models';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import { parseTrajectoryExportJSON } from '@kubic/trajectory/schema';
import type { CliConfigResult } from './config/load.js';
import { projectTrustFor } from './config/load.js';
import { runtimePolicy } from './config/model-selection.js';
import {
  runtimeLaneDeps,
  runtimeRunDeps,
  runtimeSkillsDeps,
} from './config/projections.js';
import { runHeadlessPrompt } from './run/command.js';
import type { HeadlessRunDeps } from './run/options.js';

export type ProdRunSuite = (
  suiteId: string,
  task: string | undefined,
) => Promise<SuiteRunOutcome>;

// Seed the fixture's starting files (relative paths; parents created)
// through the exec FileBridge — the composition root never touches node:fs
// directly (I/O confinement).
function seedFixture(
  bridge: ReturnType<typeof createNodeFileBridge>,
  fixture: EvalSuite['fixture'],
  dir: string,
): void {
  for (const [path, content] of Object.entries(fixture?.files ?? {})) {
    const absolute = join(dir, path);
    bridge.createDir(dirname(absolute), true);
    bridge.writeFile(absolute, content);
  }
}

async function runFixture(
  suite: EvalSuite,
  dir: string,
  options: EvalOptions,
  cliConfig: CliConfigResult,
  task: string | undefined,
): Promise<SuiteRunOutcome> {
  const fixture = suite.fixture;
  if (fixture === undefined) {
    throw new EvalRunnerError(
      'stub-suite',
      `suite ${JSON.stringify(suite.id)} has no fixture — refusing to score unimplemented work`,
    );
  }
  const bridge = createNodeFileBridge('/');
  seedFixture(bridge, fixture, dir);
  // The eval --model flag (default faux/echo) is the lane's model, resolved
  // against the catalog assembled for the fixture workspace.
  const selection = parseModelFlag(options.model ?? EVAL_DEFAULT_MODEL);
  const assembled = await assembleModels(dir, process.env, {
    projectTrust: projectTrustFor(cliConfig),
  });
  if (
    assembled.models.getProvider(selection.provider) === undefined ||
    assembled.models.getModel(selection.provider, selection.id) === undefined
  ) {
    throw new ModelSelectError(
      `unknown model '${selection.id}' on provider '${selection.provider}' (--model)`,
    );
  }
  const enterprisePolicy = runtimePolicy(cliConfig);
  const deps: HeadlessRunDeps = {
    sessionsRoot: defaultSessionsRoot(),
    models: assembled.models,
    model: selection,
    env: new NodeExecutionEnv(dir),
    // The same config projections `kubic run` threads, then the suite's own
    // gate commands (the fixture's verdict) on top.
    ...runtimeRunDeps(cliConfig),
    trustProject: projectTrustFor(cliConfig),
    ...runtimeLaneDeps(cliConfig),
    ...(enterprisePolicy === undefined
      ? {}
      : { modelPolicy: enterprisePolicy }),
    // The config `skills`, loaded with source 'settings' like `kubic run`.
    skills: { ...runtimeSkillsDeps(cliConfig) },
    verify: {
      commands: fixture.verify,
      ...(fixture.timeoutMs === undefined
        ? {}
        : { timeoutMs: fixture.timeoutMs }),
    },
  };
  // The prompt: the caller's task when one was given (`kubic eval
  // --task`), else the suite's own — scripted for the faux provider, which
  // cannot read prose, plain language for every real model.
  const prompt =
    task ??
    (selection.provider === FAUX_PROVIDER_ID
      ? fixture.fauxPrompt
      : fixture.task);
  const result = await runHeadlessPrompt(prompt, {}, deps);
  if (result.trajectoryRef === undefined) {
    throw new EvalRunnerError(
      'missing-usage-rows',
      `suite ${JSON.stringify(suite.id)} produced no trajectory — nothing to score`,
    );
  }
  const exported = parseTrajectoryExportJSON(
    bridge.readTextFile(result.trajectoryRef),
  );
  const signals = computeSignals(exported);
  return {
    success: signals.completion && gatesPass(signals),
    signals,
    // Reconciliation: one row carrying exactly what the trajectory
    // recorded, so the record's tokens/cost/latency reconcile by
    // construction.
    usageRows: [
      {
        inputTokens: exported.usage.inputTokens,
        outputTokens: exported.usage.outputTokens,
        costUsd: exported.usage.costUsd,
        latencyMs: exported.timestamps.durationMs,
      },
    ],
  };
}

// The prod runSuite the eval/benchmark runners call. It closes over the
// invocation's options (workspace/worktree/model), because the eval
// runner's runSuite seam carries only (suiteId, task).
export function createProdRunSuite(
  options: EvalOptions,
  cliConfig: CliConfigResult,
): ProdRunSuite {
  return async (
    suiteId: string,
    task: string | undefined,
  ): Promise<SuiteRunOutcome> => {
    const suite = findSuite(suiteId);
    if (suite === undefined) {
      throw new EvalRunnerError(
        'unknown-suite',
        `unknown suite ${JSON.stringify(suiteId)}`,
      );
    }
    if (suite.stub || suite.fixture === undefined) {
      throw new EvalRunnerError(
        'stub-suite',
        `suite ${JSON.stringify(suiteId)} is a stub — refusing to score unimplemented work`,
      );
    }
    const repo = options.worktree ?? process.cwd();
    if (options.workspace === 'worktree') {
      const head = gitHeadOf(repo);
      if (head === null) {
        throw new EvalRunnerError(
          'dirty-worktree',
          `worktree ${JSON.stringify(repo)} is not a git repository — --workspace worktree needs a clean checkout`,
        );
      }
      const outcome = await withDetachedCheckout(
        repo,
        head.revision,
        (checkout) => runFixture(suite, checkout, options, cliConfig, task),
      );
      if (outcome === null) {
        throw new EvalRunnerError(
          'dirty-worktree',
          `cannot create a worktree checkout of ${JSON.stringify(repo)} at ${head.revision}`,
        );
      }
      return outcome;
    }
    const bridge = createNodeFileBridge('/');
    const dir = bridge.createTempDir('kubic-eval-fixture-');
    try {
      return await runFixture(suite, dir, options, cliConfig, task);
    } finally {
      bridge.remove(dir, true, true);
    }
  };
}
