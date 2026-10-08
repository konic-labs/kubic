// `kubic eval` / `kubic benchmark` command surface.
// Presentation only: parsed options in (commander, apps/kubic/src/
// commands/analysis.ts), exit code out. Suite execution and worktree
// checks arrive through injected deps (faux in tests); the CLI never
// touches the network, the model, or the filesystem.
// Exit codes: 0 pass/completed, 1 evaluated-and-failed, 2 usage/error.

import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  type ExitCode,
} from '../../core/src/cli/exit-codes.js';
import { type CliLogger, createLineLogger } from '../../core/src/cli/logger.js';
import { formatJson } from '../../core/src/cli/output.js';
import { renderTable } from '../../core/src/cli/table.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';
import { parseTrajectoryExport } from '../../trajectory/src/schema.js';
import type { EvalDeterminism, EvalRecord } from './records.js';
import {
  checkEvalProvenance,
  EvalRunnerError,
  type EvalTaskDeps,
  type EvalWorkspace,
  runEvalTask,
  runEvalTrajectory,
} from './runner.js';
import { resolveSuites } from './suites.js';

// The documented default model of a record (`--model` unset).
// The registered id of the shipped testing provider: the
// fixture suites run through the real lane, so the default must name a
// model the catalog actually holds. The host's faux provider registers
// `faux/echo` (FAUX_MODEL_REF); the eval package cannot import host (dep
// direction), so the ref is restated here.
export const EVAL_DEFAULT_MODEL = 'faux/echo';

export interface EvalCliDeps extends EvalTaskDeps {
  // `--trajectory <file>` reads the export through this
  // seam (the exec FileBridge in prod); `--trajectory -` reads stdin.
  // Absent means a path operand is refused by name (the inline-JSON form
  // stays available).
  readFile?: (path: string) => string;
  readStdin?: () => string;
  // stdout: the record line / matrix table, or the one `--json` envelope.
  out: (line: string) => void;
  // stderr: diagnostics — usage refusals and, off --json, runner errors as
  // `error: [code] message` (core/cli/logger).
  err: (line: string) => void;
  // Colour and the kit table for the human report; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  fancy?: boolean;
}

// The parsed `kubic eval` / `kubic benchmark` options (commander's
// `opts()`): raw strings, so the semantics (the workspace vocabulary, inline
// trajectory JSON) stay this module's, reported with this module's exit
// codes. commander owns the syntax: unknown flags, missing values, the
// required options, `--help`.
export interface EvalOptions {
  readonly suite?: string;
  readonly task?: string;
  readonly trajectory?: string;
  readonly workspace?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly worktree?: string;
  readonly size?: string;
  readonly json?: boolean;
}

// model/thinking/worktree stay undefined when their flag is absent: the
// --trajectory path takes them from the export; the --task and benchmark
// paths apply the defaults (EVAL_DEFAULT_MODEL, thinking null) and take the
// worktree from --worktree (see forTask).
interface Parsed {
  suite: string | undefined;
  task: string | undefined;
  trajectory: string | undefined;
  workspace: EvalWorkspace;
  model: string | undefined;
  thinking: string | undefined;
  worktree: string | undefined;
  size: string;
  json: boolean;
}

interface TaskProvenance {
  model: string;
  thinking: string | null;
  worktree: string;
}

// The --task / benchmark provenance: the flags are the only source for the
// worktree; the model defaults (documented default).
function forTask(parsed: Parsed): TaskProvenance {
  return {
    model: parsed.model ?? EVAL_DEFAULT_MODEL,
    thinking: parsed.thinking ?? null,
    worktree: parsed.worktree ?? '',
  };
}

const PLAIN = createCliTheme('none');

function loggerFor(options: EvalOptions, deps: EvalCliDeps): CliLogger {
  const theme = options.json === true ? PLAIN : (deps.errTheme ?? PLAIN);
  return createLineLogger(deps.err, { theme });
}

