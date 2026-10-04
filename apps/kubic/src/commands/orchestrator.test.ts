// The orchestrator-mode command group on commander (orchestrate, clean,
// workers): argv syntax, `--help`, value validation and exit codes are the
// program's; the handlers receive typed options. Every case runs the real
// program over fake runners — zero git, zero processes.
import { describe, expect, it } from 'vitest';
import type { CommandContext, DispatchRunners } from '../cli/context.js';
import { createKubicProgram, runKubicProgram } from '../cli/program.js';
import type { CliConfigResult } from '../config-runtime.js';
import { registerOrchestratorCommands } from './orchestrator.js';

const CONFIG = { source: 'test' } as unknown as CliConfigResult;

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly calls: { runner: string; args: unknown; config: unknown }[];
}

async function run(
  argv: readonly string[],
  answers: Partial<Record<'orchestrate' | 'clean' | 'workers', number>> = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Run['calls'] = [];
  const io = {
    out: (line: string) => {
      out.push(line);
    },
    err: (line: string) => {
      err.push(line);
    },
  };
  const program = createKubicProgram(io, {
    versionLine: 'kubic 0.0.0',
    rootHelp: 'usage: kubic <x>',
  });
  const record =
    (runner: 'orchestrate' | 'clean' | 'workers') =>
    (args: unknown, config: unknown): number => {
      calls.push({ runner, args, config });
      return answers[runner] ?? 0;
    };
  let exitCode = 0;
  const ctx: CommandContext = {
    config: CONFIG,
    runners: {
      orchestrate: record('orchestrate'),
      clean: record('clean'),
      workers: record('workers'),
    } as unknown as DispatchRunners,
    rest: argv.slice(1),
    out: io.out,
    err: io.err,
    setExitCode: (code) => {
      exitCode = code;
    },
  };
  registerOrchestratorCommands(program, ctx);
  const code = await runKubicProgram(program, argv, io, {
    code: () => exitCode,
  });
  return { code, out, err, calls };
}

// A usage error: exit 2, one commander/Kubic `error: …` line on stderr,
// nothing on stdout, and the handler never ran.
function expectUsage(result: Run, pattern: RegExp): void {
  expect(result.code).toBe(2);
  expect(result.out).toEqual([]);
  expect(result.err).toHaveLength(1);
  expect(result.err[0]).toMatch(/^error: /);
  expect(result.err[0]).toMatch(pattern);
  expect(result.calls).toEqual([]);
}

