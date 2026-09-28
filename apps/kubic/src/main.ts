#!/usr/bin/env node
// kubic CLI composition root: argv in, exit code out. Routing lives in the
// dispatch seam (./dispatch.js); the production runners it routes to live
// in ./prod-runners.js. This file parses argv, builds the seam, and wraps
// failures.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { ensureRuntimeExcludeRules } from '../../../packages/exec/src/runtime-exclude.js';
import { ExtensionStartupError } from '../../../packages/extensions/src/startup.js';
import { loadCliConfig } from './config-runtime.js';
import { dispatchCommand } from './dispatch.js';
import { exitProcessAfterFlush } from './exit.js';
import { createProdRunners } from './prod-runners.js';

// License identity (issue #59): version comes from this app's own
// package.json; the license half of the line is owned by core/license.ts.
// Walk up from this module: the src layout finds apps/kubic/package.json
// at once, while the dist layout (dist/apps/kubic/src/main.js, issue #74)
// has no sibling manifest, so the walk continues to the repo-root
// package.json — both declare the same 0.0.0 version.
function cliVersion(): string {
  // File access goes through the exec FileBridge (I/O confinement, §9):
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

const out = (line: string) => console.log(line);
const [command, ...rest] = process.argv.slice(2);
try {
  const code = await dispatchCommand(command, rest, {
    out,
    loadConfig: loadCliConfig,
    version: cliVersion,
    ensureRuntimeExclude: (entries) =>
      ensureRuntimeExcludeRules({ cwd: process.cwd(), entries }),
    isInteractive: () =>
      process.stdin.isTTY === true && process.stdout.isTTY === true,
    runners: createProdRunners({
      out,
      debug: (line) => console.error(line),
    }),
  });
  exitProcessAfterFlush(code);
} catch (error) {
  // Extension startup failures are named one-liners, not stack traces
  // (issue #93); every other unexpected failure gets the same shape — one
  // `error: <message>` line, exit 1 — with the full stack behind the
  // KUBIC_DEBUG=1 opt-in (issue #128). Both modes are pinned end to end by
  // scripts/binary-contract.mjs (the `__crash-probe` seam in ./dispatch.js).
  if (error instanceof ExtensionStartupError) {
    console.error(`error: ${error.message}`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.KUBIC_DEBUG === '1') {
      console.error(error);
    }
    console.error(`error: ${message}`);
  }
  exitProcessAfterFlush(1);
}
