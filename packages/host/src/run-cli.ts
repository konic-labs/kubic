// Headless `kubic run -p` (issue #28; §78, §17, §19, §80, §84).
// Non-interactive equivalent of the solo run: no alt-screen, no prompt,
// consumable output, exact §78 exit codes. Host owns presentation only —
// the agent run itself is injected by the composition root (faux in tests,
// the solo lane in prod). This module imports the worker settlement
// kernel (pure outcome mapping) read-only — never the lane, the session
// store, or any TUI seam. Persistence (session+journal+usage+trajectory)
// flows through the injected persist hook identically for text and
// --json output.

import { answerHelp } from '../../core/src/cli-help.js';
import { type FlagSpec, parseFlagArgs } from '../../core/src/flags.js';
import type { OperationErrorLike } from '../../worker/src/lane/settle.js';
import { settleTerminalStatus } from '../../worker/src/lane/settle.js';
import type { TerminalStatus } from '../../worker/src/pi-boundary.js';

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

// Lane outcome → §78 terminus (issue #28, E1). Read-only consumer of the
// worker settlement kernel: completed stays 0-bound, and a
// failed/cancelled run keeps the harness error classification
// (budget/approval/workspace/provider surface as 3/4/5/6-bound termini,
// everything else as failed). No budget or approval gate is enforced in
// the headless lane yet, so budget_exhausted/approval_denied fire only
// when the lane itself yields a classified error — until then they are
// covered by the contract tests, not by live runs.
export function mapLaneOutcomeToTerminus(
  status: TerminalStatus,
  error?: OperationErrorLike,
): RunTerminusKind {
  if (status === 'completed') return 'completed';
  const kind = settleTerminalStatus(status, error).error?.kind;
  if (kind === 'budget') return 'budget_exhausted';
  if (kind === 'approval') return 'approval_denied';
  if (kind === 'workspace') return 'workspace_unavailable';
  if (kind === 'provider') return 'provider_probe_failed';
  return 'failed';
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
    options: {
      sessionId?: string;
      timeoutMs?: number;
      maxTurns?: number;
      // §29.3 skills surface (issue #99): the parsed flags travel to the
      // runner, which owns discovery. `--no-skills` is a boolean request
      // (never a value); `--skill` is repeatable and additive.
      noSkills?: boolean;
      skills?: string[];
      // §12.1 role selection (issue #99): forwarded to the runner, which
      // loads `.kubic/roles/<name>.md` and fails closed on a refusal.
      role?: string;
      // §50 debug channel (issue #98): a boolean request is forwarded to the
      // runner, which owns the sink (stderr in prod). Never gates the run.
      debug?: boolean;
    },
  ) => Promise<HeadlessRunResult>;
  persist?: (result: HeadlessRunResult) => Promise<void> | void;
  onScreenMount?: () => void;
}

// Session ids are path segments under the sessions root: accept only
// [A-Za-z0-9_-] so --session can never escape into a path traversal.
// Checked here (exit 2) before any store attach is attempted.
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Default wall-clock bound for a headless run (issue #84): a model that
// never stops thinking settles as budget_exhausted instead of hanging
// the process forever. Overridable per invocation with --timeout.
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

// setTimeout stores its delay in a 32-bit signed int: anything above this
// clamps to 1 ms (TimeoutOverflowWarning), so an accepted "bound" would
// fire almost immediately and misreport budget_exhausted. Parse-time
// ceiling, not a clamp: a silently shortened bound is worse than a refusal.
export const MAX_RUN_TIMEOUT_MS = 2_147_483_647;

const RUN_USAGE =
  'usage: kubic run -p <prompt> [--] [--session <id>] [--timeout <ms>] [--max-turns <n>] [--role <name>] [--skill <path>] [--no-skills] [--debug] [--json]';

function usage(out: (line: string) => void): number {
  out(RUN_USAGE);
  return RUN_EXIT_USAGE;
}

// Issue #127: the shared parser (core/src/flags.ts) replaces the hand-rolled
// loop. The parser does syntax; this command keeps its semantics — the
// positive-int bounds, the session-id pattern, and the exact error lines
// below (output strings are part of the CLI contract).
const RUN_FLAG_SPEC: readonly FlagSpec[] = [
  { name: '--prompt', takes: 'value', aliases: ['-p'] },
  { name: '--session', takes: 'value' },
  { name: '--timeout', takes: 'value' },
  { name: '--max-turns', takes: 'value' },
  { name: '--role', takes: 'value' },
  { name: '--skill', takes: 'value', repeat: true },
  { name: '--no-skills', takes: 'boolean' },
  { name: '--debug', takes: 'boolean' },
  { name: '--json', takes: 'boolean' },
];

// One line per value flag, verbatim from the loop this replaced (the
// short-form spelling `-p` included: it is the documented flag name).
const RUN_MISSING_VALUE_MESSAGES: Readonly<Record<string, string>> = {
  '--prompt': 'error: -p needs a value',
  '--session': 'error: --session needs a value',
  '--timeout': 'error: --timeout needs a value',
  '--max-turns': 'error: --max-turns needs a value',
  '--role': 'error: --role needs a value',
  '--skill': 'error: --skill needs a value',
};

function parsePositiveInt(
  flag: string,
  value: string,
  out: (line: string) => void,
  max?: number,
): number | null {
  // null = unusable (error already reported); the caller exits 2.
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    out(
      `error: invalid ${flag} ${JSON.stringify(value)} (need a positive integer)`,
    );
    return null;
  }
  if (max !== undefined && parsed > max) {
    out(`error: invalid ${flag} ${JSON.stringify(value)} (max ${max})`);
    return null;
  }
  return parsed;
}

