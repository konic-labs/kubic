// `kubic eval` / `kubic benchmark` command surface (issue #53).
// Presentation only: argv in, exit code out. Suite execution and worktree
// checks arrive through injected deps (faux in tests); the CLI never
// touches the network, the model, or the filesystem.
// Exit codes: 0 pass/completed, 1 evaluated-and-failed, 2 usage/error.

import { answerHelp } from '../../core/src/cli-help.js';
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

export interface EvalCliDeps extends EvalTaskDeps {
  out: (line: string) => void;
}

interface Parsed {
  suite: string | undefined;
  task: string | undefined;
  trajectory: string | undefined;
  workspace: EvalWorkspace;
  workspaceInvalid: boolean;
  model: string;
  thinking: string | null;
  worktree: string;
  generation: number | undefined;
  tier: string;
  json: boolean;
}

function parseArgs(args: string[]): Parsed {
  const parsed: Parsed = {
    suite: undefined,
    task: undefined,
    trajectory: undefined,
    workspace: 'inline',
    workspaceInvalid: false,
    model: 'faux/faux',
    thinking: null,
    worktree: '',
    generation: undefined,
    tier: '',
    json: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const next = args[i + 1];
    const take = (): string | undefined => {
      i += 1;
      return next;
    };
    if (arg === '--suite') parsed.suite = take();
    else if (arg === '--task') parsed.task = take();
    else if (arg === '--trajectory') parsed.trajectory = take();
    else if (arg === '--workspace') {
      const value = take();
      if (value === 'inline' || value === 'worktree') parsed.workspace = value;
      else parsed.workspaceInvalid = true;
    } else if (arg === '--model') parsed.model = take() ?? parsed.model;
    else if (arg === '--thinking') parsed.thinking = take() ?? null;
    else if (arg === '--worktree') parsed.worktree = take() ?? '';
    else if (arg === '--generation') {
      const raw = take();
      const n = raw === undefined ? Number.NaN : Number(raw);
      parsed.generation = Number.isInteger(n) ? n : undefined;
    } else if (arg === '--tier') parsed.tier = take() ?? '';
    else if (arg === '--json') parsed.json = true;
  }
  return parsed;
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
      out(`eval error [${error.code}]: ${error.message}`);
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
    out(`eval error: ${message}`);
  }
  return EVAL_EXIT_FAILED;
}

const EVAL_USAGE =
  'usage: kubic eval (--task <prompt> | --trajectory <json>) --suite <id> --model <id> --worktree <path> --generation <n> --tier <smoke|standard|extended> [--workspace inline|worktree] [--thinking <level>] [--json]';

const BENCHMARK_USAGE =
  'usage: kubic benchmark [--suite <id>] --model <id> --worktree <path> --generation <n> --tier <smoke|standard|extended> [--workspace inline|worktree] [--thinking <level>] [--json]';

function usage(out: (line: string) => void): number {
  out(EVAL_USAGE);
  return EVAL_EXIT_USAGE;
}

// kubic eval --task ... | --trajectory ... (design §48).
export async function runEvalCommand(
  args: string[],
  deps: EvalCliDeps,
): Promise<number> {
  // `--help`/`-h` prints the usage line and exits 0 (issue #100).
  const help = answerHelp(args, deps.out, EVAL_USAGE);
  if (help !== null) return help;
  const parsed = parseArgs(args);
  if (parsed.workspaceInvalid) {
    deps.out('usage: --workspace must be one of inline|worktree');
    return EVAL_EXIT_USAGE;
  }
  if (
    parsed.suite === undefined ||
    (parsed.task === undefined && parsed.trajectory === undefined) ||
    parsed.generation === undefined
  ) {
    return usage(deps.out);
  }
  try {
    if (parsed.trajectory !== undefined) {
      let payload: unknown = parsed.trajectory;
      try {
        payload = JSON.parse(parsed.trajectory) as unknown;
      } catch {
        return usage(deps.out);
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
    return emitError(deps.out, error, parsed.json);
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
  args: string[],
  deps: EvalCliDeps,
): Promise<number> {
  // `--help`/`-h` prints the usage line and exits 0 (issue #100).
  const help = answerHelp(args, deps.out, BENCHMARK_USAGE);
  if (help !== null) return help;
  const parsed = parseArgs(args);
  if (parsed.workspaceInvalid) {
    deps.out('usage: --workspace must be one of inline|worktree');
    return EVAL_EXIT_USAGE;
  }
  if (parsed.generation === undefined) {
    deps.out(BENCHMARK_USAGE);
    return EVAL_EXIT_USAGE;
  }
  const selected =
    parsed.suite === undefined
      ? [...EVAL_SUITES]
      : (() => {
          const one = findSuite(parsed.suite);
          if (one === undefined) {
            deps.out(
              `benchmark error [unknown-suite]: unknown suite ${JSON.stringify(parsed.suite)}`,
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
        deps.out(`benchmark error: ${message}`);
      }
      return EVAL_EXIT_USAGE;
    }
  }
  const allOk = results.filter((r) => !r.skipped).every((r) => r.success);
  const exit = allOk ? EVAL_EXIT_OK : EVAL_EXIT_FAILED;
  if (parsed.json) {
    deps.out(JSON.stringify({ ok: allOk, exitCode: exit, results }));
  } else {
    for (const r of results) {
      deps.out(
        `benchmark ${r.skipped ? 'skipped (stub)' : r.success ? 'pass' : 'FAIL'}: ${r.suite} [${r.category}]`,
      );
    }
    deps.out(
      `benchmark ${allOk ? 'ok' : 'FAILED'}: ${results.filter((r) => !r.skipped && r.success).length}/${results.filter((r) => !r.skipped).length} suites passed, ${results.filter((r) => r.skipped).length} stub(s) skipped`,
    );
  }
  return exit;
}
