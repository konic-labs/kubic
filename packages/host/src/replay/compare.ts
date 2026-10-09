// Comparing two trajectories for --diff-against.

import type { TrajectoryExport } from '@kubic/trajectory/schema';
import { modelIdOf } from './recorded.js';

function diffFingerprint(trajectory: TrajectoryExport): string {
  return [...trajectory.diff.filesChanged].sort().join('\n');
}

// Compare invocation (compare/regression): log-only diff of two
// versioned trajectories at the Recorded tier. The envelope names every
// changed var (model, worktree, diff); any difference exits 1 as the
// regression signal, identity exits 0.
export function compareTrajectories(
  base: TrajectoryExport,
  other: TrajectoryExport,
): string[] {
  const changed: string[] = [];
  if (modelIdOf(other) !== modelIdOf(base)) changed.push('model');
  if (other.worktree.path !== base.worktree.path) changed.push('worktree');
  if (diffFingerprint(other) !== diffFingerprint(base)) changed.push('diff');
  return changed;
}
