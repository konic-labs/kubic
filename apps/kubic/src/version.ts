// The CLI's own version, as the root manifest names it.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';

// License identity: the version is the one in the manifest named kubic, the
// repo root's package.json (apps/kubic is @kubic/cli, so the walk skips its
// manifest). Walk up from this module to that manifest: the src layout and the
// bundle (dist/kubic.js, which has no manifest of its own) both reach it. The
// license half of the line is owned by core/license.ts.
export function cliVersion(): string {
  // File access goes through the exec FileBridge (I/O confinement):
  // the composition root never imports node:fs directly.
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let level = 0; level < 6; level++) {
      try {
        const pkg = JSON.parse(
          createNodeFileBridge(dir).readTextFile('package.json'),
        ) as { name?: unknown; version?: unknown };
        if (pkg.name === 'kubic' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch {
        // No (or unreadable) manifest here — keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to the default below.
  }
  return '0.0.0';
}
