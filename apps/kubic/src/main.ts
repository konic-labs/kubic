#!/usr/bin/env node
// kubic CLI composition root: argv in, exit code out. Routing lives in the
// dispatch seam (./dispatch.js); the production runners it routes to live
// in ./prod-runners.js. This file parses argv, builds the seam, and wraps
// failures.

import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptKey } from '../../../packages/core/src/cli/prompt.js';
import { themeFor } from '../../../packages/core/src/cli/theme.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { ensureRuntimeExcludeRules } from '../../../packages/exec/src/runtime-exclude.js';
import {
  loadCliConfig,
  resolveInteractiveProjectTrust,
} from './config-runtime.js';
import { dispatchCommand } from './dispatch.js';
import { exitProcessAfterFlush } from './exit.js';
import { createProdRunners } from './prod-runners.js';
import { prodFirstRunSetup } from './setup-prod.js';
import {
  TRUST_KEYS,
  trustFileLines,
  trustQuestionLines,
} from './trust-question.js';

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
const err = (line: string) => console.error(line);
const [command, ...rest] = process.argv.slice(2);
const interactive = () =>
  process.stdin.isTTY === true && process.stdout.isTTY === true;
try {
  const code = await dispatchCommand(command, rest, {
    out,
    err,
    loadConfig: loadCliConfig,
    version: cliVersion,
    ensureRuntimeExclude: (entries) =>
      ensureRuntimeExcludeRules({ cwd: process.cwd(), entries }),
    isInteractive: interactive,
    // Issue #446: the root and subcommand help are coloured on a TTY.
    helpTheme: () => themeFor(process.stdout),
    // Issue #450: usage errors are an error block on a colour stderr.
    errorTheme: () => themeFor(process.stderr),
    // Issue #451: a bare `kubic` on a terminal with no global config runs
    // `kubic setup` first (KUBIC_SKIP_SETUP=1 skips it).
    firstRunSetup: () =>
      prodFirstRunSetup({ out, err, errTheme: themeFor(process.stderr) }),
    // Issue #228 (§35.1): the interactive trust question for `kubic tui` /
    // bare `kubic`. The resolver persists the answer under `~/.kubic/` and
    // hands it back to this invocation's config load; a non-TTY caller keeps
    // the refusal with both remedies named.
    // Issue #462: asked as one row of the first screen (05-C): one key
    // answers — y yes, n not now, v view the file first.
    resolveProjectTrust: () =>
      resolveInteractiveProjectTrust({
        ask: (question) =>
          promptKey({
            message: trustQuestionLines(
              themeFor(process.stdout),
              question,
              process.stdout.columns ?? 80,
              homedir(),
            ).join('\n'),
            interactive: true,
            nonInteractive: 'not-now',
            choices: TRUST_KEYS,
          }),
        show: (path) => {
          for (const line of trustFileLines(themeFor(process.stdout), path)) {
            out(line);
          }
        },
      }),
    runners: createProdRunners({
      out,
      debug: err,
      version: cliVersion,
    }),
  });
  exitProcessAfterFlush(code);
} catch (error) {
  // An unexpected failure is one `error: <message>` line, exit 1, with the
  // full stack behind the KUBIC_DEBUG=1 opt-in (issue #128). Pinned end to
  // end by scripts/binary-contract.mjs (the `__crash-probe` seam in
  // ./dispatch.js).
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.KUBIC_DEBUG === '1') {
    console.error(error);
  }
  console.error(`error: ${message}`);
  exitProcessAfterFlush(1);
}
