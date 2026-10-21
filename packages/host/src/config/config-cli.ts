// `kubic config`: the effective configuration as it will actually run —
// every value with the layer that owns it, plus the projections the product
// consumes (model, approvals, permissions, journal retention). Presentation
// only: the values arrive
// through the same `loadRuntimeConfig` the composition root calls, so this
// command can never report a value the runtime does not use.
//
// Exit codes: 0 report, 1 load failure (a broken config fails closed here
// too — the operator sees the named reason, not a silent default); a usage
// error is commander's (exit 2, apps/kubic/src/commands/setup.ts).

import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
} from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import { type CliIo, diagnosticsOf } from '../cli/index.js';
import type { ProjectInstructions } from '../instructions/index.js';
import type { RuntimeConfig } from './runtime-types.js';
import { effectiveConfigView, renderEffectiveConfig } from './runtime-view.js';

export interface ConfigCommandDeps extends CliIo {
  // One load, injected by the composition root: the CLI never re-derives
  // paths, trust, or env overrides of its own.
  load: () => RuntimeConfig;
  // The AGENTS.md files a run here would load (the composition root runs the
  // same search the lane boot runs). Absent: not reported.
  instructions?: () => ProjectInstructions;
}

// The project instructions as `kubic config` reports them.
function instructionsReport(instructions: ProjectInstructions): {
  enabled: boolean;
  loaded: Array<{ path: string; bytes: number; truncated: boolean }>;
  skipped: Array<{ path: string; reason: string }>;
} {
  return {
    enabled: instructions.enabled,
    loaded: instructions.loaded.map((file) => ({ ...file })),
    skipped: instructions.skipped.map((file) => ({ ...file })),
  };
}

function instructionsLine(instructions: ProjectInstructions): string {
  if (!instructions.enabled) {
    return 'project instructions: off ([agent] projectInstructions = false)';
  }
  const loaded =
    instructions.loaded.length === 0
      ? 'no AGENTS.md loaded'
      : `${instructions.loaded.length} AGENTS.md loaded: ${instructions.loaded
          .map((file) => (file.truncated ? `${file.path} (cut)` : file.path))
          .join(', ')}`;
  const skipped = instructions.skipped.map(
    (file) => `${file.path} not loaded (${file.reason})`,
  );
  return `project instructions: ${[loaded, ...skipped].join('; ')}`;
}

export interface ConfigCommandOptions {
  readonly json?: boolean;
}

export function runConfigCommand(
  options: ConfigCommandOptions,
  deps: ConfigCommandDeps,
): CommandResult {
  let runtime: RuntimeConfig;
  try {
    runtime = deps.load();
  } catch (error) {
    // Fail closed and name the reason: unknown keys, a distrusted project
    // layer and secret refs all land here.
    diagnosticsOf(deps).error(
      redactSecretShapes(
        error instanceof Error ? error.message : String(error),
      ),
    );
    return { exitCode: EXIT_FAILED };
  }
  const view = effectiveConfigView(runtime);
  const instructions = deps.instructions?.();
  if (options.json === true) {
    deps.out(
      formatJson(
        instructions === undefined
          ? view
          : { ...view, instructions: instructionsReport(instructions) },
      ),
    );
    return { exitCode: EXIT_OK };
  }
  for (const line of renderEffectiveConfig(view)) deps.out(line);
  if (instructions !== undefined) deps.out(instructionsLine(instructions));
  return { exitCode: EXIT_OK };
}
