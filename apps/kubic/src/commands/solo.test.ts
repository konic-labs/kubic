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
      '--budget <dims>',
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

describe('solo commands: unknown flags exit 2', () => {
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

  it('`sessions --json` lists as one JSON array (issue #268)', async () => {
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

describe('kubic attach / resume (issue #268)', () => {
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

  // Issue #283 (§71): the opt-in budget reaches the runner as parsed
  // limits; absence leaves the key out (never defaulted). Agent-scoped
  // clauses belong to `kubic orchestrate --budget`.
  it('parses --budget dims into the runner options', async () => {
    expect(
      (
        await kubic([
          'run',
          '-p',
          'hi',
          '--budget',
          'maxToolCalls=1,maxCostUsd=0.5',
        ])
      ).calls,
    ).toEqual([
      {
        key: 'run',
        input: {
          prompt: 'hi',
          budget: { maxToolCalls: 1, maxCostUsd: 0.5 },
        },
      },
    ]);
    expect((await kubic(['run', '-p', 'hi'])).calls).toEqual([
      { key: 'run', input: { prompt: 'hi' } },
    ]);
  });

  it('refuses a malformed --budget naming the flag', async () => {
    expect(
      await usageError(['run', '-p', 'hi', '--budget', 'bogus']),
    ).toContain('--budget');
  });

  it('refuses agent-scoped --budget clauses on a solo run', async () => {
    expect(
      await usageError(['run', '-p', 'hi', '--budget', 'worker-1:toolCalls=1']),
    ).toContain('--budget');
  });

  // Issue #278 (§19): autonomous mode is explicit — the flag reaches
  // the runner, and its absence leaves the key out (off by default).
  it('parses --autonomous into the runner options', async () => {
    expect((await kubic(['run', '-p', 'hi', '--autonomous'])).calls).toEqual([
      { key: 'run', input: { prompt: 'hi', autonomous: true } },
    ]);
    expect((await kubic(['run', '-p', 'hi'])).calls).toEqual([
      { key: 'run', input: { prompt: 'hi' } },
    ]);
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

  // Issue #227: `--model` is a config-layer input (dispatch reads it from
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

  it('refuses an empty prompt', async () => {
    expect(await usageError(['run', '--prompt='])).toContain(
      'the prompt is empty',
    );
    expect(await usageError(['run', '-p', ''])).toContain(
      'the prompt is empty',
    );
  });

  it('accepts a positional prompt as the -p alternative (issue #268)', async () => {
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

  it('parses --tools (comma-separated, repeatable) and --no-tools (issue #273)', async () => {
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

  it('refuses --tools together with --no-tools, in either order (issue #273)', async () => {
    expect(
      await usageError(['run', '-p', 'x', '--tools', 'read', '--no-tools']),
    ).toContain('mutually exclusive');
    expect(
      await usageError(['run', '-p', 'x', '--no-tools', '--tools', 'read']),
    ).toContain('mutually exclusive');
  });

  it('refuses an empty --tools value (issue #273)', async () => {
    expect(await usageError(['run', '-p', 'x', '--tools', ''])).toContain(
      'at least one tool name',
    );
    expect(await usageError(['run', '-p', 'x', '--tools', ', ,'])).toContain(
      'at least one tool name',
    );
  });

  it('parses --tools / --no-tools on tui too (issue #273)', async () => {
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

  // Issue #283 (§71): same opt-in budget grammar as `run` — parsed
  // limits reach the runner, absence leaves the key out.
  it('parses --budget dims into the runner options', async () => {
    expect((await kubic(['tui', '--budget', 'maxCostUsd=0.5'])).calls).toEqual([
      { key: 'tui', input: { budget: { maxCostUsd: 0.5 } } },
    ]);
    expect(await usageError(['tui', '--budget', 'bogus'])).toContain(
      '--budget',
    );
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

  // Issue #227: the flag is documented, and the `=` spelling (the cli config
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

  // Issue #327: the explicit interactive orchestrator entry — delegation
  // stays opt-in, and the flag parses into the runner's own option.
  it('parses --orchestrator and documents it in the generated help', async () => {
    const result = await kubic(['tui', '--orchestrator']);
    expect(result.calls).toEqual([
      { key: 'tui', input: { orchestrator: true } },
    ]);
    const help = await kubic(['tui', '--help']);
    const text = help.out.join('\n');
    expect(text).toContain('--orchestrator');
    expect(text).toMatch(/orchestrator mode/i);
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
    // Issue #227: the flag feeds the load dispatch already performed (the
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
  // One grant covers the whole project tree; the help says what "yes" means
  // (issue #228 review) — not only the committed config.toml.
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

describe('--dangerously-skip-approvals on run and tui (issue #308)', () => {
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
