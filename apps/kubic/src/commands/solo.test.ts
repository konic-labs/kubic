// The solo command group's commander surface (run, tui, doctor, models,
// config, sessions): every flag parses into the typed options the runner
// receives, `--help` is commander's generated help (exit 0), and every
// usage error — unknown flag, missing value, a value the command's rules
// refuse, a stray operand — exits 2 on stderr without reaching a runner.
// Runners are fakes: the handlers' own behaviour is pinned in their host
// test files; this file pins argv → options and the exit-code mapping.

import { describe, expect, it } from 'vitest';
import type { CommandContext, DispatchRunners } from '../cli/context.js';
import { createKubicProgram, runKubicProgram } from '../cli/program.js';
import type { CliConfigResult } from '../config-runtime.js';
import { registerSoloCommands } from './solo.js';

const CONFIG = {} as CliConfigResult;

type Key = 'run' | 'tui' | 'doctor' | 'models' | 'config' | 'sessions';

interface Result {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly calls: { key: Key; input: unknown }[];
}

async function kubic(
  argv: readonly string[],
  answer: number | ((key: Key, input: unknown) => number) = 0,
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
  let code = 0;
  const runner =
    (key: Key) =>
    (input: unknown): number => {
      calls.push({ key, input });
      return typeof answer === 'number' ? answer : answer(key, input);
    };
  const runners = {
    run: runner('run'),
    tui: runner('tui'),
    doctor: runner('doctor'),
    models: runner('models'),
    config: runner('config'),
    sessions: runner('sessions'),
  } as unknown as DispatchRunners;
  const ctx: CommandContext = {
    config: CONFIG,
    runners,
    rest: argv.slice(1),
    ...channels,
    setExitCode: (next) => {
      code = next;
    },
  };
  registerSoloCommands(program, ctx);
  const exit = await runKubicProgram(program, argv, channels, {
    code: () => code,
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
  ['models'],
  ['config'],
  ['sessions'],
  ['sessions', 'create'],
  ['sessions', 'list'],
  ['sessions', 'attach'],
  ['sessions', 'prune'],
];

describe('solo commands: generated help', () => {
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
      '--no-skills',
      '--debug',
      '--json',
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

describe('solo commands: unknown flags exit 2', () => {
  for (const path of GROUP.filter((entry) => entry.join(' ') !== 'sessions')) {
    it(`kubic ${path.join(' ')} --bogus`, async () => {
      const argv = path[1] === 'attach' ? [...path, 'id1'] : [...path];
      expect(await usageError([...argv, '--bogus'])).toContain(
        "error: unknown option '--bogus'",
      );
    });
  }

  it('an unknown sessions subcommand exits 1 like an unknown command', async () => {
    const result = await kubic(['sessions', 'bogus']);
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.err.join('\n')).toContain("unknown command 'bogus'");
  });
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

  it('returns the runner exit code (the §78 terminus map)', async () => {
    for (const exit of [0, 1, 3, 4, 5, 6]) {
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

  it('refuses an empty prompt', async () => {
    expect(await usageError(['run', '--prompt='])).toContain(
      'the prompt is empty',
    );
    expect(await usageError(['run', '-p', ''])).toContain(
      'the prompt is empty',
    );
  });

  it('points a positional prompt at -p, single-quoted for pasting', async () => {
    const text = await usageError(['run', 'fix tests']);
    expect(text).toContain('unexpected argument "fix tests"');
    expect(text).toContain("kubic run -p 'fix tests'");
    expect(await usageError(['run', "echo $HOME `id` it's"])).toContain(
      "kubic run -p 'echo $HOME `id` it'\\''s'",
    );
  });

  it('refuses a stray operand next to a prompt, even after --', async () => {
    expect(await usageError(['run', '-p', 'a', 'b'])).toContain(
      'unexpected argument "b"',
    );
    expect(await usageError(['run', '-p', 'a', '--', 'b'])).toContain(
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

describe('kubic tui', () => {
  it('parses the parity flags', async () => {
    const result = await kubic([
      'tui',
      '--session',
      's1',
      '--role',
      'planner',
      '--skill',
      '/one.md',
      '--skill',
      '/two.md',
      '--no-skills',
    ]);
    expect(result.calls).toEqual([
      {
        key: 'tui',
        input: {
          session: 's1',
          role: 'planner',
          skills: ['/one.md', '/two.md'],
          noSkills: true,
        },
      },
    ]);
  });

  it('opens with no flags', async () => {
    expect((await kubic(['tui'])).calls).toEqual([{ key: 'tui', input: {} }]);
  });

  // Issue #295: the explicit model pin, same `provider/id` rule as replay.
  it('parses --model <provider/id> and refuses a malformed ref', async () => {
    expect((await kubic(['tui', '--model', 'faux/b'])).calls).toEqual([
      { key: 'tui', input: { model: { provider: 'faux', id: 'b' } } },
    ]);
    expect(await usageError(['tui', '--model', 'nope'])).toContain(
      "must be 'provider/id'",
    );
    expect(await usageError(['tui', '--model'])).toContain('argument missing');
  });

  it('refuses operands, missing values and unsafe ids', async () => {
    expect(await usageError(['tui', 'extra'])).toContain('too many arguments');
    expect(await usageError(['tui', '--role'])).toContain('argument missing');
    expect(await usageError(['tui', '--skill'])).toContain('argument missing');
    expect(await usageError(['tui', '--session', 'a/b'])).toContain(
      'use [A-Za-z0-9_-]',
    );
  });

  // Issue #36: skills never fetch — no fetch/install flag exists on the
  // skill surface (run and tui), so commander refuses one by name.
  it('refuses fetcher/install skill flags on run and tui', async () => {
    for (const flag of ['--fetch-skills', '--install-skill', '--skill-fetch']) {
      expect(await usageError(['run', '-p', 'x', flag])).toContain(flag);
      expect(await usageError(['tui', flag])).toContain(flag);
    }
  });
});

describe('kubic doctor', () => {
  it('collects repeatable --skip values and --json', async () => {
    const result = await kubic([
      'doctor',
      '--skip',
      'node,license:kubic',
      '--skip=policy:approvals',
      '--json',
    ]);
    expect(result.calls).toEqual([
      {
        key: 'doctor',
        input: {
          skip: ['node,license:kubic', 'policy:approvals'],
          json: true,
        },
      },
    ]);
  });

  it('passes the doctor exit code through', async () => {
    expect((await kubic(['doctor'], 6)).code).toBe(6);
  });

  it('refuses --skip without a value', async () => {
    expect(await usageError(['doctor', '--skip'])).toContain(
      'argument missing',
    );
  });
});

describe('kubic models / config', () => {
  it('parses models --json and --resolve', async () => {
    expect((await kubic(['models', '--json'])).calls).toEqual([
      { key: 'models', input: { json: true } },
    ]);
    expect((await kubic(['models', '--resolve', 'faux/echo'])).calls).toEqual([
      { key: 'models', input: { resolve: 'faux/echo' } },
    ]);
    expect(await usageError(['models', '--resolve'])).toContain(
      'argument missing',
    );
  });

  it('parses config --json and refuses operands', async () => {
    expect((await kubic(['config'])).calls).toEqual([
      { key: 'config', input: {} },
    ]);
    expect((await kubic(['config', '--json'])).calls).toEqual([
      { key: 'config', input: { json: true } },
    ]);
    expect(await usageError(['config', 'extra'])).toContain(
      'too many arguments',
    );
  });
});

describe('kubic sessions', () => {
  it('parses create', async () => {
    expect(
      (
        await kubic([
          'sessions',
          'create',
          '--cwd',
          '/work',
          '--dangerously-skip-approvals',
        ])
      ).calls,
    ).toEqual([
      {
        key: 'sessions',
        input: {
          command: 'create',
          cwd: '/work',
          dangerouslySkipApprovals: true,
        },
      },
    ]);
    expect(await usageError(['sessions', 'create', '--cwd'])).toContain(
      'argument missing',
    );
  });

  it('parses list', async () => {
    expect((await kubic(['sessions', 'list', '--json'])).calls).toEqual([
      { key: 'sessions', input: { command: 'list', json: true } },
    ]);
  });

  it('parses attach, including the -- terminator before an id', async () => {
    expect(
      (await kubic(['sessions', 'attach', 'abc', '--tail', '0'])).calls,
    ).toEqual([
      { key: 'sessions', input: { command: 'attach', id: 'abc', tail: 0 } },
    ]);
    expect((await kubic(['sessions', 'attach', '--', 'abc'])).calls).toEqual([
      { key: 'sessions', input: { command: 'attach', id: 'abc' } },
    ]);
    expect(await usageError(['sessions', 'attach'])).toContain(
      "missing required argument 'id'",
    );
    expect(await usageError(['sessions', 'attach', '../x'])).toContain(
      'use [A-Za-z0-9_-]',
    );
    expect(
      await usageError(['sessions', 'attach', 'abc', '--tail', '-1']),
    ).toContain('need a non-negative integer');
  });

  it('parses prune', async () => {
    expect(
      (
        await kubic([
          'sessions',
          'prune',
          '--keep-days',
          '30',
          '--keep-session',
          'a',
          '--keep-session',
          'b',
          '--yes',
        ])
      ).calls,
    ).toEqual([
      {
        key: 'sessions',
        input: {
          command: 'prune',
          keepDays: 30,
          keepSession: ['a', 'b'],
          yes: true,
        },
      },
    ]);
    expect((await kubic(['sessions', 'prune', '--dry-run'])).calls).toEqual([
      {
        key: 'sessions',
        input: { command: 'prune', keepSession: [], dryRun: true },
      },
    ]);
  });

  it('refuses malformed prune flags by name', async () => {
    for (const [argv, reason] of [
      [['--keep-days'], 'argument missing'],
      [['--keep-days', 'thirty'], 'non-negative integer of days'],
      [['--keep-days', '-1'], 'non-negative integer of days'],
      [['--keep-session'], 'argument missing'],
      [['--keep-session', '../etc'], 'use [A-Za-z0-9_-]'],
      [['--yes', '--dry-run'], '--yes and --dry-run contradict'],
    ] as const) {
      expect(await usageError(['sessions', 'prune', ...argv])).toContain(
        reason,
      );
    }
  });
});
