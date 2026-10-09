// Runs one kubic command through the real program with stub runners, and
// captures what it printed and which runner it reached.
import type { CommandResult, ExitCode } from '@kubic/core/cli/exit-codes';
import { expect } from 'vitest';
import type { CommandContext, DispatchRunners } from '../cli/context.js';
import { createKubicProgram, runKubicProgram } from '../cli/program.js';
import { registerSessionCommands } from '../commands/session.js';
import type { CliConfigResult } from '../config/load.js';

const CONFIG = {} as CliConfigResult;

export type Key =
  | 'run'
  | 'tui'
  | 'doctor'
  | 'skills'
  | 'models'
  | 'config'
  | 'trust'
  | 'sessions';

export interface Result {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly calls: { key: Key; input: unknown }[];
}

export async function kubic(
  argv: readonly string[],
  answer: ExitCode | ((key: Key, input: unknown) => ExitCode) = 0,
): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { key: Key; input: unknown }[] = [];
  const channels = {
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  };
  const program = createKubicProgram(channels, {
    versionLine: 'kubic 1.2.3 (license: MIT)',
    rootHelp: 'usage: kubic <…>',
  });
  let code: ExitCode = 0;
  let finished = false;
  const runner =
    (key: Key) =>
    (input: unknown): CommandResult => {
      calls.push({ key, input });
      return {
        exitCode: typeof answer === 'number' ? answer : answer(key, input),
      };
    };
  const runners = {
    run: runner('run'),
    tui: runner('tui'),
    doctor: runner('doctor'),
    skills: runner('skills'),
    models: runner('models'),
    config: runner('config'),
    trust: runner('trust'),
    sessions: runner('sessions'),
  } as unknown as DispatchRunners;
  const ctx: CommandContext = {
    config: CONFIG,
    runners,
    rest: argv.slice(1),
    ...channels,
    finish: (result) => {
      code = result.exitCode;
      finished = true;
    },
  };
  registerSessionCommands(program, ctx);
  const exit = await runKubicProgram(program, argv, channels, {
    code: () => code,
    finished: () => finished,
  });
  return { code: exit, out, err, calls };
}

export async function usageError(argv: readonly string[]): Promise<string> {
  const result = await kubic(argv);
  expect(result.code, argv.join(' ')).toBe(2);
  expect(result.calls, argv.join(' ')).toEqual([]);
  expect(result.out, argv.join(' ')).toEqual([]);
  return result.err.join('\n');
}
