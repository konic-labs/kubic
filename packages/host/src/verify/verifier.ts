// The run verifier (gate signals, Trajectory →
// Verifier → Reward). The gates (tests, build, lint, typecheck) are
// observed, not labelled by hand: the configured `[verify]` commands run
// through the exec seam in the run's worktree after the run settles —
// `sh -c <command>` in its own process group, killed at the timeout. Exit 0
// is pass; any other exit, a spawn failure or a timeout is fail. A gate
// without a command is left out, so it stays `unknown` — a verdict is never
// invented.
//
// verifierLabels turns the results into the trajectory eval labels the eval
// package reads (packages/eval/src/signals.ts): `signal:<gate>`, plus
// `signal:regression` when a baseline run at the base revision exists.
import type { ExecutionEnv } from '../../../exec/src/env.js';

export const VERIFY_GATES = ['tests', 'build', 'lint', 'typecheck'] as const;
type VerifyGate = (typeof VERIFY_GATES)[number];
type GateVerdict = 'pass' | 'fail';
export type VerifyResults = Partial<Record<VerifyGate, GateVerdict>>;

export type VerifyCommands = Partial<Record<VerifyGate, string>>;

// A gate command's bound when config sets none: a whole test suite is
// allowed to take minutes, never forever.
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

// Output is only needed to know the command ran; keep the cap small.
const VERIFY_OUTPUT_BYTES = 64 * 1024;

export function hasVerifyCommands(
  commands: VerifyCommands | undefined,
): boolean {
  if (commands === undefined) return false;
  return VERIFY_GATES.some((gate) => (commands[gate] ?? '').trim() !== '');
}

async function runGate(
  env: ExecutionEnv,
  command: string,
  timeoutMs: number,
): Promise<GateVerdict> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const handle = env.shell.spawn('sh', ['-c', command], {
      provenance: env.provenance,
      maxOutputBytes: VERIFY_OUTPUT_BYTES,
    });
    timer = setTimeout(() => {
      timedOut = true;
      handle.kill();
    }, timeoutMs);
    const result = await handle.wait();
    return !timedOut && result.exitCode === 0 ? 'pass' : 'fail';
  } catch {
    // The command could not run at all: the gate is not green.
    return 'fail';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Gates run one after another (a build and its tests share the tree), in
// VERIFY_GATES order.
export async function runVerifier(
  env: ExecutionEnv,
  commands: VerifyCommands,
  options: { timeoutMs?: number } = {},
): Promise<VerifyResults> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const results: VerifyResults = {};
  for (const gate of VERIFY_GATES) {
    const command = commands[gate];
    if (command === undefined || command.trim() === '') continue;
    results[gate] = await runGate(env, command, timeoutMs);
  }
  return results;
}

// Trajectory eval labels for the verified gates. With a baseline (the same
// commands at the base revision), `signal:regression` is `fail` when any
// gate that passed at base fails now, `pass` when at least one gate was
// compared and none regressed, and absent when nothing was comparable.
export function verifierLabels(
  current: VerifyResults,
  baseline?: VerifyResults,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const gate of VERIFY_GATES) {
    const verdict = current[gate];
    if (verdict !== undefined) labels[`signal:${gate}`] = verdict;
  }
  if (baseline === undefined) return labels;
  const compared = VERIFY_GATES.filter(
    (gate) => current[gate] !== undefined && baseline[gate] !== undefined,
  );
  if (compared.length === 0) return labels;
  const regressed = compared.some(
    (gate) => baseline[gate] === 'pass' && current[gate] === 'fail',
  );
  labels['signal:regression'] = regressed ? 'fail' : 'pass';
  return labels;
}
