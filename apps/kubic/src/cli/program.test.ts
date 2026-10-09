import {
  CliExitError,
  CliUsageError,
  type ExitCode,
} from '@kubic/core/cli/exit-codes';
import { describe, expect, it } from 'vitest';
import { registerAnalysisCommands } from '../commands/analysis.js';
import { registerJournalCommands } from '../commands/journal.js';
import { registerSessionCommands } from '../commands/session.js';
import type { CliConfigResult } from '../config/load.js';
import { COMMAND_NAMES } from '../dispatch.js';
import type { CommandContext, DispatchRunners } from './context.js';
import { createKubicProgram, runKubicProgram } from './program.js';
import { ROOT_HELP } from './root-help.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    channels: {
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
    },
  };
}

function program(channels: ReturnType<typeof io>['channels']) {
  return createKubicProgram(channels, {
    versionLine: 'kubic 1.2.3 (license: MIT)',
    rootHelp: 'usage: kubic <x>',
  });
}

const CONFIG = {} as CliConfigResult;

function context(
  rest: readonly string[],
  runners: Partial<DispatchRunners> = {},
): { ctx: CommandContext; code: () => ExitCode; finished: () => boolean } {
  let code: ExitCode = 0;
  let finished = false;
  const fallback = () => 0;
  const all = new Proxy(runners, {
    get: (target, key: string) =>
      (target as Record<string, unknown>)[key] ?? fallback,
  }) as DispatchRunners;
  return {
    ctx: {
      config: CONFIG,
      runners: all,
      rest,
      out: () => {},
      err: () => {},
      finish: (result) => {
        code = result.exitCode;
        finished = true;
      },
    },
    code: () => code,
    finished: () => finished,
  };
}

describe('kubic program (commander contracts)', () => {
  it('root --help/-h print the pinned root help on stdout, exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { out, err, channels } = io();
      const code = await runKubicProgram(program(channels), [flag], channels, {
        code: () => 6,
        finished: () => true,
      });
      expect(code, flag).toBe(0);
      expect(out, flag).toEqual(['usage: kubic <x>']);
      expect(err, flag).toEqual([]);
    }
  });

  it('--version/-V print the version line on stdout, exit 0', async () => {
    for (const flag of ['--version', '-V']) {
      const { out, channels } = io();
      expect(
        await runKubicProgram(program(channels), [flag], channels, {
          code: () => 6,
          finished: () => true,
        }),
      ).toBe(0);
      expect(out).toEqual(['kubic 1.2.3 (license: MIT)']);
    }
  });

  it('a commander usage error exits 2 with one `error:` line on stderr', async () => {
    const { out, err, channels } = io();
    const p = program(channels);
    p.command('demo')
      .option('--limit <n>', 'max rows')
      .action(() => {});
    expect(
      await runKubicProgram(p, ['demo', '--nope'], channels, {
        code: () => 0,
        finished: () => true,
      }),
    ).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^error: unknown option '--nope'/);
    err.length = 0;
    expect(
      await runKubicProgram(p, ['demo', '--limit'], channels, {
        code: () => 0,
        finished: () => true,
      }),
    ).toBe(2);
    expect(err[0]).toMatch(/^error: option '--limit <n>' argument missing/);
  });

  it('a subcommand answers -h with generated help, exit 0', async () => {
    const { out, channels } = io();
    const p = program(channels);
    p.command('demo').description('a demo').option('--json', 'machine output');
    expect(
      await runKubicProgram(p, ['demo', '-h'], channels, {
        code: () => 1,
        finished: () => true,
      }),
    ).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Usage: kubic demo');
    expect(text).toContain('--json');
  });

  it('root options are positional: `kubic demo -V` reaches the command', async () => {
    const { out, channels } = io();
    const { ctx, code, finished } = context(['-V']);
    const p = program(channels);
    let seen: { verbose?: true } = {};
    p.command('demo')
      .option('-V, --verbose')
      .action((opts) => {
        seen = opts;
        ctx.finish({ exitCode: 5 });
      });
    expect(
      await runKubicProgram(p, ['demo', '-V'], channels, { code, finished }),
    ).toBe(5);
    expect(seen).toEqual({ verbose: true });
    expect(out).toEqual([]);
  });

  it('CliUsageError / CliExitError become one stderr line and their code', async () => {
    for (const [error, expected] of [
      [new CliUsageError('missing -p'), 2],
      [new CliExitError(5, 'no such session')],
    ] as const) {
      const { err, channels } = io();
      const p = program(channels);
      p.command('demo').action(() => {
        throw error;
      });
      expect(
        await runKubicProgram(p, ['demo'], channels, {
          code: () => 0,
          finished: () => true,
        }),
      ).toBe(expected ?? 5);
      expect(err).toEqual([`error: ${error.message}`]);
    }
  });

  it('any other failure propagates to the root catch-all', async () => {
    const { channels } = io();
    const p = program(channels);
    p.command('demo').action(() => {
      throw new Error('boom');
    });
    await expect(
      runKubicProgram(p, ['demo'], channels, {
        code: () => 0,
        finished: () => true,
      }),
    ).rejects.toThrow('boom');
  });

  it('an action that finishes without a result is an internal error, exit 1', async () => {
    const { err, channels } = io();
    const p = program(channels);
    // A fake command that returns without calling CommandContext.finish.
    let finished = false;
    p.command('demo').action(() => {});
    expect(
      await runKubicProgram(p, ['demo'], channels, {
        code: () => 0,
        finished: () => finished,
      }),
    ).toBe(1);
    expect(err).toEqual([
      "error: internal error: command 'demo' finished without a result",
    ]);
    finished = true;
    err.length = 0;
    expect(
      await runKubicProgram(p, ['demo'], channels, {
        code: () => 0,
        finished: () => finished,
      }),
    ).toBe(0);
    expect(err).toEqual([]);
  });

  it('has no implicit `help` command (it is an unknown command: usage)', async () => {
    const { channels } = io();
    const p = program(channels);
    p.command('demo').action(() => {});
    expect(
      await runKubicProgram(p, ['help'], channels, {
        code: () => 0,
        finished: () => true,
      }),
    ).toBe(2);
  });
});

