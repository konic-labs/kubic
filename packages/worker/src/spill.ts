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
 * A sink writing `<sessionDir>/spill/<n>-<stream>.log`, one file per clipped
 * stream, numbered in the order they were written so two calls never collide.
 * Created 0600: a command's output can carry secrets, and a session directory
 * is per-user state, never a shared one.
 */
export function createSessionSpillSink(
  sessionDir: string,
  bridge: FileBridge = createNodeFileBridge('/'),
): SpillSink {
  const dir = join(sessionDir, SPILL_DIR_NAME);
  let seq = 0;
  return {
    write(stream: 'stdout' | 'stderr', content: string): string {
      seq += 1;
      const path = join(dir, `${String(seq).padStart(4, '0')}-${stream}.log`);
      bridge.createDir(dir, true);
      bridge.writeFile(path, content, { mode: 0o600 });
      return path;
    },
  };
}
