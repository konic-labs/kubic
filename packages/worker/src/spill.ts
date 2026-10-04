// Session-scoped spill files (issue #182; §27.5, §27 compaction spill refs).
//
// A tool result that clipped a stream keeps the TAIL in context and writes
// the full (seam-capped) stream here, so the head — usually where the first
// error is — stays recoverable by path. The files live INSIDE the session
// directory, which is what makes them session-scoped: `kubic sessions prune`
// removes a session with one recursive `bridge.remove(dir)`
// (`deleteSessionPruneCandidates`, host/src/sessions-prune.ts), so the spills
// go with it. That also keeps them out of the workspace (where the end-of-run
// sweep would journal them as unattributed creates) and out of $TMPDIR (which
// nothing would ever clean).

import { join } from 'node:path';
import {
  createNodeFileBridge,
  type FileBridge,
} from '../../exec/src/file-bridge.js';

/** The subdirectory of a session that holds its spill files. */
export const SPILL_DIR_NAME = 'spill';

/**
 * Where a clipped stream's full text goes. Implemented by the lane (which
 * owns the session directory) and injected into the op context; the op only
 * decides WHEN to spill and names the path in its notice.
 */
export interface SpillSink {
  /** Write one stream's full text and return the path it landed at. */
  write(stream: 'stdout' | 'stderr', content: string): string;
}

/**
 * A sink writing `<sessionDir>/spill/<n>-<stream>-<pid>.log`, one file per
 * clipped stream, created 0600 (a command's output can carry secrets, and a
 * session directory is per-user state, never a shared one).
 *
 * The name must be unique for the LIFE OF THE SESSION, not just for this
 * sink: a resumed session re-reads its durable tool results, so a result that
 * names a path must never be handed a later command's output under the same
 * name. `n` therefore starts after the highest index already in the directory
 * (a resumed run's spills included), the pid separates two processes that
 * seeded the same value, and an existing file is never truncated — the
 * counter steps over it instead.
 */
export function createSessionSpillSink(
  sessionDir: string,
  bridge: FileBridge = createNodeFileBridge('/'),
): SpillSink {
  const dir = join(sessionDir, SPILL_DIR_NAME);
  let seq = highestSpillIndex(bridge, dir);
  return {
    write(stream: 'stdout' | 'stderr', content: string): string {
      bridge.createDir(dir, true);
      let path: string;
      do {
        seq += 1;
        path = join(
          dir,
          `${String(seq).padStart(4, '0')}-${stream}-${process.pid}.log`,
        );
      } while (bridge.exists(path));
      bridge.writeFile(path, content, { mode: 0o600 });
      return path;
    },
  };
}

// The largest `<n>` already used in the spill directory, 0 when there is
// none (a fresh session, or a directory that cannot be listed).
function highestSpillIndex(bridge: FileBridge, dir: string): number {
  let names: string[];
  try {
    names = bridge.listDir(dir).map((info) => info.name);
  } catch {
    return 0;
  }
  let highest = 0;
  for (const name of names) {
    const match = /^(\d+)-/.exec(name);
    if (match === null) continue;
    highest = Math.max(highest, Number.parseInt(match[1] as string, 10));
  }
  return highest;
}