describe('command registry', () => {
  function registered() {
    const { channels } = io();
    const p = program(channels);
    const { ctx } = context([]);
    registerSessionCommands(p, ctx);
    registerJournalCommands(p, ctx);
    registerAnalysisCommands(p, ctx);
    return p;
  }

  it('registers exactly the commands the usage line lists, once each', () => {
    const names = registered().commands.map((command) => command.name());
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...COMMAND_NAMES].sort());
    expect(COMMAND_NAMES.size).toBe(25);
    expect(ROOT_HELP).toContain('run · tui · resume · attach · sessions');
  });

  it('every command carries a summary for generated help', () => {
    for (const command of registered().commands) {
      expect(command.description(), command.name()).not.toBe('');
    }
  });

  it('each module owns its documented group', () => {
    const owned = (register: typeof registerSessionCommands) => {
      const { channels } = io();
      const p = program(channels);
      register(p, context([]).ctx);
      return p.commands.map((command) => command.name()).sort();
    };
    expect(owned(registerSessionCommands)).toEqual([
      'attach',
      'config',
      'doctor',
      'models',
      'resume',
      'run',
      'sessions',
      'setup',
      'skills',
      'trust',
      'tui',
    ]);
    expect(owned(registerJournalCommands)).toEqual([
      'commit',
      'diff',
      'git',
      'journal',
      'log',
      'status',
      'undo',
    ]);
    expect(owned(registerAnalysisCommands)).toEqual([
      'audit',
      'benchmark',
      'cost',
      'eval',
      'export',
      'policy',
      'replay',
    ]);
  });

  describe('a value option never swallows a following flag', () => {
    async function full(argv: readonly string[]) {
      const { out, err, channels } = io();
      const p = program(channels);
      const calls: string[] = [];
      const runners = new Proxy(
        {},
        {
          get: (_target, key: string) => () => {
            calls.push(key);
            return 0;
          },
        },
      ) as DispatchRunners;
      const ctx: CommandContext = {
        ...context(argv.slice(1)).ctx,
        runners,
      };
      for (const register of [
        registerSessionCommands,
        registerJournalCommands,
        registerAnalysisCommands,
      ]) {
        register(p, ctx);
      }
      const code = await runKubicProgram(p, argv, channels, {
        code: () => 0,
        finished: () => true,
      });
      return { code, out, err, calls };
    }

    it.each([
      [['diff', '--session', '--json'], "'--session <id>'"],
      [['log', '--session', '--json'], "'--session <id>'"],
      [['undo', '--session', '--json'], "'--session <id>'"],
      [['diff', '--session', '--help'], "'--session <id>'"],
      [['cost', '--session', '--json'], "'--session <id>'"],
      [['tui', '--session', '--json'], "'--session <id>'"],
      [['policy', '--tool', '--json'], "'--tool <name>'"],
      [['run', '-p', '--', '--json'], "'-p, --prompt <text>'"],
      [['run', '-p', '--', 'x'], "'-p, --prompt <text>'"],
      [['run', '-p', '--session', 's', 'x'], "'-p, --prompt <text>'"],
    ])('%j exits 2 before any runner', async (argv, flag) => {
      const result = await full(argv);
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.out).toEqual([]);
      expect(result.err).toHaveLength(1);
      expect(result.err[0]).toContain(`error: option ${flag} argument missing`);
    });

    it('names the attached spelling for a flag-like value', async () => {
      const { err } = await full(['diff', '--session', '--json']);
      expect(err[0]).toContain('"--json" looks like a flag');
      expect(err[0]).toContain("--session='--json'");
    });

    it('still accepts attached and single-dash values', async () => {
      expect((await full(['run', '--prompt=--json'])).calls).toEqual(['run']);
      expect((await full(['run', '-p', '- bullet'])).calls).toEqual(['run']);
      expect(
        (await full(['run', '-p', 'a', '--', '--session', '--json'])).code,
      ).toBe(2);
    });
  });

  it('an unknown option prints exactly one stderr line (no suggestion)', async () => {
    const { err, channels } = io();
    const p = program(channels);
    p.command('demo')
      .option('--json', 'json')
      .action(() => {});
    expect(
      await runKubicProgram(p, ['demo', '--jsn'], channels, {
        code: () => 0,
        finished: () => true,
      }),
    ).toBe(2);
    expect(err).toEqual(["error: unknown option '--jsn'"]);
  });
});
