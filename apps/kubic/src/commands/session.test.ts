// The command group's commander surface (run, tui, doctor, models,
// config, sessions): every flag parses into the typed options the runner
// receives, `--help` is commander's generated help (exit 0), and every
// usage error — unknown flag, missing value, a value the command's rules
// refuse, a stray operand — exits 2 on stderr without reaching a runner.
// Runners are fakes: the handlers' own behaviour is pinned in their host
// test files; this file pins argv → options and the exit-code mapping.

import type { CommandResult, ExitCode } from '@kubic/core/cli/exit-codes';
import { describe, expect, it } from 'vitest';
import type { CommandContext, DispatchRunners } from '../cli/context.js';
import { createKubicProgram, runKubicProgram } from '../cli/program.js';
import type { CliConfigResult } from '../config/load.js';
import { registerSessionCommands } from './session.js';

const CONFIG = {} as CliConfigResult;

type Key =
  | 'run'
  | 'tui'
  | 'doctor'
  | 'skills'
  | 'models'
  | 'config'
  | 'trust'
  | 'sessions';

interface Result {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly calls: { key: Key; input: unknown }[];
}

async function kubic(
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
    versionLine: 'kubic 0.0.0 (license: MIT)',
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

async function usageError(argv: readonly string[]): Promise<string> {
  const result = await kubic(argv);
  expect(result.code, argv.join(' ')).toBe(2);
  expect(result.calls, argv.join(' ')).toEqual([]);
  expect(result.out, argv.join(' ')).toEqual([]);
  return result.err.join('\n');
}

const GROUP: readonly (readonly string[])[] = [
  ['run'],
  ['tui'],
  ['doctor'],
  ['skills'],
  ['models'],
  ['config'],
  ['trust'],
  ['sessions'],
  ['sessions', 'create'],
  ['sessions', 'list'],
  ['sessions', 'attach'],
  ['sessions', 'prune'],
];

describe('commands: generated help', () => {
  for (const path of GROUP) {
    it(`kubic ${path.join(' ')} --help prints its usage, exit 0`, async () => {
      for (const flag of ['--help', '-h']) {
        const result = await kubic([...path, flag]);
        expect(result.code).toBe(0);
        expect(result.calls).toEqual([]);
        expect(result.err).toEqual([]);
        expect(result.out.join('\n')).toContain(
          `Usage: kubic ${path.join(' ')}`,
        );
      }
    });
  }

  it('documents every run flag and an example', async () => {
    const help = (await kubic(['run', '--help'])).out.join('\n');
    for (const flag of [
      '-p, --prompt <text>',
      '--session <id>',
      '--timeout <ms>',
      '--max-turns <n>',
      '--role <name>',
      '--skill <path>',
      '--invoke-skill <name>',
      '--no-skills',
      '--debug',
      '--json',
      '--model <provider/id>',
    ]) {
      expect(help).toContain(flag);
    }
    expect(help).toContain('Examples:');
    expect(help).toContain('KUBIC_PROVIDER=faux');
  });

  it('bare `kubic sessions` shows the subcommands as a usage error', async () => {
    const result = await kubic(['sessions']);
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    const text = [...result.out, ...result.err].join('\n');
    for (const sub of ['create', 'list', 'attach', 'prune']) {
      expect(text).toContain(sub);
    }
  });
});

describe('commands: unknown flags exit 2', () => {
  for (const path of GROUP.filter((entry) => entry.join(' ') !== 'sessions')) {
    it(`kubic ${path.join(' ')} --bogus`, async () => {
      const argv = path[1] === 'attach' ? [...path, 'id1'] : [...path];
      expect(await usageError([...argv, '--bogus'])).toContain(
        "error: unknown option '--bogus'",
      );
    });
  }

  it('an unknown sessions subcommand exits 2 like any other usage error', async () => {
    const result = await kubic(['sessions', 'bogus']);
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.err.join('\n')).toContain("unknown command 'bogus'");
  });

  it('`sessions --json` lists as one JSON array', async () => {
    const result = await kubic(['sessions', '--json']);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      { key: 'sessions', input: { command: 'list', json: true } },
    ]);
  });

  it('`sessions --json` never swallows a named subcommand', async () => {
    const result = await kubic(['sessions', '--json', 'bogus']);
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
    expect(result.err.join('\n')).toContain("unknown command 'bogus'");
  });
});

describe('kubic attach / resume', () => {
  for (const name of ['attach', 'resume'] as const) {
    it(`kubic ${name} <id> boots the TUI on that session`, async () => {
      const result = await kubic([name, 'my-session']);
      expect(result.code).toBe(0);
      expect(result.calls).toEqual([
        { key: 'tui', input: { session: 'my-session' } },
      ]);
    });

    it(`kubic ${name} --help prints its usage without booting`, async () => {
      const result = await kubic([name, '--help']);
      expect(result.code).toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.out.join('\n')).toContain(`Usage: kubic ${name}`);
    });

    it(`kubic ${name} refuses a bad id and a missing one`, async () => {
      expect(await usageError([name, '../evil'])).toContain(
        'use [A-Za-z0-9_-]',
      );
      expect(await usageError([name])).toContain(
        "missing required argument 'id'",
      );
    });
  }
});

