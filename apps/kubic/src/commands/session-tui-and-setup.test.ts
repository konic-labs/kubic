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

  // The explicit model pin, same `provider/id` rule as replay.
  it('parses --model <provider/id> and refuses a malformed ref', async () => {
    expect((await kubic(['tui', '--model', 'faux/b'])).calls).toEqual([
      { key: 'tui', input: { model: { provider: 'faux', id: 'b' } } },
    ]);
    expect(await usageError(['tui', '--model', 'nope'])).toContain(
      "must be 'provider/id'",
    );
    expect(await usageError(['tui', '--model'])).toContain('argument missing');
  });

  // The flag is documented, and the `=` spelling (the cli config
  // layer reads the same token for the one config load) reaches the runner
  // exactly like the space form above.
  it('documents and accepts the config-layer --model flag', async () => {
    const help = (await kubic(['tui', '--help'])).out.join('\n');
    expect(help).toContain('--model <provider/id>');
    expect((await kubic(['tui', '--model=faux/small'])).calls).toEqual([
      { key: 'tui', input: { model: { provider: 'faux', id: 'small' } } },
    ]);
  });

  it('refuses operands, missing values and unsafe ids', async () => {
    expect(await usageError(['tui', 'extra'])).toContain('too many arguments');
    expect(await usageError(['tui', '--role'])).toContain('argument missing');
    expect(await usageError(['tui', '--skill'])).toContain('argument missing');
    expect(await usageError(['tui', '--session', 'a/b'])).toContain(
      'use [A-Za-z0-9_-]',
    );
  });

  // Skills never fetch — no fetch/install flag exists on the
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

  it('forwards --session to the doctor runner', async () => {
    const result = await kubic(['doctor', '--session', 'abc']);
    expect(result.calls).toEqual([
      { key: 'doctor', input: { skip: [], session: 'abc' } },
    ]);
  });

  it('refuses --skip without a value', async () => {
    expect(await usageError(['doctor', '--skip'])).toContain(
      'argument missing',
    );
  });
});

describe('kubic skills', () => {
  it('parses --role and --json', async () => {
    expect((await kubic(['skills'])).calls).toEqual([
      { key: 'skills', input: {} },
    ]);
    expect(
      (await kubic(['skills', '--role', 'reviewer', '--json'])).calls,
    ).toEqual([{ key: 'skills', input: { role: 'reviewer', json: true } }]);
  });

  it('passes the skills exit code through', async () => {
    expect((await kubic(['skills'], 6)).code).toBe(6);
  });

  it('refuses --role without a value', async () => {
    expect(await usageError(['skills', '--role'])).toContain(
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
    // The flag feeds the load dispatch already performed (the
    // runner input is the rendering options only).
    expect((await kubic(['config', '--model', 'faux/small'])).calls).toEqual([
      { key: 'config', input: {} },
    ]);
    expect(await usageError(['config', 'extra'])).toContain(
      'too many arguments',
    );
  });
});

describe('kubic trust', () => {
  // One grant covers the whole project tree; the help says what "yes" means —
  // not only the committed config.toml.
  it('its help names everything a grant covers: config.toml, models.json and skills', async () => {
    const help = (await kubic(['trust', '--help'])).out.join('\n');
    expect(help).toContain('.kubic/config.toml');
    expect(help).toContain('models.json');
    expect(help).toContain('*_API_KEY');
    expect(help).toContain('KUBIC_*');
    expect(help).toContain('project skills');
  });

  it('parses the grant form with no flags', async () => {
    expect((await kubic(['trust'])).calls).toEqual([
      { key: 'trust', input: {} },
    ]);
  });

  it('parses --revoke, --list and a path operand into the runner options', async () => {
    expect((await kubic(['trust', '--revoke'])).calls).toEqual([
      { key: 'trust', input: { revoke: true } },
    ]);
    expect((await kubic(['trust', '--list'])).calls).toEqual([
      { key: 'trust', input: { list: true } },
    ]);
    expect((await kubic(['trust', '/repos/app'])).calls).toEqual([
      { key: 'trust', input: { path: '/repos/app' } },
    ]);
    expect((await kubic(['trust', '/repos/app', '--revoke'])).calls).toEqual([
      { key: 'trust', input: { path: '/repos/app', revoke: true } },
    ]);
  });

  it('refuses a stray second operand', async () => {
    expect(await usageError(['trust', 'a', 'b'])).toContain(
      "error: too many arguments for 'trust'.",
    );
  });

  it('passes the runner exit code through', async () => {
    expect((await kubic(['trust'], 1)).code).toBe(1);
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

describe('--dangerously-skip-approvals on run and tui', () => {
  it('run passes the session-scoped flag to the runner', async () => {
    const result = await kubic([
      'run',
      '--dangerously-skip-approvals',
      '-p',
      'hi',
    ]);
    expect(result.calls).toEqual([
      { key: 'run', input: { prompt: 'hi', dangerouslySkipApprovals: true } },
    ]);
  });

  it('tui passes the session-scoped flag to the runner', async () => {
    const result = await kubic(['tui', '--dangerously-skip-approvals']);
    expect(result.calls).toEqual([
      { key: 'tui', input: { dangerouslySkipApprovals: true } },
    ]);
  });

  it('documents the flag in run and tui help', async () => {
    for (const command of ['run', 'tui']) {
      const result = await kubic([command, '--help']);
      expect(result.out.join('\n'), command).toContain(
        '--dangerously-skip-approvals',
      );
    }
  });
});
