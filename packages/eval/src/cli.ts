// `kubic eval` / `kubic benchmark` command surface (issue #53).
// Presentation only: parsed options in (commander, apps/kubic/src/
// commands/analysis.ts), exit code out. Suite execution and worktree
// checks arrive through injected deps (faux in tests); the CLI never
// touches the network, the model, or the filesystem.
// Exit codes: 0 pass/completed, 1 evaluated-and-failed, 2 usage/error.

import { type CliLogger, createLineLogger } from '../../core/src/cli/logger.js';
import { renderTable } from '../../core/src/cli/table.js';
import { type CliTheme, createCliTheme } from '../../core/src/cli/theme.js';
import type { EvalRecord } from './records.js';
import {
  EvalRunnerError,
  type EvalTaskDeps,
  type EvalWorkspace,
  runEvalTask,
  runEvalTrajectory,
} from './runner.js';
import { EVAL_SUITES, findSuite } from './suites.js';

export const EVAL_EXIT_OK = 0;
export const EVAL_EXIT_FAILED = 1;
export const EVAL_EXIT_USAGE = 2;

// The documented default model of a record (`--model` unset).
export const EVAL_DEFAULT_MODEL = 'faux/faux';

export interface EvalCliDeps extends EvalTaskDeps {
  // stdout: the record line / matrix table, or the one `--json` envelope.
  out: (line: string) => void;
  // stderr: diagnostics — usage refusals and, off --json, runner errors as
  // `error: [code] message` (core/cli/logger).
  err: (line: string) => void;
  // Colour and box drawing for the human report; absent means plain.
  theme?: CliTheme;
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
  readonly tier?: string;
  readonly json?: boolean;
}

interface Parsed {
  suite: string | undefined;
  task: string | undefined;
  trajectory: string | undefined;
  workspace: EvalWorkspace;
  model: string;
  thinking: string | null;
  worktree: string;
  generation: number;
  tier: string;
  json: boolean;
}

const PLAIN = createCliTheme('none');

function loggerFor(options: EvalOptions, deps: EvalCliDeps): CliLogger {
  const theme = options.json === true ? PLAIN : (deps.theme ?? PLAIN);
  return createLineLogger(deps.err, { theme });
}

// Semantic validation shared by eval and benchmark: a usage message on
// failure (the caller logs it and exits 2), the normalized options else.
function normalize(options: EvalOptions): Parsed | string {
  const workspace = options.workspace ?? 'inline';
  if (workspace !== 'inline' && workspace !== 'worktree') {
    return '--workspace must be one of inline|worktree';
  }
  if (options.generation === undefined) {
    return "required option '--generation <n>' not specified";
  }
  const generation = Number(options.generation);
  if (options.generation.trim() === '' || !Number.isInteger(generation)) {
    return '--generation needs an integer';
  }
  return {
    suite: options.suite,
    task: options.task,
    trajectory: options.trajectory,
    workspace,
    model: options.model ?? EVAL_DEFAULT_MODEL,
    thinking: options.thinking ?? null,
    worktree: options.worktree ?? '',
    generation,
    tier: options.tier ?? '',
    json: options.json === true,
  };
}

function emitRecord(
  out: (line: string) => void,
  record: EvalRecord,
  json: boolean,
): void {
  if (json) {
    out(JSON.stringify({ ok: true, exitCode: EVAL_EXIT_OK, record }));
    return;
  }
  out(
    `eval ok: suite ${record.suite} success=${String(record.success)} cost=${record.costUsd} tokens=${record.tokens} latencyMs=${record.latencyMs} tools=${record.toolCalls} model=${record.model} worktree=${record.worktree} generation=${record.generation} tier=${record.tier}`,
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
        JSON.stringify({
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
      JSON.stringify({
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
  if (parsed.task === undefined && parsed.trajectory === undefined) {
    log.error('one of --task <prompt> or --trajectory <json> is required');
    return EVAL_EXIT_USAGE;
  }
  try {
    if (parsed.trajectory !== undefined) {
      let payload: unknown;
      try {
        payload = JSON.parse(parsed.trajectory) as unknown;
      } catch {
        log.error('--trajectory needs inline trajectory export JSON');
        return EVAL_EXIT_USAGE;
      }
      const record = await runEvalTrajectory({
        suite: parsed.suite,
        trajectory: payload,
        model: parsed.model,
        thinking: parsed.thinking,
        worktree: parsed.worktree,
        generation: parsed.generation,
        tier: parsed.tier,
      });
      emitRecord(deps.out, record, parsed.json);
      return record.success ? EVAL_EXIT_OK : EVAL_EXIT_FAILED;
    }
    const record = await runEvalTask(
      {
        suite: parsed.suite,
        task: parsed.task as string,
        model: parsed.model,
        thinking: parsed.thinking,
        worktree: parsed.worktree,
        generation: parsed.generation,
        tier: parsed.tier,
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
  const selected =
    parsed.suite === undefined
      ? [...EVAL_SUITES]
      : (() => {
          const one = findSuite(parsed.suite);
          if (one === undefined) {
            log.error(
              `[unknown-suite] unknown suite ${JSON.stringify(parsed.suite)}`,
            );
            return null;
          }
          return [one];
        })();
  if (selected === null) return EVAL_EXIT_USAGE;
  const results: BenchmarkResult[] = [];
  for (const suite of selected) {
    if (suite.stub) {
      results.push({
        suite: suite.id,
        category: suite.category,
        stub: true,
        skipped: true,
        success: false,
      });
      continue;
    }
    try {
      const record = await runEvalTask(
        {
          suite: suite.id,
          task: parsed.task ?? `benchmark:${suite.id}`,
          model: parsed.model,
          thinking: parsed.thinking,
          worktree: parsed.worktree,
          generation: parsed.generation,
          tier: parsed.tier,
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (parsed.json) {
        deps.out(
          JSON.stringify({
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
  const allOk = results.filter((r) => !r.skipped).every((r) => r.success);
  const exit = allOk ? EVAL_EXIT_OK : EVAL_EXIT_FAILED;
  if (parsed.json) {
    deps.out(JSON.stringify({ ok: allOk, exitCode: exit, results }));
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
  const executed = results.filter((r) => !r.skipped);
  const verdict = `benchmark ${allOk ? 'ok' : 'FAILED'}: ${executed.filter((r) => r.success).length}/${executed.length} suites passed, ${results.length - executed.length} stub(s) skipped`;
  deps.out(allOk ? theme.success(verdict) : theme.error(verdict));
  return exit;
}