describe('kubic orchestrate (commander)', () => {
  it('--help/-h print the generated help on stdout and exit 0 without running', async () => {
    for (const flag of ['--help', '-h']) {
      const result = await run(['orchestrate', flag]);
      expect(result.code, flag).toBe(0);
      expect(result.err, flag).toEqual([]);
      expect(result.calls, flag).toEqual([]);
      const help = result.out.join('\n');
      expect(help).toMatch(/^Usage: kubic orchestrate \[options\]/);
      for (const option of [
        '-p, --prompt <text>',
        '--agents <ids>',
        '--concurrency <n>',
        '--on-failure <mode>',
        '--session <id>',
        '--resume',
        '--yes',
        '--budget <dims>',
        '--full-access',
        '--json',
        '-h, --help',
      ]) {
        expect(help, option).toContain(option);
      }
      expect(help).toContain('Examples:');
      expect(help).toContain('kubic orchestrate --resume --session');
    }
  });

  it('passes every parsed option to the runner, typed', async () => {
    const result = await run([
      'orchestrate',
      '-p',
      'do it',
      '--agents',
      'alpha, beta',
      '--session',
      'sess-1',
      '--yes',
      '--budget',
      'maxToolCalls=5;beta:maxCostUsd=0.5',
      '--full-access',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      {
        runner: 'orchestrate',
        config: CONFIG,
        args: {
          prompt: 'do it',
          agents: ['alpha', 'beta'],
          session: 'sess-1',
          yes: true,
          budget: {
            shared: { maxToolCalls: 5 },
            byAgent: { beta: { maxCostUsd: 0.5 } },
          },
          fullAccess: true,
          json: true,
        },
      },
    ]);
  });

  it('accepts the --flag=value form and the long --prompt spelling', async () => {
    const result = await run([
      'orchestrate',
      '--prompt=ship it',
      '--session=s1',
      '--resume',
    ]);
    expect(result.calls[0]?.args).toEqual({
      prompt: 'ship it',
      session: 's1',
      resume: true,
    });
  });

  it('hands a flagless invocation to the runner, which owns the -p/--resume rule', async () => {
    const result = await run(['orchestrate']);
    expect(result.calls).toEqual([
      { runner: 'orchestrate', config: CONFIG, args: {} },
    ]);
  });

  it('returns the runner exit code unchanged (budget 3, approval 4)', async () => {
    for (const code of [1, 2, 3, 4]) {
      const result = await run(['orchestrate', '-p', 'x'], {
        orchestrate: code,
      });
      expect(result.code, `code ${code}`).toBe(code);
    }
  });

  it('refuses an unknown flag with exit 2', async () => {
    expectUsage(
      await run(['orchestrate', '-p', 'x', '--bogus']),
      /unknown option '--bogus'/,
    );
  });

  it('refuses a missing option value and a stray operand with exit 2', async () => {
    expectUsage(await run(['orchestrate', '-p']), /argument missing/);
    expectUsage(
      await run(['orchestrate', '-p', 'x', 'extra']),
      /too many arguments/,
    );
  });

  it('carries --on-failure to the runner and refuses an unknown mode (issue #169)', async () => {
    const result = await run([
      'orchestrate',
      '-p',
      'x',
      '--on-failure',
      'continue',
    ]);
    expect(result.code).toBe(0);
    expect(result.calls[0]?.args).toEqual({
      prompt: 'x',
      onFailure: 'continue',
    });
    expectUsage(
      await run(['orchestrate', '-p', 'x', '--on-failure', 'retry']),
      /--on-failure.*'stop' or 'continue'/i,
    );
  });

  it('refuses malformed --agents lists with exit 2', async () => {
    for (const agents of ['good,bad/id', 'a,a', ',', '']) {
      expectUsage(
        await run(['orchestrate', '-p', 'x', '--agents', agents]),
        /--agents/,
      );
    }
  });

  it('carries --concurrency to the runner, and refuses a non-positive value (issue #206)', async () => {
    const result = await run([
      'orchestrate',
      '-p',
      'x',
      '--agents',
      'a,b,c',
      '--concurrency',
      '2',
    ]);
    expect(result.code).toBe(0);
    expect(result.calls[0]?.args).toEqual({
      prompt: 'x',
      agents: ['a', 'b', 'c'],
      concurrency: 2,
    });
    // Zero, negatives and rubbish are usage errors, never a silent default.
    for (const value of ['0', '-1', '2.5', 'many']) {
      expectUsage(
        await run(['orchestrate', '-p', 'x', '--concurrency', value]),
        /--concurrency.*positive integer/i,
      );
    }
  });

  it('refuses an invalid --session id with exit 2', async () => {
    expectUsage(
      await run(['orchestrate', '--session', 'no spaces!!', '-p', 'x']),
      /--session.*\[A-Za-z0-9_-\]/,
    );
  });

  it('refuses a malformed --budget with exit 2 (never a silently dropped limit)', async () => {
    for (const budget of [
      'nope=1',
      'maxToolCalls=0',
      'maxToolCalls=abc',
      'bad/id:maxToolCalls=1',
    ]) {
      expectUsage(
        await run(['orchestrate', '-p', 'x', '--budget', budget]),
        /--budget/,
      );
    }
  });
});

