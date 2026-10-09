// The replay result envelope and its refusals.

import type { ExitCode } from '@kubic/core/cli/exit-codes';
import { EXIT_FAILED } from '@kubic/core/cli/exit-codes';
import type { CliLogger } from '@kubic/core/cli/logger';
import { formatJson } from '@kubic/core/cli/output';
import { createCliTheme } from '@kubic/core/cli/theme';
import type { ReplayCommandDeps, ReplayEnvelope, ReplayTier } from './types.js';

export const PLAIN = createCliTheme('none');

// The refused-config envelope: the same failure shape the tiered
// envelope uses, with no invocation to report, so a `--json` consumer still
// parses exactly one document. The reason is the config refusal's own.
export function refusedReplayEnvelope(message: string): ReplayEnvelope {
  return {
    ok: false,
    exitCode: EXIT_FAILED,
    tier: 'unknown',
    invocation: null,
    trajectory: null,
    changed: [],
    error: { code: 'config_refused', message },
  };
}

export function fail(
  deps: ReplayCommandDeps,
  options: { json: boolean; tier: ReplayTier | 'unknown'; log: CliLogger },
  trajectory: string | null,
  exitCode: ExitCode,
  code: string,
  message: string,
): ExitCode {
  const envelope: ReplayEnvelope = {
    ok: false,
    exitCode,
    tier: options.tier,
    invocation: null,
    trajectory,
    changed: [],
    error: { code, message },
  };
  if (options.json) deps.out(formatJson(envelope));
  else options.log.error(`[${code}] ${message}`);
  return exitCode;
}
