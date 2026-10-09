// Determinism tiers: parsing and resolving --tier, and running a re-execution
// tier through the injected runner.

import type { ExitCode } from '@kubic/core/cli/exit-codes';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
  EXIT_USAGE,
  EXIT_WORKSPACE,
} from '@kubic/core/cli/exit-codes';
import { formatJson } from '@kubic/core/cli/output';
import type {
  ReplayCommandDeps,
  ReplayEnvelope,
  ReplayInvocation,
  ReplayOptions,
  ReplayRuntimeDeps,
  ReplayTier,
} from './types.js';

function parseTier(raw: string): ReplayTier | null {
  if (raw === 'recorded' || raw === 'deterministic' || raw === 'live') {
    return raw;
  }
  return null;
}

// Every result publishes a tier: the declared --tier when one was
// given (unknown when it names no known tier), else the recorded default.
export function resolveTier(raw: string | undefined): ReplayTier | 'unknown' {
  if (raw === undefined) return 'recorded';
  return parseTier(raw) ?? 'unknown';
}

// Replay's subset (0/1/2/5/6) as a runtime allowlist over the
// injected runner's terminus: a contract-violating runner (a run-cli
// terminus outside replay's subset, or garbage) fail-closes to exit 2 —
// never 3/4/undefined.
function replayTerminusToExitCode(terminus: unknown): ExitCode {
  switch (terminus) {
    case 'completed':
      return EXIT_OK;
    case 'failed':
      return EXIT_FAILED;
    case 'workspace_unavailable':
      return EXIT_WORKSPACE;
    case 'provider_probe_failed':
      return EXIT_PROVIDER;
    default:
      return EXIT_USAGE;
  }
}

export async function executeTierRun(
  deps: ReplayCommandDeps,
  runtime: ReplayRuntimeDeps,
  options: ReplayOptions,
  params: {
    tier: 'deterministic' | 'live';
    invocation: ReplayInvocation;
    model: string;
    worktree: string;
    lockfile: string | null;
    roleConfig: string | null;
    role: string | null;
    changed: string[];
    experimental: string[];
  },
): Promise<ExitCode> {
  const rerun = await deps.run(
    {
      tier: params.tier,
      trajectory: options.trajectory,
      model: params.model,
      worktree: params.worktree,
      lockfile: params.lockfile,
      roleConfig: params.roleConfig,
      role: params.role,
    },
    runtime,
  );
  const terminus: unknown = (rerun as { terminus: unknown }).terminus;
  const status = typeof terminus === 'string' ? terminus : 'unknown';
  const exitCode = replayTerminusToExitCode(terminus);
  const envelope: ReplayEnvelope = {
    ok: exitCode === EXIT_OK,
    exitCode,
    tier: params.tier,
    invocation: params.invocation,
    trajectory: options.trajectory,
    changed: params.changed,
    result: { status, summary: rerun.summary },
    ...(params.experimental.length === 0
      ? {}
      : { experimental: params.experimental }),
  };
  if (options.json) {
    deps.out(formatJson(envelope));
    return exitCode;
  }
  if (params.experimental.length > 0) {
    options.log.warn('--worktree is experimental');
  }
  deps.out(`tier: ${params.tier}`);
  deps.out(`invocation: ${params.invocation}`);
  deps.out(`model: ${params.model}`);
  deps.out(`worktree: ${params.worktree}`);
  deps.out(`result: ${status} — ${rerun.summary}`);
  return exitCode;
}