describe('kubic run', () => {
  it('parses every flag into the runner options', async () => {
    const result = await kubic([
      'run',
      '-p',
      'fix it',
      '--session',
      'abc_1',
      '--timeout',
      '60000',
      '--max-turns',
      '10',
      '--role',
      'reviewer',
      '--skill',
      '/a.md',
      '--skill',
      '/b.md',
      '--invoke-skill',
      'secret',
      '--no-skills',
      '--debug',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      {
        key: 'run',
        input: {
          prompt: 'fix it',
          session: 'abc_1',
          timeoutMs: 60000,
          maxTurns: 10,
          role: 'reviewer',
          skills: ['/a.md', '/b.md'],
          invokeSkill: 'secret',
          noSkills: true,
          debug: true,
          json: true,
        },
      },
    ]);
  });

  it('passes only the prompt when nothing else is given', async () => {
    const result = await kubic(['run', '--prompt', 'hi']);
    expect(result.calls).toEqual([{ key: 'run', input: { prompt: 'hi' } }]);
  });

  // Autonomous mode is explicit — the flag reaches
  // the runner, and its absence leaves the key out (off by default).
  it('parses --autonomous into the runner options', async () => {
    expect((await kubic(['run', '-p', 'hi', '--autonomous'])).calls).toEqual([
      { key: 'run', input: { prompt: 'hi', autonomous: true } },
    ]);
    expect((await kubic(['run', '-p', 'hi'])).calls).toEqual([
      { key: 'run', input: { prompt: 'hi' } },
    ]);
  });

  it('returns the runner exit code (the terminus map)', async () => {
    for (const exit of [0, 1, 3, 4, 5, 6] as const) {
      expect((await kubic(['run', '-p', 'x'], exit)).code).toBe(exit);
    }
  });

  it('refuses a missing prompt', async () => {
    expect(await usageError(['run'])).toContain(
      "required option '-p, --prompt <text>' not specified",
    );
    expect(await usageError(['run', '--json'])).toContain('-p, --prompt');
  });

  it('refuses -p without a value', async () => {
    expect(await usageError(['run', '-p'])).toContain(
      "option '-p, --prompt <text>' argument missing",
    );
  });

  it('keeps the typo guard: -p --json is not a prompt', async () => {
    const text = await usageError(['run', '-p', '--json']);
    expect(text).toContain('argument missing');
    expect(text).toContain('looks like a flag');
    expect(text).toContain("--prompt='--json'");
  });

  it('accepts a prompt that starts with -- in the attached forms', async () => {
    for (const argv of [
      ['run', '--prompt=--help'],
      ['run', '-p--json-experiment'],
    ]) {
      const result = await kubic(argv);
      expect(result.code, argv.join(' ')).toBe(0);
      expect(result.calls[0]?.input).toMatchObject({
        prompt: argv[1]?.startsWith('--prompt=')
          ? '--help'
          : '--json-experiment',
      });
      expect(result.calls[0]?.input).not.toHaveProperty('json');
    }
  });

  it('accepts a single-dash prompt (a markdown bullet) as a separate token', async () => {
    const result = await kubic(['run', '-p', '- fix the tests']);
    expect(result.calls[0]?.input).toEqual({ prompt: '- fix the tests' });
  });

  // `--model` is a config-layer input (dispatch reads it from
  // the raw argv into the ONE load), not a runner option — the runner
  // consumes its effect through the loaded config (runtimeModelPin).
  it('accepts the config-layer --model flag without copying it into the runner options', async () => {
    expect(
      (await kubic(['run', '-p', 'hi', '--model', 'faux/small'])).calls,
    ).toEqual([{ key: 'run', input: { prompt: 'hi' } }]);
  });

  it('refuses a malformed --model value with commander exit 2', async () => {
    expect(await usageError(['run', '-p', 'hi', '--model', 'nope'])).toContain(
      "--model must be 'provider/id'",
    );
    expect(await usageError(['run', '-p', 'hi', '--model'])).toContain(
      'argument missing',
    );
  });

  // `--thinking` is the same kind of input as `--model` — a
  // config-layer value dispatch pre-scans, never a runner option — so the
  // runner input carries no trace of it, and a malformed level is
  // commander's exit 2 with the levels named, never a silent default.
  it('accepts the config-layer --thinking flag without copying it into the runner options', async () => {
    expect(
      (await kubic(['run', '-p', 'hi', '--thinking', 'high'])).calls,
    ).toEqual([{ key: 'run', input: { prompt: 'hi' } }]);
  });

  it('refuses a malformed --thinking value with commander exit 2', async () => {
    expect(
      await usageError(['run', '-p', 'hi', '--thinking', 'banana']),
    ).toContain("unknown thinking level 'banana'");
    expect(await usageError(['run', '-p', 'hi', '--thinking'])).toContain(
      'argument missing',
    );
  });

  it('refuses an empty prompt', async () => {
    expect(await usageError(['run', '--prompt='])).toContain(
      'the prompt is empty',
    );
    expect(await usageError(['run', '-p', ''])).toContain(
      'the prompt is empty',
    );
  });

  it('accepts a positional prompt as the -p alternative', async () => {
    const result = await kubic(['run', 'fix tests']);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([
      { key: 'run', input: { prompt: 'fix tests' } },
    ]);
  });

  it('accepts a positional prompt beside the other flags, --json included', async () => {
    const result = await kubic(['run', '--json', 'do x']);
    expect(result.calls[0]?.input).toEqual({ prompt: 'do x', json: true });
  });

  it('accepts a positional prompt that starts with - after the -- terminator', async () => {
    const result = await kubic(['run', '--', '--weird prompt']);
    expect(result.calls[0]?.input).toEqual({ prompt: '--weird prompt' });
  });

  it('parses --tools (comma-separated, repeatable) and --no-tools', async () => {
    const tools = await kubic(['run', '-p', 'x', '--tools', 'read,ls']);
    expect(tools.calls[0]?.input).toMatchObject({ tools: ['read', 'ls'] });
    const repeat = await kubic([
      'run',
      '-p',
      'x',
      '--tools',
      'read',
      '--tools',
      'ls',
    ]);
    expect(repeat.calls[0]?.input).toMatchObject({ tools: ['read', 'ls'] });
    const none = await kubic(['run', '-p', 'x', '--no-tools']);
    expect(none.calls[0]?.input).toMatchObject({ noTools: true });
    expect(none.calls[0]?.input).not.toHaveProperty('tools');
  });

  it('refuses --tools together with --no-tools, in either order', async () => {
    expect(
      await usageError(['run', '-p', 'x', '--tools', 'read', '--no-tools']),
    ).toContain('mutually exclusive');
    expect(
      await usageError(['run', '-p', 'x', '--no-tools', '--tools', 'read']),
    ).toContain('mutually exclusive');
  });

  it('refuses an empty --tools value', async () => {
    expect(await usageError(['run', '-p', 'x', '--tools', ''])).toContain(
      'at least one tool name',
    );
    expect(await usageError(['run', '-p', 'x', '--tools', ', ,'])).toContain(
      'at least one tool name',
    );
  });

  it('parses --tools / --no-tools on tui too', async () => {
    const tools = await kubic(['tui', '--tools', 'read,ls']);
    expect(tools.calls[0]?.input).toMatchObject({ tools: ['read', 'ls'] });
    const none = await kubic(['tui', '--no-tools']);
    expect(none.calls[0]?.input).toMatchObject({ noTools: true });
    expect(
      await usageError(['tui', '--tools', 'read', '--no-tools']),
    ).toContain('mutually exclusive');
  });

  it('refuses -p together with a positional prompt, naming both', async () => {
    const text = await usageError(['run', '-p', 'a', 'b']);
    expect(text).toContain('both -p/--prompt and a positional prompt');
    expect(text).toContain('kubic run -p <text>, or kubic run <text>');
    expect(await usageError(['run', '-p', 'a', '--', 'b'])).toContain(
      'both -p/--prompt and a positional prompt',
    );
  });

  it('refuses two positional prompts', async () => {
    expect(await usageError(['run', 'a', 'b'])).toContain(
      'unexpected argument "b"',
    );
    expect(await usageError(['run', 'a', '--', 'b'])).toContain(
      'unexpected argument "b"',
    );
  });

  it('applies the value rules as usage errors', async () => {
    for (const value of ['abc', '0', '-5', '1.5']) {
      expect(
        await usageError(['run', '-p', 'x', `--timeout=${value}`]),
      ).toMatch(/--timeout <ms>.*need a positive integer/);
      expect(
        await usageError(['run', '-p', 'x', `--max-turns=${value}`]),
      ).toMatch(/--max-turns <n>.*need a positive integer/);
    }
    expect(
      await usageError(['run', '-p', 'x', '--timeout', '3000000000']),
    ).toContain('max 2147483647');
    expect(
      await usageError(['run', '-p', 'x', '--session', '../evil']),
    ).toContain('use [A-Za-z0-9_-]');
    expect(await usageError(['run', '-p', 'x', '--timeout'])).toContain(
      'argument missing',
    );
    expect(await usageError(['run', '-p', 'x', '--role'])).toContain(
      'argument missing',
    );
  });
});
