// `--help` is one convention across every shipped command (issue #100):
// print the command's usage line and exit 0. Before this, `--help` was
// handled seven different ways (exit 0 with usage, exit 0 with unrelated
// output, exit 1, exit 2 with an unknown-flag error, or a usage line with
// no help handling at all), so an operator could not predict the outcome.
//
// The scan is behavioural, not textual: every handler is invoked with
// `--help` against deps that THROW if a work path is reached, so a
// handler that only pretends to short-circuit fails here. Usage *errors*
// (unknown flag, missing value) keep their own exit codes — this file
// pins the request path only.
import { describe, expect, it } from 'vitest';
import { runTuiCommand } from '../../../apps/kubic/src/tui-run.js';
import { runBenchmarkCommand, runEvalCommand } from '../../eval/src/cli.js';
import { runExportCommand } from '../../eval/src/export-cli.js';
import { runDoctorCommand } from './doctor.js';
import { runGitCommand } from './git-cli.js';
import { runJournalCommand } from './journal-cli.js';
import { runModelsCommand } from './models-cli.js';
import { runCostCommand } from './ops/cost/cost-cli.js';
import { runPerfCommand } from './ops/perf/perf-cli.js';
import { runOrchestrateCommand } from './orchestrate-cli.js';
import { runCleanCommand } from './orchestrator/worktree/clean.js';
import { runAuditCommand } from './policy/audit-cli.js';
import { runPolicyCommand } from './policy/policy-cli.js';
import { runReplayCommand } from './replay/replay.js';
import { runRunCommand } from './run-cli.js';
import { runSessionsCommand } from './sessions-cli.js';
import { runWorkersCommand } from './workers-cli.js';

const USAGE_PREFIX = 'usage: kubic';

// Any deps call that would mean the handler started working instead of
// answering the help request. Reaching one is a failure, not a stub.
function never<T>(what: string): T {
  return (() => {
    throw new Error(`--help must not reach ${what}`);
  }) as unknown as T;
}

interface Case {
  command: string;
  // Runs the handler for one argv; returns the exit code.
  run: (
    args: string[],
    out: (line: string) => void,
  ) => number | Promise<number>;
}

const CASES: Case[] = [
  {
    command: 'run',
    run: (args, out) =>
      runRunCommand(args, { out, run: never('the run path') }),
  },
  {
    command: 'orchestrate',
    run: (args, out) =>
      runOrchestrateCommand(args, {
        out,
        isGitRepo: never('the git probe'),
        ensureWorktree: never('worktree creation'),
        createWorkerSession: never('session creation'),
        runWorker: never('the worker spawn'),
        mergeBranch: never('the merge'),
        reapWorker: never('the reap'),
      }),
  },
  {
    command: 'clean',
    run: (args, out) =>
      runCleanCommand(args, {
        out,
        env: never('the execution env'),
      }),
  },
  {
    command: 'tui',
    run: (args, out) =>
      runTuiCommand(args, {
        out,
        createTerminal: never('the terminal'),
        bootLane: never('the lane boot'),
      }),
  },
  {
    command: 'sessions',
    run: (args, out) => runSessionsCommand(args, { out }),
  },
  {
    command: 'git',
    run: (args, out) =>
      runGitCommand(args, { out, env: never('the execution env') }),
  },
  {
    command: 'models',
    run: (args, out) =>
      runModelsCommand(args, { out, models: never('the model catalog') }),
  },
  // diff/undo/log/status are one handler; the subcommand is argv[0].
  ...['diff', 'undo', 'log', 'status'].map((sub) => ({
    command: sub,
    run: (args: string[], out: (line: string) => void) =>
      runJournalCommand([sub, ...args], { out }),
  })),
  {
    command: 'doctor',
    run: (args, out) =>
      runDoctorCommand(args, {
        out,
        probeProviders: never('the provider probe'),
        checkDeps: never('the dep probe'),
        loadPolicy: never('the policy load'),
      }),
  },
  {
    command: 'workers',
    run: (args, out) =>
      runWorkersCommand(args, { out, list: never('the worker registry') }),
  },
  {
    command: 'eval',
    run: (args, out) =>
      runEvalCommand(args, { out, runSuite: never('the suite runner') }),
  },
  {
    command: 'benchmark',
    run: (args, out) =>
      runBenchmarkCommand(args, { out, runSuite: never('the suite runner') }),
  },
  {
    command: 'replay',
    run: (args, out) =>
      runReplayCommand(args, { out, run: never('the replay run') }),
  },
  {
    command: 'export',
    run: (args, out) =>
      runExportCommand(args, { out, readFile: never('the file read') }),
  },
  {
    command: 'cost',
    run: (args, out) =>
      runCostCommand(args, { out, loadRows: never('the session store') }),
  },
  {
    command: 'perf',
    run: (args, out) => runPerfCommand(args, { out }),
  },
  {
    command: 'policy',
    run: (args, out) =>
      runPolicyCommand(args, { out, resolvePolicy: never('the policy load') }),
  },
  {
    command: 'audit',
    run: (args, out) =>
      runAuditCommand(args, { out, loadRecords: never('the audit store') }),
  },
];

describe('--help convention (issue #100)', () => {
  it('covers every shipped command', () => {
    // The 21 commands the binary dispatches; a new command must be added
    // here or it ships without the convention.
    expect(CASES.map((c) => c.command)).toEqual([
      'run',
      'orchestrate',
      'clean',
      'tui',
      'sessions',
      'git',
      'models',
      'diff',
      'undo',
      'log',
      'status',
      'doctor',
      'workers',
      'eval',
      'benchmark',
      'replay',
      'export',
      'cost',
      'perf',
      'policy',
      'audit',
    ]);
  });

  for (const flag of ['--help', '-h']) {
    it(`every command answers ${flag} with a usage line and exit 0`, async () => {
      const failures: string[] = [];
      for (const testCase of CASES) {
        const lines: string[] = [];
        const out = (line: string): void => {
          lines.push(line);
        };
        let code: number;
        try {
          code = await testCase.run([flag], out);
        } catch (error) {
          failures.push(
            `${testCase.command} ${flag}: threw ${(error as Error).message}`,
          );
          continue;
        }
        if (code !== 0) {
          failures.push(`${testCase.command} ${flag}: exit ${code}, want 0`);
          continue;
        }
        const usage = lines.filter((line) => line.startsWith(USAGE_PREFIX));
        if (usage.length !== 1) {
          failures.push(
            `${testCase.command} ${flag}: ${usage.length} usage line(s), want exactly 1 (got ${JSON.stringify(lines)})`,
          );
          continue;
        }
        if (!usage[0].includes(testCase.command)) {
          failures.push(
            `${testCase.command} ${flag}: usage line ${JSON.stringify(usage[0])} does not name the command`,
          );
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('keeps usage errors on their own exit codes (help did not swallow them)', async () => {
    // The convention covers the REQUEST, not errors: an unknown flag must
    // still fail. `run` is the reference — its usage errors are 2.
    const lines: string[] = [];
    const code = await runRunCommand(['--nope'], {
      out: (line: string) => lines.push(line),
      run: never('the run path'),
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('unknown flag --nope');
  });
});
