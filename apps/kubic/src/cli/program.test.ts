import { describe, expect, it } from 'vitest';
import {
  CliExitError,
  CliUsageError,
} from '../../../../packages/core/src/cli/exit-codes.js';
import { registerAnalysisCommands } from '../commands/analysis.js';
import { registerJournalCommands } from '../commands/journal.js';
import { registerOrchestratorCommands } from '../commands/orchestrator.js';
import { registerSoloCommands } from '../commands/solo.js';
import type { CliConfigResult } from '../config-runtime.js';
import { COMMAND_NAMES, ROOT_USAGE } from '../dispatch.js';
import type { CommandContext, DispatchRunners } from './context.js';
import {
  createKubicProgram,
  registerForwarder,
  runKubicProgram,
} from './program.js';

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
): { ctx: CommandContext; code: () => number } {
  let code = 0;
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
      setExitCode: (next) => {
        code = next;
      },
    },
    code: () => code,
  };
}

describe('kubic program (commander contracts)', () => {
  it('root --help/-h print the pinned root help on stdout, exit 0', async () => {
    for (const flag of ['--help', '-h']) {
      const { out, err, channels } = io();
      const code = await runKubicProgram(program(channels), [flag], channels, {
        code: () => 99,
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
          code: () => 99,
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
      await runKubicProgram(p, ['demo', '--nope'], channels, { code: () => 0 }),
    ).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^error: unknown option '--nope'/);
    err.length = 0;
    expect(
      await runKubicProgram(p, ['demo', '--limit'], channels, {
        code: () => 0,
      }),
    ).toBe(2);
    expect(err[0]).toMatch(/^error: option '--limit <n>' argument missing/);
  });

  it('a subcommand answers -h with generated help, exit 0', async () => {
    const { out, channels } = io();
    const p = program(channels);
    p.command('demo').description('a demo').option('--json', 'machine output');
    expect(
      await runKubicProgram(p, ['demo', '-h'], channels, { code: () => 1 }),
    ).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Usage: kubic demo');
    expect(text).toContain('--json');
  });

  it('root options are positional: `kubic demo -V` reaches the command', async () => {
    const { out, channels } = io();
    const { ctx, code } = context(['-V']);
    const p = program(channels);
    let seen: readonly string[] = [];
    registerForwarder(
      p,
      ctx,
      'demo',
      (rest) => {
        seen = rest;
        return 7;
      },
      { summary: 'demo' },
    );
    expect(await runKubicProgram(p, ['demo', '-V'], channels, { code })).toBe(
      7,
    );
    expect(seen).toEqual(['-V']);
    expect(out).toEqual([]);
  });

  it('forwarders hand the raw argv through untouched (incl. `--` and --help)', async () => {
    const { channels } = io();
    const rest = ['--', '-weird.json', '--help', '--x=1'];
    const { ctx, code } = context(rest);
    const p = program(channels);
    let seen: readonly string[] = [];
    registerForwarder(
      p,
      ctx,
      'demo',
      (args) => {
        seen = args;
        return 0;
      },
      { summary: 'demo' },
    );
    await runKubicProgram(p, ['demo', ...rest], channels, { code });
    expect(seen).toEqual(rest);
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
        await runKubicProgram(p, ['demo'], channels, { code: () => 0 }),
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
      runKubicProgram(p, ['demo'], channels, { code: () => 0 }),
    ).rejects.toThrow('boom');
  });

  it('has no implicit `help` command', async () => {
    const { channels } = io();
    const p = program(channels);
    p.command('demo').action(() => {});
    expect(
      await runKubicProgram(p, ['help'], channels, { code: () => 0 }),
    ).toBe(1);
  });
});

describe('command registry', () => {
  function registered() {
    const { channels } = io();
    const p = program(channels);
    const { ctx } = context([]);
    registerSoloCommands(p, ctx);
    registerOrchestratorCommands(p, ctx);
    registerJournalCommands(p, ctx);
    registerAnalysisCommands(p, ctx);
    return p;
  }

  it('registers exactly the commands the usage line lists, once each', () => {
    const names = registered().commands.map((command) => command.name());
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...COMMAND_NAMES].sort());
    expect(COMMAND_NAMES.size).toBe(22);
    expect(ROOT_USAGE).toContain('sessions | git');
  });

  it('every command carries a summary for generated help', () => {
    for (const command of registered().commands) {
      expect(command.description(), command.name()).not.toBe('');
    }
  });

  it('each module owns its documented group', () => {
    const owned = (register: typeof registerSoloCommands) => {
      const { channels } = io();
      const p = program(channels);
      register(p, context([]).ctx);
      return p.commands.map((command) => command.name()).sort();
    };
    expect(owned(registerSoloCommands)).toEqual([
      'config',
      'doctor',
      'models',
      'run',
      'sessions',
      'tui',
    ]);
    expect(owned(registerOrchestratorCommands)).toEqual([
      'clean',
      'orchestrate',
      'workers',
    ]);
    expect(owned(registerJournalCommands)).toEqual([
      'diff',
      'git',
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
      'perf',
      'policy',
      'replay',
    ]);
  });
});
