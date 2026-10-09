// Reading recorded trajectories: the one being replayed and the one
// --diff-against compares with.

import type { ExitCode } from '@kubic/core/cli/exit-codes';
import { EXIT_USAGE, EXIT_WORKSPACE } from '@kubic/core/cli/exit-codes';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import type { TrajectoryExport } from '@kubic/trajectory/schema';
import {
  parseTrajectoryExportJSON,
  TrajectorySchemaError,
} from '@kubic/trajectory/schema';

// Paths the user typed resolve against the working directory (a bridge
// rooted at '/' turned `kubic replay t.json` into `/t.json`); absolute
// paths are unaffected.
export function readFile(path: string): string {
  return createNodeFileBridge(process.cwd()).readTextFile(path);
}

export function loadTrajectory(
  path: string,
):
  | { trajectory: TrajectoryExport }
  | { code: string; message: string; exit: ExitCode } {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'trajectory-unreadable',
      message: `cannot read trajectory ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: EXIT_WORKSPACE,
    };
  }
  try {
    return { trajectory: parseTrajectoryExportJSON(raw) };
  } catch (error) {
    if (
      error instanceof TrajectorySchemaError &&
      error.code === 'unknown-major'
    ) {
      // An unsupported major is a caller usage error, with the code
      // preserved machine-readably.
      return {
        code: 'unknown-major',
        message: error.message,
        exit: EXIT_USAGE,
      };
    }
    return {
      code: 'trajectory-malformed',
      message: error instanceof Error ? error.message : String(error),
      exit: EXIT_USAGE,
    };
  }
}

export function modelIdOf(trajectory: TrajectoryExport): string {
  return `${trajectory.model.provider}/${trajectory.model.model}`;
}

export function loadOtherTrajectory(
  path: string,
):
  | { trajectory: TrajectoryExport }
  | { code: string; message: string; exit: ExitCode } {
  let raw: string;
  try {
    raw = readFile(path);
  } catch (error) {
    return {
      code: 'diff-against-unreadable',
      message: `cannot read --diff-against ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
      exit: EXIT_WORKSPACE,
    };
  }
  try {
    return { trajectory: parseTrajectoryExportJSON(raw) };
  } catch (error) {
    if (
      error instanceof TrajectorySchemaError &&
      error.code === 'unknown-major'
    ) {
      return {
        code: 'unknown-major',
        message: error.message,
        exit: EXIT_USAGE,
      };
    }
    return {
      code: 'diff-against-malformed',
      message: error instanceof Error ? error.message : String(error),
      exit: EXIT_USAGE,
    };
  }
}

export function describeRecorded(trajectory: TrajectoryExport): string[] {
  const actions = trajectory.actions.length;
  const observations = trajectory.observations.length;
  const files = trajectory.diff.filesChanged;
  return [
    'tier: recorded',
    `model: ${modelIdOf(trajectory)}`,
    `worktree: ${trajectory.worktree.path}`,
    `actions: ${actions}`,
    `observations: ${observations}`,
    `result: ${trajectory.result.status} — ${trajectory.result.summary}`,
    `diff: ${files.length} files${files.length > 0 ? ` (${files.join(', ')})` : ''}`,
  ];
}