// Semantic validation shared by eval and benchmark: a usage message on
// failure (the caller logs it and exits 2), the normalized options else.
function normalize(options: EvalOptions): Parsed | string {
  const workspace = options.workspace ?? 'inline';
  if (workspace !== 'inline' && workspace !== 'worktree') {
    return '--workspace must be one of inline|worktree';
  }
  return {
    suite: options.suite,
    task: options.task,
    trajectory: options.trajectory,
    workspace,
    model: options.model,
    thinking: options.thinking,
    worktree: options.worktree,
    size: options.size ?? '',
    json: options.json === true,
  };
}

function emitRecord(
  out: (line: string) => void,
  record: EvalRecord,
  json: boolean,
): void {
  if (json) {
    // The envelope reports the record's own verdict: `ok` and
    // `exitCode` follow `record.success`, exactly like benchmark's
    // `{ok: allOk, exitCode}` — a gated-fail record must not print
    // `exitCode: 0` from a process that exits 1.
    out(
      formatJson({
        ok: record.success,
        exitCode: record.success ? EXIT_OK : EXIT_FAILED,
        record,
      }),
    );
    return;
  }
  out(
    `eval ok: suite ${record.suite} success=${String(record.success)} cost=${record.costUsd} tokens=${record.tokens} latencyMs=${record.latencyMs} tools=${record.toolCalls} model=${record.model} worktree=${record.worktree} size=${record.size} determinism=${record.determinism}`,
  );
}

function emitError(
  out: (line: string) => void,
  log: CliLogger,
  error: unknown,
  json: boolean,
): ExitCode {
  if (error instanceof EvalRunnerError) {
    if (json) {
      out(
        formatJson({
          ok: false,
          exitCode: EXIT_USAGE,
          error: { code: error.code, message: error.message },
        }),
      );
    } else {
      log.error(`[${error.code}] ${error.message}`);
    }
    return EXIT_USAGE;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    out(
      formatJson({
        ok: false,
        exitCode: EXIT_FAILED,
        error: { code: 'eval-failed', message },
      }),
    );
  } else {
    log.error(message);
  }
  return EXIT_FAILED;
}

