// Prod `kubic replay` re-execution runner: binds the host's
// lane-backed replay runner to the real lane. The model pin in the
// request (deterministic's --model, live's recorded model) is resolved
// against the assembled catalog first: an unregistered pin can never
// reach the lane, so it reports provider_probe_failed (exit 6 — the same
// code `kubic run` yields with no reachable provider) instead of
// silently re-executing at another model. Trajectory reads go through
// the exec FileBridge (I/O confinement): this file never imports
// node:fs directly.
//
// The request's pins are the re-execution's inputs, not
// checked-then-ignored labels. The lane is rooted at the pinned worktree
// (the `--worktree` override, or the recorded path when it exists here),
// the live tier boots the role the `--role-config` names — its tools and
// prompt apply through the same role machinery `kubic run` uses — and the
// effective config's lane projections travel with it.

import { ModelSelectError, parseModelFlag } from '@kubic/agent/model-select';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { assembleModels } from '@kubic/host/models';
import type {
  ReplayRunRequest,
  ReplayRunResult,
  ReplayRuntimeDeps,
} from '@kubic/host/replay';
import { createProdReplayRun } from '@kubic/host/replay';
import { parseTrajectoryExportJSON } from '@kubic/trajectory/schema';
import { runHeadlessPrompt } from './run/command.js';

// The re-execution is rooted at the pinned worktree when
// that path exists on this machine. A recorded worktree that is absent
// here (another machine's trajectory) falls back to the working directory
// — the documented fallback — while an explicit `--worktree`
// override is existence-checked by the command before it gets this far.
function replayCwd(worktree: string): string {
  try {
    if (
      worktree !== '' &&
      createNodeFileBridge(process.cwd()).exists(worktree)
    ) {
      return worktree;
    }
  } catch {
    // An unreadable path is not a workspace: fall through to the cwd.
  }
  return process.cwd();
}

export async function runProdReplay(
  request: ReplayRunRequest,
  // The effective config's projections, threaded exactly
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
      rerun: ReplayRunRequest,
      runRuntime: ReplayRuntimeDeps,
    ) => {
      // The pinned worktree is where models.json, the role document and
      // the lane's tools resolve.
      const cwd = replayCwd(rerun.worktree);
      const assembled = await assembleModels(cwd, process.env, {
        ...(runRuntime.trustProject === undefined
          ? {}
          : { projectTrust: runRuntime.trustProject }),
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
          // The live tier's pin artifact names the role; the lane loads
          // `.kubic/roles/<name>.md` from the pinned worktree and applies
          // its tools and prompt.
          rerun.role === null ? {} : { role: rerun.role },
          {
            models: assembled.models,
            model: selection,
            ...runRuntime,
            // The lane runs where the pin says, under the config's
            // own projections (agent id, role layers, out-of-scope paths)
            // exactly as `kubic run` installs them.
            env: new NodeExecutionEnv(cwd),
            // Skills are discovered where the pin says too, with the
            // configured settings skills on top.
            skills: { ...runRuntime.skills, cwd },
            roles: {
              cwd,
              ...(runRuntime.roles?.layers === undefined
                ? {}
                : { layers: runRuntime.roles.layers }),
              // The pinned worktree's role
              // document loads under the same trust as the run — an
              // untrusted pin withholds it exactly like `kubic run`.
              ...(runRuntime.roles?.trustProject === undefined
                ? {}
                : { trustProject: runRuntime.roles.trustProject }),
            },
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
