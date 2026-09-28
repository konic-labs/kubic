// Prod `kubic replay` re-execution runner (issue #78): binds the host's
// lane-backed replay runner to the real solo lane. The model pin in the
// request (deterministic's --model, live's recorded model) is resolved
// against the assembled catalog first: an unregistered pin can never
// reach the lane, so it reports provider_probe_failed (exit 6 — the same
// code `kubic run` yields with no reachable provider) instead of
// silently re-executing at another model. Trajectory reads go through
// the exec FileBridge (I/O confinement, §9): this file never imports
// node:fs directly.
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { assembleModels } from '../../../packages/host/src/models-cli.js';
import type {
  ReplayRunRequest,
  ReplayRunResult,
  ReplayRuntimeDeps,
} from '../../../packages/host/src/replay/replay.js';
import { createProdReplayRun } from '../../../packages/host/src/replay/run-prod.js';
import { parseTrajectoryExportJSON } from '../../../packages/trajectory/src/schema.js';
import {
  ModelSelectError,
  parseModelFlag,
} from '../../../packages/worker/src/model-select.js';
import { runHeadlessPrompt } from './headless-run.js';

export async function runProdReplay(
  request: ReplayRunRequest,
  // The effective config's projections (issue #114), threaded exactly
  // like `kubic run` threads runtimeRunDeps: the re-execution installs
  // the same policy the run path does.
  runtime: ReplayRuntimeDeps = { policySource: 'default' },
): Promise<ReplayRunResult> {
  const run = createProdReplayRun({
    loadTrajectory: (path: string) =>
      parseTrajectoryExportJSON(
        createNodeFileBridge(process.cwd()).readTextFile(path),
      ),
    runPrompt: async (
      prompt: string,
      model: string,
      runRuntime: ReplayRuntimeDeps,
    ) => {
      const assembled = await assembleModels(process.cwd(), process.env, {
        ...(runtime.projectTrusted === undefined
          ? {}
          : { projectTrusted: runtime.projectTrusted }),
      });
      try {
        const selection = parseModelFlag(model);
        if (
          assembled.models.getProvider(selection.provider) === undefined ||
          assembled.models.getModel(selection.provider, selection.id) ===
            undefined
        ) {
          throw new ModelSelectError(
            `unknown model '${selection.id}' on provider '${selection.provider}' (--model)`,
          );
        }
        return await runHeadlessPrompt(
          prompt,
          {},
          {
            models: assembled.models,
            model: selection,
            ...runRuntime,
          },
        );
      } catch (error) {
        if (error instanceof ModelSelectError) {
          return { terminus: 'provider_probe_failed', summary: error.message };
        }
        throw error;
      }
    },
  });
  return run(request, runtime);
}
