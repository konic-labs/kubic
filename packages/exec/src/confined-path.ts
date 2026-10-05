import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';

// Path confinement for state files named by repo-local data (issue #437):
// the `owner` suffix in the orchestrator rows file is untrusted input, so a
// file built from it must resolve inside the state dir — `..` segments and
// symlinks pointing out are refused with a named reason instead of read.
export type ConfinedPathRefusal = 'missing' | 'outside-root';

export function confinedStatePath(
  dir: string,
  file: string,
): { ok: true; path: string } | { ok: false; reason: ConfinedPathRefusal } {
  const candidate = join(dir, file);
  let realDir: string;
  let realFile: string;
  try {
    realDir = realpathSync(dir);
    realFile = realpathSync(candidate);
  } catch {
    // A missing file reads as absent (the long-standing prod posture for
    // unreadable worker state), never a crash.
    return { ok: false, reason: 'missing' };
  }
  const rel = relative(realDir, realFile);
  if (rel === '..' || rel.startsWith('../')) {
    return { ok: false, reason: 'outside-root' };
  }
  return { ok: true, path: realFile };
}
