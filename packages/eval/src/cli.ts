// `kubic eval` / `kubic benchmark` command surface (issue #53).
// Presentation only: parsed options in (commander, apps/kubic/src/
// commands/analysis.ts), exit code out. Suite execution and worktree
// checks arrive through injected deps (faux in tests); the CLI never
// touches the network, the model, or the filesystem.
// Exit codes: 0 pass/completed, 1 evaluated-and-failed, 2 usage/error.

import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
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

export const EVAL_EXIT_OK = EXIT_OK;
export const EVAL_EXIT_FAILED = EXIT_FAILED;
export const EVAL_EXIT_USAGE = EXIT_USAGE;

// The documented default model of a record (`--model` unset).
// The registered id of the shipped testing provider (issue #262): the
// fixture suites run through the real lane, so the default must name a
// model the catalog actually holds. The host's faux provider registers
// `faux/echo` (FAUX_MODEL_REF); the eval package cannot import host (dep
// direction), so the ref is restated here.
export const EVAL_DEFAULT_MODEL = 'faux/echo';

export interface EvalCliDeps extends EvalTaskDeps {
  // §48 (issue #258): `--trajectory <file>` reads the export through this
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
  // Colour and box drawing for the human report; absent means plain.
  theme?: CliTheme;
  // Colour of the stderr diagnostics, from stderr's own TTY state (never
  // stdout's); absent means plain.
  errTheme?: CliTheme;
  fancy?: boolean;
}

// The parsed `kubic eval` / `kubic benchmark` options (commander's
// `opts()`): raw strings, so the semantics (the workspace vocabulary, the
// integer generation, inline trajectory JSON) stay this module's, reported
// with this module's exit codes. commander owns the syntax: unknown flags,
// missing values, the required options, `--help`.
export interface EvalOptions {
  readonly suite?: string;
  readonly task?: string;
  readonly trajectory?: string;
  readonly workspace?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly worktree?: string;
  readonly generation?: string;
  readonly size?: string;
  readonly json?: boolean;
}

// model/thinking/worktree/generation stay undefined when their flag is
// absent: the --trajectory path takes them from the export (§48, #256);
// the --task and benchmark paths apply the defaults (EVAL_DEFAULT_MODEL,
// thinking null) and require the rest (see forTask).
interface Parsed {
  suite: string | undefined;
  task: string | undefined;
  trajectory: string | undefined;
  workspace: EvalWorkspace;
  model: string | undefined;
  thinking: string | undefined;
  worktree: string | undefined;
  generation: number | undefined;
  size: string;
  json: boolean;
}

interface TaskProvenance {
  model: string;
  thinking: string | null;
  worktree: string;
  generation: number;
}

const MISSING_GENERATION = "required option '--generation <n>' not specified";