describe('kubic clean (commander)', () => {
  it('--help lists every shipped flag and exits 0 without running', async () => {
    const result = await run(['clean', '--help']);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    expect(result.calls).toEqual([]);
    const help = result.out.join('\n');
    expect(help).toMatch(/^Usage: kubic clean \[options\]/);
    for (const option of [
      '--all',
      '--session <id>',
      '--dry-run',
      '--force',
      '--journal',
      '--max-age-ms <n>',
      '--max-bytes <n>',
      '--json',
    ]) {
      expect(help, option).toContain(option);
    }
    expect(help).toContain('kubic clean --dry-run');
  });

  it('passes the parsed options to the runner (--session becomes sessionId)', async () => {
    const result = await run([
      'clean',
      '--session',
      'orch-1',
      '--dry-run',
      '--force',
      '--journal',
      '--max-age-ms',
      '5',
      '--max-bytes=10',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      {
        runner: 'clean',
        config: CONFIG,
        args: {
          sessionId: 'orch-1',
          dryRun: true,
          force: true,
          journal: true,
          maxAgeMs: 5,
          maxBytes: 10,
          json: true,
        },
      },
    ]);
    const bare = await run(['clean']);
    expect(bare.calls[0]?.args).toEqual({});
  });

  it('returns the runner exit code unchanged', async () => {
    expect((await run(['clean'], { clean: 1 })).code).toBe(1);
  });

  it('refuses an unknown flag and a stray operand with exit 2', async () => {
    expectUsage(await run(['clean', '--nuke']), /unknown option '--nuke'/);
    expectUsage(await run(['clean', 'worker-1']), /too many arguments/);
  });

  it('refuses a missing or non-positive retention bound with exit 2', async () => {
    expectUsage(await run(['clean', '--max-age-ms']), /argument missing/);
    // A flag in the value slot is not a bound: `--nuke` is refused as the
    // bound's value, by the bound's name.
    expectUsage(
      await run(['clean', '--max-age-ms', '--nuke']),
      /--max-age-ms.*positive integer/,
    );
    for (const value of ['0', '-3', '1.5', 'abc']) {
      expectUsage(
        await run(['clean', '--max-bytes', value]),
        /--max-bytes.*positive integer/,
      );
    }
  });

  it('refuses --all with --session, and an invalid --session id, with exit 2', async () => {
    expectUsage(
      await run(['clean', '--all', '--session', 'orch-1']),
      /--all.*cannot be used with.*--session/,
    );
    expectUsage(
      await run(['clean', '--session', '../etc']),
      /--session.*\[A-Za-z0-9_-\]/,
    );
  });
});

describe('kubic workers (commander)', () => {
  it('--help exits 0 without running', async () => {
    const result = await run(['workers', '--help']);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([]);
    const help = result.out.join('\n');
    expect(help).toMatch(/^Usage: kubic workers \[options\]/);
    expect(help).toContain('--json');
    expect(help).toContain('--debug');
  });

  it('passes --json/--debug to the runner and its exit code through', async () => {
    const result = await run(['workers', '--json', '--debug']);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      { runner: 'workers', config: CONFIG, args: { json: true, debug: true } },
    ]);
    // No remap any more: usage errors never reach the handler, so a 1 from
    // it is a real failure and stays 1.
    expect((await run(['workers'], { workers: 1 })).code).toBe(1);
  });

  it('refuses an unknown flag, a stray operand and --json=1 with exit 2', async () => {
    expectUsage(await run(['workers', '--nope']), /unknown option '--nope'/);
    expectUsage(await run(['workers', 'extra']), /too many arguments/);
    expectUsage(await run(['workers', '--json=1']), /--json/);
  });

  it('accepts the -- end-of-options terminator', async () => {
    const result = await run(['workers', '--']);
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(1);
  });
});

describe('orchestrate --dangerously-skip-approvals (issue #308)', () => {
  it('accepts the unified flag name', async () => {
    const result = await run([
      'orchestrate',
      '-p',
      'x',
      '--dangerously-skip-approvals',
    ]);
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    expect(result.calls).toEqual([
      {
        runner: 'orchestrate',
        config: CONFIG,
        args: { prompt: 'x', fullAccess: true },
      },
    ]);
  });

  it('keeps --full-access working as a deprecated alias with a hint', async () => {
    const result = await run(['orchestrate', '-p', 'x', '--full-access']);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      {
        runner: 'orchestrate',
        config: CONFIG,
        args: { prompt: 'x', fullAccess: true },
      },
    ]);
    expect(result.err.join('\n')).toContain('--full-access is deprecated');
    expect(result.err.join('\n')).toContain('--dangerously-skip-approvals');
  });
});
