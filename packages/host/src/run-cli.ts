// Headless `kubic run -p` (issue #28; §78, §17, §19, §80, §84).
// Non-interactive equivalent of the solo run: no alt-screen, no prompt,
// consumable output, exact §78 exit codes. Host owns presentation only —
// the agent run itself is injected by the composition root (faux in tests,
// the solo lane in prod), so this module imports no worker implementation
// and no TUI seam. Persistence (session+journal+usage+trajectory) flows
// through the injected persist hook identically for text and --json output.

export const RUN_EXIT_OK = 0;
export const RUN_EXIT_FAILED = 1;
export const RUN_EXIT_USAGE = 2;
export const RUN_EXIT_BUDGET = 3;
export const RUN_EXIT_APPROVAL_DENIED = 4;
export const RUN_EXIT_WORKSPACE_UNAVAILABLE = 5;
export const RUN_EXIT_PROVIDER_PROBE_FAILED = 6;

export type RunTerminusKind =
  | 'completed'
  | 'failed'
  | 'usage'
  | 'budget_exhausted'
  | 'approval_denied'
  | 'approval_timed_out'
  | 'workspace_unavailable'
  | 'provider_probe_failed';

export function mapTerminusToExitCode(terminus: RunTerminusKind): number {
  switch (terminus) {
    case 'completed':
      return RUN_EXIT_OK;
    case 'failed':
      return RUN_EXIT_FAILED;
    case 'usage':
      return RUN_EXIT_USAGE;
    case 'budget_exhausted':
      return RUN_EXIT_BUDGET;
    case 'approval_denied':
    case 'approval_timed_out':
      return RUN_EXIT_APPROVAL_DENIED;
    case 'workspace_unavailable':
      return RUN_EXIT_WORKSPACE_UNAVAILABLE;
    case 'provider_probe_failed':
      return RUN_EXIT_PROVIDER_PROBE_FAILED;
  }
}

export interface HeadlessRunResult {
  terminus: RunTerminusKind;
  summary: string;
  sessionId: string;
  journalRef: string;
  usageRef: string;
  trajectoryRef: string;
  error?: { kind: string; message: string };
}

export interface RunEnvelope {
  ok: boolean;
  exitCode: number;
  sessionId: string;
  status: RunTerminusKind;
  result: { summary: string };
  journal: { ref: string };
  usage: { ref: string };
  trajectory: { ref: string };
  error?: { kind: string; message: string };
}

export function buildRunEnvelope(
  result: HeadlessRunResult,
  exitCode: number,
): RunEnvelope {
  return {
    ok: exitCode === RUN_EXIT_OK,
    exitCode,
    sessionId: result.sessionId,
    status: result.terminus,
    result: { summary: result.summary },
    journal: { ref: result.journalRef },
    usage: { ref: result.usageRef },
    trajectory: { ref: result.trajectoryRef },
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

export interface RunCommandDeps {
  out: (line: string) => void;
  run: (
    prompt: string,
    options: { sessionId?: string },
  ) => Promise<HeadlessRunResult>;
  persist?: (result: HeadlessRunResult) => Promise<void> | void;
  onScreenMount?: () => void;
}

function usage(out: (line: string) => void): number {
  out('usage: kubic run -p <prompt> [--session <id>] [--json]');
  return RUN_EXIT_USAGE;
}

export async function runRunCommand(
  args: string[],
  deps: RunCommandDeps,
): Promise<number> {
  let prompt: string | undefined;
  let sessionId: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '-p' || arg === '--prompt') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: -p needs a value');
        return RUN_EXIT_USAGE;
      }
      prompt = value;
      i += 1;
    } else if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --session needs a value');
        return RUN_EXIT_USAGE;
      }
      sessionId = value;
      i += 1;
    } else if (arg === '--json') {
      json = true;
    } else {
      deps.out(`error: unknown flag ${arg}`);
      return RUN_EXIT_USAGE;
    }
  }
  if (prompt === undefined) return usage(deps.out);
  // Headless path never mounts an alt-screen; the hook exists only so
  // tests can fail closed if a future edit wires one in.
  void deps.onScreenMount;
  const result = await deps.run(prompt, { sessionId });
  await deps.persist?.(result);
  const exitCode = mapTerminusToExitCode(result.terminus);
  if (json) {
    deps.out(JSON.stringify(buildRunEnvelope(result, exitCode)));
    return exitCode;
  }
  if (result.error !== undefined) deps.out(`error: ${result.error.message}`);
  deps.out(`result: ${result.summary}`);
  deps.out(`session: ${result.sessionId}`);
  deps.out(`journal: ${result.journalRef}`);
  deps.out(`usage: ${result.usageRef}`);
  deps.out(`trajectory: ${result.trajectoryRef}`);
  return exitCode;
}