// The --task / benchmark provenance: the flags are the only source, so the
// generation is required and the model defaults (documented default).
function forTask(parsed: Parsed): TaskProvenance | string {
  if (parsed.generation === undefined) return MISSING_GENERATION;
  return {
    model: parsed.model ?? EVAL_DEFAULT_MODEL,
    thinking: parsed.thinking ?? null,
    worktree: parsed.worktree ?? '',
    generation: parsed.generation,
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
  let generation: number | undefined;
  if (options.generation !== undefined) {
    generation = Number(options.generation);
    if (options.generation.trim() === '' || !Number.isInteger(generation)) {
      return '--generation needs an integer';
    }
  }
  return {
    suite: options.suite,
    task: options.task,
    trajectory: options.trajectory,
    workspace,
    model: options.model,
    thinking: options.thinking,
    worktree: options.worktree,
    generation,
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
    // The envelope reports the record's own verdict (issue #370): `ok` and
    // `exitCode` follow `record.success`, exactly like benchmark's
    // `{ok: allOk, exitCode}` — a gated-fail record must not print
    // `exitCode: 0` from a process that exits 1.
    out(
      formatJson({
        ok: record.success,
        exitCode: record.success ? EVAL_EXIT_OK : EVAL_EXIT_FAILED,
        record,
      }),
    );
    return;
  }
  out(
    `eval ok: suite ${record.suite} success=${String(record.success)} cost=${record.costUsd} tokens=${record.tokens} latencyMs=${record.latencyMs} tools=${record.toolCalls} model=${record.model} worktree=${record.worktree} generation=${record.generation} size=${record.size} determinism=${record.determinism}`,
  );
}

function emitError(
  out: (line: string) => void,
  log: CliLogger,
  error: unknown,
  json: boolean,
): number {
  if (error instanceof EvalRunnerError) {
    if (json) {
      out(
        formatJson({
          ok: false,
          exitCode: EVAL_EXIT_USAGE,
          error: { code: error.code, message: error.message },
        }),
      );
    } else {
      log.error(`[${error.code}] ${error.message}`);
    }
    return EVAL_EXIT_USAGE;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    out(
      formatJson({
        ok: false,
        exitCode: EVAL_EXIT_FAILED,
        error: { code: 'eval-failed', message },
      }),
    );
  } else {
    log.error(message);
  }
  return EVAL_EXIT_FAILED;
}

// §48 (issue #258): `--trajectory` takes a file path like `export` and
// `replay` do; `-` reads stdin; a value that starts with `{`/`[` is the
// pre-#258 inline-JSON form, kept for back-compat. Every failure is a named
// refusal: `trajectory-unreadable` (the read failed) or
// `trajectory-malformed` (not JSON, or not a valid §46 export).
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
      `trajectory ${JSON.stringify(value)} is not a valid §46 export: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// kubic eval --task ... | --trajectory ... (design §48).
export async function runEvalCommand(
  options: EvalOptions,
  deps: EvalCliDeps,
): Promise<number> {
  const log = loggerFor(options, deps);
  const parsed = normalize(options);
  if (typeof parsed === 'string') {
    log.error(parsed);
    return EVAL_EXIT_USAGE;
  }
  if (parsed.suite === undefined) {
    log.error("required option '--suite <id>' not specified");
    return EVAL_EXIT_USAGE;
  }
  // Issue #262 (§73): the selector is a suite id or a category alias
  // (`--suite swe`). eval scores ONE record, so a category with more than
  // one suite is refused by name rather than silently picking one.
  const selected = resolveSuites(parsed.suite);
  if (selected === undefined) {
    return emitError(
      deps.out,
      log,
      new EvalRunnerError(
        'unknown-suite',
        `unknown suite ${JSON.stringify(parsed.suite)}`,
      ),
      parsed.json,
    );
  }
  if (selected.length !== 1) {
    return emitError(
      deps.out,
      log,
      new EvalRunnerError(
        'ambiguous-suite',
        `--suite ${JSON.stringify(parsed.suite)} matches ${selected.length} suites — kubic eval scores one record; name the suite id`,
      ),
      parsed.json,
    );
  }
  const suiteId = (selected[0] as { id: string }).id;
  if (parsed.task === undefined && parsed.trajectory === undefined) {
    log.error('one of --task <prompt> or --trajectory <json> is required');
    return EVAL_EXIT_USAGE;
  }
  try {
    if (parsed.trajectory !== undefined) {
      let payload: unknown;
      try {
        payload = loadTrajectoryInput(parsed.trajectory, deps);
      } catch (error) {
        if (error instanceof EvalRunnerError) {
          return emitError(deps.out, log, error, parsed.json);
        }
        throw error;
      }
      const record = await runEvalTrajectory({
        suite: suiteId,
        trajectory: payload,
        ...(parsed.model === undefined ? {} : { model: parsed.model }),
        ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
        ...(parsed.worktree === undefined ? {} : { worktree: parsed.worktree }),
        ...(parsed.generation === undefined
          ? {}
          : { generation: parsed.generation }),
        size: parsed.size,
      });
      emitRecord(deps.out, record, parsed.json);
      return record.success ? EVAL_EXIT_OK : EVAL_EXIT_FAILED;
    }
    const provenance = forTask(parsed);
    if (typeof provenance === 'string') {
      log.error(provenance);
      return EVAL_EXIT_USAGE;
    }
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
    return record.success ? EVAL_EXIT_OK : EVAL_EXIT_FAILED;
  } catch (error) {
    return emitError(deps.out, log, error, parsed.json);
  }
}

export interface BenchmarkResult {
  suite: string;
  category: string;
  stub: boolean;
  skipped: boolean;
  success: boolean;
  // Issue #260 (§47.1/§72): the executed row publishes the record's own
  // determinism tier; a skipped stub names the tier it would run at (live).
  determinism: EvalDeterminism;
  // §73 record fields on an executed row (issue #262); absent on a stub.
  costUsd?: number;
  tokens?: number;
  latencyMs?: number;
  toolCalls?: number;
  model?: string;
  thinking?: string | null;
  worktree?: string;
  generation?: number;
}

// kubic benchmark [--suite <id>|all] (design §82): the reproducible
// matrix. Stub suites are reported skipped:true with success:false (never
// as passing work); exit 0 iff every executed suite succeeded — skipped
// stubs never count toward the verdict either way.
export async function runBenchmarkCommand(
  options: EvalOptions,
  deps: EvalCliDeps,
): Promise<number> {
  const log = loggerFor(options, deps);
  const parsed = normalize(options);
  if (typeof parsed === 'string') {
    log.error(parsed);
    return EVAL_EXIT_USAGE;
  }
  const provenance = forTask(parsed);
  if (typeof provenance === 'string') {
    log.error(provenance);
    return EVAL_EXIT_USAGE;
  }
  // Issue #264: validate provenance once, before the matrix. A stub-only
  // selection never reaches runEvalTask (which owns this check), so without
  // it `benchmark --suite agentic-live` reported `ok` with no size or
  // worktree at all.
  try {
    checkEvalProvenance({ ...provenance, size: parsed.size });
  } catch (error) {
    if (error instanceof EvalRunnerError) {
      return emitError(deps.out, log, error, parsed.json);
    }
    throw error;
  }
  // Issue #262 (§73): the selector is a suite id, a category alias
  // (`--suite swe` → every swe-category suite), or `all`/absent.
  const selected = resolveSuites(parsed.suite);
  if (selected === undefined) {
    return emitError(
      deps.out,
      log,
      new EvalRunnerError(
        'unknown-suite',
        `unknown suite ${JSON.stringify(parsed.suite)}`,
      ),
      parsed.json,
    );
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
        // §73 record fields (issue #262): every executed row carries how it
        // ran, not just the verdict.
        costUsd: record.costUsd,
        tokens: record.tokens,
        latencyMs: record.latencyMs,
        toolCalls: record.toolCalls,
        model: record.model,
        thinking: record.thinking,
        worktree: record.worktree,
        generation: record.generation,
      });
    } catch (error) {
      // A named runner refusal keeps its code (issue #262): a dirty
      // worktree is `dirty-worktree`, not a generic `eval-failed`. Only an
      // unnamed throw falls back to the benchmark's documented mapping.
      if (error instanceof EvalRunnerError) {
        return emitError(deps.out, log, error, parsed.json);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (parsed.json) {
        deps.out(
          formatJson({
            ok: false,
            exitCode: EVAL_EXIT_USAGE,
            error: { code: 'eval-failed', message },
          }),
        );
      } else {
        log.error(message);
      }
      return EVAL_EXIT_USAGE;
    }
  }
  const executed = results.filter((r) => !r.skipped);
  // Issue #264: a matrix with no executable suite proves nothing — it is a
  // refusal (exit 2), never `benchmark ok` over an empty run.
  if (executed.length === 0) {
    return emitError(
      deps.out,
      log,
      new EvalRunnerError(
        'no-executable-suites',
        'benchmark: no executable suites selected',
      ),
      parsed.json,
    );
  }
  const allOk = executed.every((r) => r.success);
  const exit = allOk ? EVAL_EXIT_OK : EVAL_EXIT_FAILED;
  if (parsed.json) {
    deps.out(formatJson({ ok: allOk, exitCode: exit, results }));
    return exit;
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
  return exit;
}
