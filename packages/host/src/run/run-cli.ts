// Headless `kubic run -p`.
// Non-interactive equivalent of the run: no alt-screen, no prompt,
// consumable output, exact exit codes. Host owns presentation only —
// the agent run itself is injected by the composition root (faux in tests,
// the lane in prod). This module imports the agent settlement
// kernel (pure outcome mapping) read-only — never the lane, the session
// store, or any TUI seam. Persistence (session+journal+usage+trajectory)
// flows through the injected persist hook identically for text and
// --json output.

import { SESSION_ID_PATTERN } from '@kubic/agent/lane/session-store';
import type { CommandResult } from '@kubic/core/cli/exit-codes';
import { EXIT_OK, EXIT_USAGE } from '@kubic/core/cli/exit-codes';
import type { CliIo } from '../cli/index.js';
import { diagnosticsOf, themeOf } from '../cli/index.js';
import type { HeadlessRunResult } from './run-result.js';
import {
  buildRunEnvelope,
  caughtRunResult,
  mapTerminusToExitCode,
} from './run-result.js';

// Live progress for a `kubic run` on
// an interactive terminal. The composition root builds the sink (stderr,
// spinner, kit rendering); the runner feeds it lane facts; the command
// hands it the settled result for the receipt. Absent means plain text
// everywhere (pipes, files, CI, `--json`).
export interface RunProgressSink {
  /**
   * The lane booted: heading and (when `notice`) the one-line no-isolation notice.
   * `role` is the `--role` name the run selected; absent for the default role.
   */
  begin(info: {
    readonly model?: string;
    readonly notice: boolean;
    readonly role?: string;
  }): void;
  toolStart(event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
  }): void;
  toolEnd(event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly isError: boolean;
    readonly entry?: unknown;
  }): void;
  /** The run settled: stop the spinner and clear its line. */
  settle(): void;
  /** After the answer: the receipt line and the next steps. */
  receipt(result: HeadlessRunResult, exitCode: number): void;
}

export interface RunCommandDeps extends CliIo {
  run: (
    prompt: string,
    options: {
      sessionId?: string;
      timeoutMs?: number;
      maxTurns?: number;
      // Skills surface: the parsed flags travel to the
      // runner, which owns discovery. `--no-skills` is a boolean request
      // (never a value); `--skill` is repeatable and additive.
      noSkills?: boolean;
      skills?: string[];
      // Role selection: forwarded to the runner, which
      // loads `.kubic/roles/<name>.md` and fails closed on a refusal.
      role?: string;
      // The explicit skill to invoke — forwarded to
      // the runner, which expands it against the booted (gated-visible)
      // skills and fails the run on an unknown name.
      invokeSkill?: string;
      // Debug channel: a boolean request is forwarded to the
      // runner, which owns the sink (stderr in prod). Never gates the run.
      debug?: boolean;
      // Forwarded to the runner's one enable path.
      dangerouslySkipApprovals?: boolean;
      // Explicit autonomous mode, recorded in session
      // metadata and the audit trail, driving RunMode.
      autonomous?: boolean;
      // The per-invocation tool selection.
      tools?: readonly string[];
      noTools?: boolean;
      // Live progress on an interactive terminal.
      progress?: RunProgressSink;
    },
  ) => Promise<HeadlessRunResult>;
  persist?: (result: HeadlessRunResult) => Promise<void> | void;
  onScreenMount?: () => void;
  // The interactive-terminal progress sink. Present only when
  // stdout AND stderr are a coloured TTY and the run is not `--json`.
  progress?: () => RunProgressSink;
}

// Default wall-clock bound for a headless run: a model that
// never stops thinking settles as `timeout` instead of
// hanging the process forever. Overridable per invocation with --timeout.
export const DEFAULT_RUN_TIMEOUT_MS = 300_000;

// setTimeout stores its delay in a 32-bit signed int: anything above this
// clamps to 1 ms (TimeoutOverflowWarning), so an accepted "bound" would
// fire almost immediately and misreport a timeout. Parse-time
// ceiling, not a clamp: a silently shortened bound is worse than a refusal.
export const MAX_RUN_TIMEOUT_MS = 2_147_483_647;

// The parsed `kubic run` invocation. commander owns the argv
// (apps/kubic/src/commands/session.ts): flag syntax, unknown flags and
// missing values are its usage errors (exit 2); the value rules below are
// this command's own semantics, applied as commander argument parsers.
export interface RunCommandOptions {
  readonly prompt: string;
  readonly session?: string;
  readonly timeoutMs?: number;
  readonly maxTurns?: number;
  readonly role?: string;
  readonly skills?: readonly string[];
  readonly noSkills?: boolean;
  // Invoke one explicit skill first (run only).
  readonly invokeSkill?: string;
  readonly debug?: boolean;
  readonly json?: boolean;
  // Session-scoped full access for this run's session.
  readonly dangerouslySkipApprovals?: boolean;
  // Explicit autonomous mode (off by default).
  readonly autonomous?: boolean;
  // `--tools <a,b>` / `--no-tools`.
  readonly tools?: readonly string[];
  readonly noTools?: boolean;
}

// A value the command refuses (exit 2). The message is the whole reason;
// the parser layer adds which flag carried it.
class RunArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunArgumentError';
  }
}

