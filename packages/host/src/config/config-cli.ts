// `kubic config` (issue #90; §35.1, §50, §78): the effective configuration
// as it will actually run — every value with the layer that owns it, plus
// the projections the product consumes (model, approvals, permissions,
// journal retention, modes, budgets). Presentation only: the values arrive
// through the same `loadRuntimeConfig` the composition root calls, so this
// command can never report a value the runtime does not use.
//
// Exit codes: 0 report, 1 load/usage failure (a broken config fails closed
// here too — the operator sees the named reason, not a silent default).

import { redactSecretShapes } from '../policy/secret-shapes.js';
import {
  effectiveConfigView,
  type RuntimeConfig,
  renderEffectiveConfig,
} from './runtime.js';

export const CONFIG_EXIT_OK = 0;
export const CONFIG_EXIT_FAIL = 1;

export interface ConfigCommandDeps {
  // One load, injected by the composition root: the CLI never re-derives
  // paths, trust, or env overrides of its own.
  load: () => RuntimeConfig;
  out: (line: string) => void;
}

function usage(out: (line: string) => void): number {
  out('usage: kubic config [--json]');
  return CONFIG_EXIT_FAIL;
}

export function runConfigCommand(
  args: string[],
  deps: ConfigCommandDeps,
): number {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    deps.out(`error: unknown flag ${arg}`);
    return usage(deps.out);
  }
  let runtime: RuntimeConfig;
  try {
    runtime = deps.load();
  } catch (error) {
    // Fail closed and name the reason (§35.1/§36/§71): unknown keys, a
    // distrusted project layer, secret refs, and budget keys all land here.
    deps.out(
      `error: ${redactSecretShapes(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    return CONFIG_EXIT_FAIL;
  }
  const view = effectiveConfigView(runtime);
  if (json) {
    deps.out(JSON.stringify(view, null, 2));
    return CONFIG_EXIT_OK;
  }
  for (const line of renderEffectiveConfig(view)) deps.out(line);
  return CONFIG_EXIT_OK;
}
