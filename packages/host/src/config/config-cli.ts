// `kubic config` (issue #90; §35.1, §50, §78): the effective configuration
// as it will actually run — every value with the layer that owns it, plus
// the projections the product consumes (model, approvals, permissions,
// journal retention, modes, budgets). Presentation only: the values arrive
// through the same `loadRuntimeConfig` the composition root calls, so this
// command can never report a value the runtime does not use.
//
// Exit codes: 0 report, 1 load failure (a broken config fails closed here
// too — the operator sees the named reason, not a silent default); a usage
// error is commander's (exit 2, apps/kubic/src/commands/solo.ts).

import { formatJson } from '../../../core/src/cli/output.js';
import { type CliIo, diagnosticsOf } from '../cli-io.js';
import { redactSecretShapes } from '../policy/secret-shapes.js';
import {
  effectiveConfigView,
  type RuntimeConfig,
  renderEffectiveConfig,
} from './runtime.js';

export const CONFIG_EXIT_OK = 0;
export const CONFIG_EXIT_FAIL = 1;

export interface ConfigCommandDeps extends CliIo {
  // One load, injected by the composition root: the CLI never re-derives
  // paths, trust, or env overrides of its own.
  load: () => RuntimeConfig;
}

export interface ConfigCommandOptions {
  readonly json?: boolean;
}

export function runConfigCommand(
  options: ConfigCommandOptions,
  deps: ConfigCommandDeps,
): number {
  let runtime: RuntimeConfig;
  try {
    runtime = deps.load();
  } catch (error) {
    // Fail closed and name the reason (§35.1/§36/§71): unknown keys, a
    // distrusted project layer, secret refs, and budget keys all land here.
    diagnosticsOf(deps).error(
      redactSecretShapes(
        error instanceof Error ? error.message : String(error),
      ),
    );
    return CONFIG_EXIT_FAIL;
  }
  const view = effectiveConfigView(runtime);
  if (options.json === true) {
    deps.out(formatJson(view));
    return CONFIG_EXIT_OK;
  }
  for (const line of renderEffectiveConfig(view)) deps.out(line);
  return CONFIG_EXIT_OK;
}
