// A worker's change summary (EPIC N, issue #464; docs/ui 04-C): files,
// added and removed lines, counted from the per-file `git diff
// <base>...HEAD -- <path>` hunks the run already reads for the merge (and
// stores with the worker's record, so `kubic workers inspect` reads the
// same numbers after the merge). Lines count only inside `@@` bodies — the
// `---`/`+++` file headers never do — and a file whose diff has no line
// body (a binary file, a mode change) still counts as changed.

import type { WorkerDiffStat } from '../../../core/src/presentation.js';

export interface DiffStatHunk {
  readonly path: string;
  readonly hunk: string;
}

export function diffStatOfHunks(
  hunks: readonly DiffStatHunk[],
): WorkerDiffStat {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const { path, hunk } of hunks) {
    files.add(path);
    let body = false;
    for (const line of hunk.split('\n')) {
      if (line.startsWith('diff --git ')) body = false;
      else if (line.startsWith('@@')) body = true;
      else if (body && line.startsWith('+')) added += 1;
      else if (body && line.startsWith('-')) removed += 1;
    }
  }
  return { files: files.size, added, removed };
}
