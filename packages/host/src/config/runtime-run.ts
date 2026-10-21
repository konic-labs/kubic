// The run-scoped sections of the runtime config: the `[verify]` gate commands
// and the `[run]` bounds. Both are re-validated here, because the programmatic
// session/agent layers never pass through the TOML parser.

import type { KubicConfig } from './config.js';
import {
  checkRunConfig,
  checkVerifyConfig,
  VERIFY_COMMAND_KEYS,
} from './config.js';
import type { RuntimeRun, RuntimeVerify } from './runtime-types.js';

// The `[verify]` gate commands a run executes after it settles.
export function verifyFrom(config: KubicConfig): RuntimeVerify {
  const verifyConfig =
    config.verify === undefined
      ? {}
      : checkVerifyConfig(
          config.verify as unknown as Record<string, unknown>,
          'verify',
        );
  return {
    commands: Object.fromEntries(
      VERIFY_COMMAND_KEYS.flatMap((key) => {
        const command = verifyConfig[key];
        return command === undefined ? [] : [[key, command]];
      }),
    ),
    ...(verifyConfig.timeoutMs === undefined
      ? {}
      : { timeoutMs: verifyConfig.timeoutMs }),
  };
}

// The `[run]` bounds a headless run takes where its flags set none.
export function runFrom(config: KubicConfig): RuntimeRun {
  const run =
    config.run === undefined
      ? {}
      : checkRunConfig(config.run as unknown as Record<string, unknown>, 'run');
  return {
    ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
    ...(run.maxTurns === undefined ? {} : { maxTurns: run.maxTurns }),
  };
}