function positiveInt(value: string, max?: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RunArgumentError('need a positive integer');
  }
  if (max !== undefined && parsed > max) {
    throw new RunArgumentError(`max ${max}`);
  }
  return parsed;
}

// `--timeout <ms>`: a positive integer no larger than setTimeout's ceiling.
export function parseRunTimeout(value: string): number {
  return positiveInt(value, MAX_RUN_TIMEOUT_MS);
}

// `--max-turns <n>`: a positive integer.
export function parseRunMaxTurns(value: string): number {
  return positiveInt(value);
}

// `--session <id>` (and every other session-id argument): a path segment
// under the sessions root, so only [A-Za-z0-9_-] — never a traversal.
export function parseSessionIdArg(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new RunArgumentError('use [A-Za-z0-9_-]');
  }
  return value;
}

// `-p/--prompt <text>`: a non-empty prompt. A separate-token value that
// starts with `--` is the flagship typo (`kubic run -p --json`) and is
// refused; a prompt that really begins with `--` is written in the
// attached form (`--prompt=--text`), which the caller detects from argv.
// A value rule, not argv parsing: commander has already bound the token to
// `-p` (a required option-argument takes the next token unconditionally),
// so this refuses a bound value that is really a mistyped flag.
const FLAG_LIKE_VALUE = /^--/;

export function checkPromptValue(value: string, attached: boolean): string {
  if (value.trim() === '') throw new RunArgumentError('the prompt is empty');
  if (!attached && FLAG_LIKE_VALUE.test(value)) {
    throw new RunArgumentError(
      `${JSON.stringify(value)} looks like a flag, not a prompt — write a prompt that starts with '--' as --prompt=${shellQuote(value)}`,
    );
  }
  return value;
}

// POSIX single-quote escaping for suggested commands: nothing inside '…'
// expands ($, backticks, !), and an embedded ' becomes '\''.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runRunCommand(
  options: RunCommandOptions,
  deps: RunCommandDeps,
): Promise<CommandResult> {
  const log = diagnosticsOf(deps);
  // commander validated these already; re-checked because the session id
  // becomes a path segment and a direct caller skips the parser.
  if (
    options.session !== undefined &&
    !SESSION_ID_PATTERN.test(options.session)
  ) {
    log.error(
      `invalid --session id ${JSON.stringify(options.session)} (use [A-Za-z0-9_-])`,
    );
    return { exitCode: EXIT_USAGE };
  }
  if (options.prompt.trim() === '') {
    log.error('-p needs a value (the prompt is empty)');
    return { exitCode: EXIT_USAGE };
  }
  // Headless path never mounts an alt-screen; the hook exists only so
  // tests can fail closed if a future edit wires one in.
  void deps.onScreenMount;
  const skills = options.skills ?? [];
  const progress = options.json === true ? undefined : deps.progress?.();
  let result: HeadlessRunResult;
  try {
    result = await deps.run(options.prompt, {
      sessionId: options.session,
      timeoutMs: options.timeoutMs,
      maxTurns: options.maxTurns,
      ...(options.role === undefined ? {} : { role: options.role }),
      // The explicit skill invocation travels with
      // the run into the headless lane.
      ...(options.invokeSkill === undefined
        ? {}
        : { invokeSkill: options.invokeSkill }),
      ...(options.noSkills === true ? { noSkills: true } : {}),
      ...(skills.length === 0 ? {} : { skills: [...skills] }),
      ...(options.debug === true ? { debug: true } : {}),
      ...(options.dangerouslySkipApprovals === true
        ? { dangerouslySkipApprovals: true }
        : {}),
      ...(options.tools === undefined || options.tools.length === 0
        ? {}
        : { tools: [...options.tools] }),
      ...(options.noTools === true ? { noTools: true } : {}),
      ...(progress === undefined ? {} : { progress }),
    });
    await deps.persist?.(result);
  } catch (error) {
    result = caughtRunResult(options.session, error);
  }
  const exitCode = mapTerminusToExitCode(result.terminus, result.signal);
  if (options.json === true) {
    // One compact line, deliberately not pretty-printed: a script reads the
    // envelope as the LAST stdout line.
    deps.out(JSON.stringify(buildRunEnvelope(result, exitCode)));
    return { exitCode };
  }
  if (progress !== undefined) {
    // The interactive rendering. The answer is the command's
    // data (stdout); the receipt and next steps are presentation (stderr,
    // through the sink). The plain lines below stay for every other case.
    progress.settle();
    if (exitCode === EXIT_OK) {
      deps.out('');
      deps.out(result.summary);
      deps.out('');
    } else if (result.error !== undefined) {
      log.error(result.error.message);
    }
    progress.receipt(result, exitCode);
    return { exitCode };
  }
  if (result.error !== undefined) log.error(result.error.message);
  const theme = themeOf(deps);
  const label = (name: string): string => theme.muted(`${name}:`);
  const summary =
    exitCode === EXIT_OK
      ? theme.success(result.summary)
      : theme.error(result.summary);
  deps.out(`${label('result')} ${summary}`);
  deps.out(`${label('session')} ${theme.bold(result.sessionId)}`);
  deps.out(`${label('journal')} ${result.journalRef}`);
  deps.out(`${label('usage')} ${result.usageRef}`);
  deps.out(`${label('trajectory')} ${result.trajectoryRef}`);
  return { exitCode };
}