// `--trajectory` takes a file path like `export` and
// `replay` do; `-` reads stdin; a value that starts with `{`/`[` is the
// pre inline-JSON form, kept for back-compat. Every failure is a named
// refusal: `trajectory-unreadable` (the read failed) or
// `trajectory-malformed` (not JSON, or not a valid export).
function loadTrajectoryInput(value: string, deps: EvalCliDeps): unknown {
  const trimmed = value.trim();
  const inline = trimmed.startsWith('{') || trimmed.startsWith('[');
  let raw: string;
  if (inline) {
    raw = trimmed;
  } else if (trimmed === '-') {
    if (deps.readStdin === undefined) {
      throw new EvalRunnerError(
        'trajectory-unreadable',
        '--trajectory - reads stdin, but this caller supplied no stdin reader',
      );
    }
    try {
      raw = deps.readStdin();
    } catch (error) {
      throw new EvalRunnerError(
        'trajectory-unreadable',
        `cannot read stdin: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    if (deps.readFile === undefined) {
      throw new EvalRunnerError(
        'trajectory-unreadable',
        `--trajectory ${JSON.stringify(value)} is a file path, but this caller supplied no file reader`,
      );
    }
    try {
      raw = deps.readFile(value);
    } catch (error) {
      throw new EvalRunnerError(
        'trajectory-unreadable',
        `cannot read trajectory ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new EvalRunnerError(
      'trajectory-malformed',
      inline
        ? `--trajectory inline JSON is malformed: ${error instanceof Error ? error.message : String(error)}`
        : `trajectory ${JSON.stringify(value)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseTrajectoryExport(parsed);
  } catch (error) {
    throw new EvalRunnerError(
      'trajectory-malformed',
      `trajectory ${JSON.stringify(value)} is not a valid export: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// kubic eval --task ... | --trajectory ....
export async function runEvalCommand(
  options: EvalOptions,
  deps: EvalCliDeps,
): Promise<CommandResult> {
  const log = loggerFor(options, deps);
  const parsed = normalize(options);
  if (typeof parsed === 'string') {
    log.error(parsed);
    return { exitCode: EXIT_USAGE };
  }
  if (parsed.suite === undefined) {
    log.error("required option '--suite <id>' not specified");
    return { exitCode: EXIT_USAGE };
  }
  // The selector is a suite id or a category alias
  // (`--suite swe`). eval scores ONE record, so a category with more than
  // one suite is refused by name rather than silently picking one.
  const selected = resolveSuites(parsed.suite);
  if (selected === undefined) {
    return {
      exitCode: emitError(
        deps.out,
        log,
        new EvalRunnerError(
          'unknown-suite',
          `unknown suite ${JSON.stringify(parsed.suite)}`,
        ),
        parsed.json,
      ),
    };
  }
  if (selected.length !== 1) {
    return {
      exitCode: emitError(
        deps.out,
        log,
        new EvalRunnerError(
          'ambiguous-suite',
          `--suite ${JSON.stringify(parsed.suite)} matches ${selected.length} suites — kubic eval scores one record; name the suite id`,
        ),
        parsed.json,
      ),
    };
  }
  const suiteId = (selected[0] as { id: string }).id;
  if (parsed.task === undefined && parsed.trajectory === undefined) {
    log.error('one of --task <prompt> or --trajectory <json> is required');
    return { exitCode: EXIT_USAGE };
  }
  try {
    if (parsed.trajectory !== undefined) {
      let payload: unknown;
      try {
        payload = loadTrajectoryInput(parsed.trajectory, deps);
      } catch (error) {
        if (error instanceof EvalRunnerError) {
          return { exitCode: emitError(deps.out, log, error, parsed.json) };
        }
        throw error;
      }
      const record = await runEvalTrajectory({
        suite: suiteId,
        trajectory: payload,
        ...(parsed.model === undefined ? {} : { model: parsed.model }),
        ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
        ...(parsed.worktree === undefined ? {} : { worktree: parsed.worktree }),
        size: parsed.size,
      });
      emitRecord(deps.out, record, parsed.json);
      return { exitCode: record.success ? EXIT_OK : EXIT_FAILED };
    }
    const provenance = forTask(parsed);
    const record = await runEvalTask(
      {
        suite: suiteId,
        task: parsed.task as string,
        ...provenance,
        size: parsed.size,
        workspace: parsed.workspace,
      },
      deps,
    );
    emitRecord(deps.out, record, parsed.json);
    return { exitCode: record.success ? EXIT_OK : EXIT_FAILED };
  } catch (error) {
    return { exitCode: emitError(deps.out, log, error, parsed.json) };
  }
}

export interface BenchmarkResult {
  suite: string;
  category: string;
  stub: boolean;
  skipped: boolean;
  success: boolean;
  // The executed row publishes the record's own
  // determinism tier; a skipped stub names the tier it would run at (live).
  determinism: EvalDeterminism;
  // Record fields on an executed row; absent on a stub.
  costUsd?: number;
  tokens?: number;
  latencyMs?: number;
  toolCalls?: number;
  model?: string;
  thinking?: string | null;
  worktree?: string;
}

// kubic benchmark [--suite <id>|all]: the reproducible
// matrix. Stub suites are reported skipped:true with success:false (never
// as passing work); exit 0 iff every executed suite succeeded — skipped
// stubs never count toward the verdict either way.
export async function runBenchmarkCommand(
  options: EvalOptions,
  deps: EvalCliDeps,
): Promise<CommandResult> {
  const log = loggerFor(options, deps);
  const parsed = normalize(options);
  if (typeof parsed === 'string') {
    log.error(parsed);
    return { exitCode: EXIT_USAGE };
  }
  const provenance = forTask(parsed);
  // Validate provenance once, before the matrix. A stub-only
  // selection never reaches runEvalTask (which owns this check), so without
  // it `benchmark --suite agentic-live` reported `ok` with no size or
  // worktree at all.
  try {
    checkEvalProvenance({ ...provenance, size: parsed.size });
  } catch (error) {
    if (error instanceof EvalRunnerError) {
      return { exitCode: emitError(deps.out, log, error, parsed.json) };
    }
    throw error;
  }
  // The selector is a suite id, a category alias
  // (`--suite swe` → every swe-category suite), or `all`/absent.
  const selected = resolveSuites(parsed.suite);
  if (selected === undefined) {
    return {
      exitCode: emitError(
        deps.out,
        log,
        new EvalRunnerError(
          'unknown-suite',
          `unknown suite ${JSON.stringify(parsed.suite)}`,
        ),
        parsed.json,
      ),
    };
  }
  const results: BenchmarkResult[] = [];
  for (const suite of selected) {
    if (suite.stub) {
      results.push({
        suite: suite.id,
        category: suite.category,
        stub: true,
        skipped: true,
        success: false,
        determinism: 'live',
      });
      continue;
    }
    try {
      const record = await runEvalTask(
        {
          suite: suite.id,
          task: parsed.task ?? `benchmark:${suite.id}`,
          ...provenance,
          size: parsed.size,
          workspace: parsed.workspace,
        },
        deps,
      );
      results.push({
        suite: suite.id,
        category: suite.category,
        stub: false,
        skipped: false,
        success: record.success,
        determinism: record.determinism,
        // Record fields: every executed row carries how it
        // ran, not just the verdict.
        costUsd: record.costUsd,
        tokens: record.tokens,
        latencyMs: record.latencyMs,
        toolCalls: record.toolCalls,
        model: record.model,
        thinking: record.thinking,
        worktree: record.worktree,
      });
    } catch (error) {
      // A named runner refusal keeps its code: a dirty
      // worktree is `dirty-worktree`, not a generic `eval-failed`; an
      // unnamed throw falls back to the benchmark's documented mapping. The
      // envelope also carries the rows already completed — a matrix that
      // dies on suite 3 still reports suites 1–2.
      const code =
        error instanceof EvalRunnerError ? error.code : 'eval-failed';
      const message = error instanceof Error ? error.message : String(error);
      if (parsed.json) {
        deps.out(
          formatJson({
            ok: false,
            exitCode: EXIT_USAGE,
            error: { code, message },
            results,
          }),
        );
      } else if (error instanceof EvalRunnerError) {
        log.error(`[${code}] ${message}`);
      } else {
        log.error(message);
      }
      return { exitCode: EXIT_USAGE };
    }
  }
  const executed = results.filter((r) => !r.skipped);
  // A matrix with no executable suite proves nothing — it is a
  // refusal (exit 2), never `benchmark ok` over an empty run.
  if (executed.length === 0) {
    return {
      exitCode: emitError(
        deps.out,
        log,
        new EvalRunnerError(
          'no-executable-suites',
          'benchmark: no executable suites selected',
        ),
        parsed.json,
      ),
    };
  }
  const allOk = executed.every((r) => r.success);
  const exit = allOk ? EXIT_OK : EXIT_FAILED;
  if (parsed.json) {
    deps.out(formatJson({ ok: allOk, exitCode: exit, results }));
    return { exitCode: exit };
  }
  const theme = deps.theme ?? PLAIN;
  const status = (r: BenchmarkResult): string =>
    r.skipped
      ? theme.muted('skipped (stub)')
      : r.success
        ? theme.success('pass')
        : theme.error('FAIL');
  deps.out(
    renderTable(
      results.map((r) => [r.suite, r.category, status(r)]),
      [{ header: 'SUITE' }, { header: 'CATEGORY' }, { header: 'STATUS' }],
      { fancy: deps.fancy === true, theme },
    ),
  );
  const verdict = `benchmark ${allOk ? 'ok' : 'FAILED'}: ${executed.filter((r) => r.success).length}/${executed.length} suites passed, ${results.length - executed.length} stub(s) skipped`;
  deps.out(allOk ? theme.success(verdict) : theme.error(verdict));
  return { exitCode: exit };
}