// Store/attach/runner rejections never escape past the CLI (E2): a
// workspace-flavored failure (attach of a missing session, ENOENT/EACCES
// on the sessions root, worktree problems) maps to workspace_unavailable
// (5); everything else maps to failed (1).
function isWorkspaceFailure(error: unknown): boolean {
  const record = error as { name?: unknown; code?: unknown };
  if (record.name === 'SessionAttachError') return true;
  // A live second attachment (issue #118) is the same class of failure as a
  // missing session: the workspace cannot host this run right now — the
  // named SessionLockError message carries the holder pid.
  if (record.name === 'SessionLockError') return true;
  const haystack = [
    record.code,
    record.name,
    error instanceof Error ? error.message : error,
  ]
    .map((part) => String(part ?? ''))
    .join(' ');
  return /workspace|worktree|ENOENT|ENOTDIR|EACCES|EPERM|EROFS|ENOSPC/i.test(
    haystack,
  );
}

// Caught (non-lane) failures → §78 terminus, shared with the composition
// root so the prod path maps store/attach errors identically (E2).
export function mapCaughtErrorToTerminus(error: unknown): RunTerminusKind {
  return isWorkspaceFailure(error) ? 'workspace_unavailable' : 'failed';
}

function runFailure(
  sessionId: string | undefined,
  error: unknown,
): HeadlessRunResult {
  const message = error instanceof Error ? error.message : String(error);
  const terminus = mapCaughtErrorToTerminus(error);
  const ref = sessionId ?? 'unassigned';
  return {
    terminus,
    summary: message,
    sessionId: ref,
    journalRef: `journal:${ref}`,
    usageRef: `usage:${ref}`,
    trajectoryRef: `trajectory:${ref}`,
    error: { kind: terminus, message },
  };
}

export async function runRunCommand(
  args: string[],
  deps: RunCommandDeps,
): Promise<number> {
  // `--help` is answered before any argv validation (issue #100).
  const help = answerHelp(args, deps.out, RUN_USAGE);
  if (help !== null) return help;
  const parsed = parseFlagArgs(args, RUN_FLAG_SPEC);
  const values = parsed.values;
  // `-p -- <prompt>` (issue #127): the end-of-flags terminator is the
  // escape hatch — the next raw token is the prompt, so a prompt that
  // begins with `--` is expressible. The typo rule is never weakened:
  // `kubic run -p --json` has no terminator, so `-p` is still missing.
  const operands = [...parsed.positional];
  let prompt = values['--prompt'] as string | undefined;
  if (prompt === undefined && args.includes('--') && operands.length > 0) {
    prompt = operands.shift();
  }
  // Missing values first, then unknown flags, then stray operands — each
  // keeps the exact line the old inline loop printed. A `-p` starved by a
  // flag-like token is the flagship typo (`kubic run -p --json`), so the
  // missing-value class is reported before the unknown class.
  for (const flag of parsed.missing) {
    if (flag === '--prompt' && prompt !== undefined) continue;
    deps.out(
      RUN_MISSING_VALUE_MESSAGES[flag] ?? `error: ${flag} needs a value`,
    );
    return RUN_EXIT_USAGE;
  }
  if (parsed.unknown.length > 0) {
    deps.out(`error: unknown flag ${parsed.unknown[0]}`);
    return RUN_EXIT_USAGE;
  }
  if (operands.length > 0) {
    // Operands are not part of this command's surface (the prompt is a
    // flag), so an unconsumed one is refused exactly like an unknown flag.
    deps.out(`error: unknown flag ${operands[0]}`);
    return RUN_EXIT_USAGE;
  }
  let timeoutMs: number | undefined;
  let maxTurns: number | undefined;
  const timeoutRaw = values['--timeout'] as string | undefined;
  if (timeoutRaw !== undefined) {
    const parsedTimeout = parsePositiveInt(
      '--timeout',
      timeoutRaw,
      deps.out,
      MAX_RUN_TIMEOUT_MS,
    );
    if (parsedTimeout === null) return RUN_EXIT_USAGE;
    timeoutMs = parsedTimeout;
  }
  const maxTurnsRaw = values['--max-turns'] as string | undefined;
  if (maxTurnsRaw !== undefined) {
    const parsedMaxTurns = parsePositiveInt(
      '--max-turns',
      maxTurnsRaw,
      deps.out,
    );
    if (parsedMaxTurns === null) return RUN_EXIT_USAGE;
    maxTurns = parsedMaxTurns;
  }
  if (prompt === undefined) return usage(deps.out);
  const sessionId = values['--session'] as string | undefined;
  const role = values['--role'] as string | undefined;
  const skills = (values['--skill'] as string[] | undefined) ?? [];
  const noSkills = values['--no-skills'] === true;
  const debug = values['--debug'] === true;
  const json = values['--json'] === true;
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    deps.out(
      `error: invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
    return RUN_EXIT_USAGE;
  }
  // Headless path never mounts an alt-screen; the hook exists only so
  // tests can fail closed if a future edit wires one in.
  void deps.onScreenMount;
  let result: HeadlessRunResult;
  try {
    result = await deps.run(prompt, {
      sessionId,
      timeoutMs,
      maxTurns,
      ...(role === undefined ? {} : { role }),
      ...(noSkills ? { noSkills: true } : {}),
      ...(skills.length === 0 ? {} : { skills: [...skills] }),
      ...(debug ? { debug: true } : {}),
    });
    await deps.persist?.(result);
  } catch (error) {
    result = runFailure(sessionId, error);
  }
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
