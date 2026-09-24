#!/usr/bin/env node
// kubic CLI composition root: argv in, exit code out. All logic lives in
// the packages; this file only wires.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatVersionLine } from '../../../packages/core/src/license.js';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { runDoctorCommand } from '../../../packages/host/src/doctor.js';
import { runGitCommand } from '../../../packages/host/src/git-cli.js';
import { runJournalCommand } from '../../../packages/host/src/journal-cli.js';
import {
  assembleModels,
  runModelsCommand,
} from '../../../packages/host/src/models-cli.js';
import {
  loadSessionCostRows,
  runCostCommand,
} from '../../../packages/host/src/ops/cost/cost-cli.js';
import { runPerfCommand } from '../../../packages/host/src/ops/perf/perf-cli.js';
import { runAuditCommand } from '../../../packages/host/src/policy/audit-cli.js';
import { resolveEffectivePolicy } from '../../../packages/host/src/policy/enterprise.js';
import { runPolicyCommand } from '../../../packages/host/src/policy/policy-cli.js';
import { runRunCommand } from '../../../packages/host/src/run-cli.js';
import { runSessionsCommand } from '../../../packages/host/src/sessions-cli.js';
import { runWorkersCommand } from '../../../packages/host/src/workers-cli.js';
import { WorkerRegistry } from '../../../packages/worker/src/lifecycle/registry.js';
import { runHeadlessPrompt } from './headless-run.js';
import { runTuiCommand, tuiDepsWithDefaults } from './tui-run.js';

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

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === '--version' || command === '-V') {
    console.log(formatVersionLine(cliVersion()));
    return 0;
  }
  if (command === 'sessions') {
    return runSessionsCommand(rest, { out: (line) => console.log(line) });
  }
  if (command === 'git') {
    return runGitCommand(rest, {
      env: new NodeExecutionEnv(process.cwd()),
      out: (line) => console.log(line),
    });
  }
  if (
    command === 'diff' ||
    command === 'undo' ||
    command === 'log' ||
    command === 'status'
  ) {
    return runJournalCommand([command, ...rest], {
      out: (line) => console.log(line),
    });
  }
  if (command === 'models') {
    const assembled = assembleModels(process.cwd());
    if (assembled.note !== null) console.log(assembled.note);
    return runModelsCommand(rest, {
      models: assembled.models,
      out: (line) => console.log(line),
    });
  }
  if (command === 'run') {
    return runRunCommand(rest, {
      out: (line: string) => console.log(line),
      run: (prompt: string, options: { sessionId?: string }) =>
        runHeadlessPrompt(prompt, options),
    });
  }
  if (command === 'tui') {
    return runTuiCommand(
      rest,
      tuiDepsWithDefaults({ out: (line: string) => console.log(line) }),
    );
  }
  if (command === 'doctor') {
    // Default probes are faux-only: providers are listed (never dialed),
    // deps check the live node runtime, policy falls back to host
    // defaults until config-sourced policy lands.
    const assembled = assembleModels(process.cwd());
    if (assembled.note !== null) console.log(assembled.note);
    const [major = 0, minor = 0] = process.versions.node
      .split('.')
      .map((part) => Number(part));
    return runDoctorCommand(rest, {
      out: (line: string) => console.log(line),
      probeProviders: () =>
        assembled.models.getProviders().map((provider) => ({
          id: provider.id,
          reachable: true,
          models: assembled.models
            .getModels(provider.id)
            .map((model) => model.id),
        })),
      checkDeps: () => [
        {
          id: 'node',
          ok: major > 22 || (major === 22 && minor >= 19),
          detail: `node ${process.versions.node} (need >=22.19)`,
        },
      ],
      loadPolicy: () => ({ route: 'ask-user', autoApprove: [] }),
    });
  }
  if (command === 'cost') {
    // Per-agent cost over real session stats (one aggregate row per
    // session); the task total is Σ(rows) by construction (issue #79).
    return runCostCommand(rest, {
      loadRows: (sessionId) => loadSessionCostRows(undefined, sessionId),
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'perf') {
    // Perf-budget evaluation over argv samples (faux-only, issue #79).
    return runPerfCommand(rest, {
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'policy') {
    // Routing offer over the enterprise default (deny-by-default, no
    // config-sourced policy yet — issue #79 wires the query, not storage).
    return runPolicyCommand(rest, {
      resolvePolicy: () => resolveEffectivePolicy([]).policy,
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'audit') {
    // Audit query over the record source (no audit persistence is wired
    // yet, so the one-shot CLI reads zero rows — filters and the
    // sentinel-only redaction are live, issue #79).
    return runAuditCommand(rest, {
      loadRecords: () => [],
      out: (line: string) => console.log(line),
    });
  }
  if (command === 'workers') {
    // The one-shot CLI owns a fresh process registry: no orchestrator
    // runs in this process, so a live invocation lists zero rows (both
    // views agree, exit 0). Spawn/reap stay orchestrator-internal.
    const registry = new WorkerRegistry();
    const code = await runWorkersCommand(rest, {
      list: () => registry.list(),
      out: (line: string) => console.log(line),
      debug: (line: string) => console.error(line),
    });
    // runWorkersCommand reports usage as 1; the binary surfaces §78
    // usage errors as 2 (issue #77).
    return code === 1 ? 2 : code;
  }
  console.log(
    'usage: kubic <sessions | git | models | diff | undo | log | status | run | tui | doctor | workers | cost | perf | policy | audit>',
  );
  return 1;
}

const code = await main(process.argv.slice(2));
process.exit(code);
