// The grouped root help and styled subcommand help.

import { describe, expect, it } from 'vitest';
import { createCliTheme } from '../../../../packages/core/src/cli/theme.js';
import { openStyles } from '../../../../packages/core/src/ui/style.js';
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  TERMINAL_PALETTE,
} from '../../../../packages/core/src/ui/tokens.js';
import { registerSoloCommands } from '../commands/solo.js';
import type { CliConfigResult } from '../config-runtime.js';
import { COMMAND_NAMES } from '../dispatch.js';
import type { CommandContext, DispatchRunners } from './context.js';
import { createKubicProgram, runKubicProgram } from './program.js';
import { COMMAND_GROUPS, ROOT_HELP, renderRootHelp } from './root-help.js';

const ESC = '\u001b';

describe('the root help', () => {
  it('lists every command in exactly one group', () => {
    const listed = COMMAND_GROUPS.flatMap((group) => group.commands);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...COMMAND_NAMES].sort());
    for (const name of COMMAND_NAMES) {
      expect(ROOT_HELP).toMatch(new RegExp(`(^| )${name}( |$)`, 'm'));
    }
  });

  it('is the grouped plain text when piped', () => {
    expect(ROOT_HELP.split('\n')).toEqual([
      '■ kubic — terminal coding agent by Konic',
      '',
      'USAGE      kubic                       open the TUI (on a terminal)',
      '           kubic "<prompt>"            run one prompt, like kubic run -p',
      '           kubic <command> [options]',
      '',
      'SESSION    run · tui · resume · attach · sessions                work with the agent',
      'CHANGES    diff · undo · log · status · commit · git · journal   review and revert what it did',
      'SETUP      setup · models · config · trust · doctor · skills     providers, project, health',
      'ANALYSIS   cost · eval · benchmark · replay · export · policy · audit',
      '',
      'EXAMPLES   kubic "fix the failing test"',
      '           kubic run -p "add tests for titleCase" --json',
      '           kubic diff && kubic undo',
      '',
      'kubic <command> --help for options · docs/cli/README.md',
    ]);
    expect(ROOT_HELP).not.toContain(ESC);
  });

  it('is coloured on a terminal, with the same visible text', () => {
    const theme = createCliTheme('truecolor');
    const rich = renderRootHelp(theme);
    expect(rich).toContain(
      theme.ui.style({ fg: 'accent', bold: true })('■ kubic'),
    );
    expect(rich).toContain(
      theme.ui.style({ fg: 'fg2', bold: true })('SESSION    '),
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR is the point
    expect(rich.replace(/\u001b\[[0-9;]*m/g, '')).toBe(ROOT_HELP);
  });
});

function contextFor(): CommandContext {
  const fallback = () => 0;
  const runners = new Proxy(
    {},
    { get: () => fallback },
  ) as unknown as DispatchRunners;
  return {
    config: {} as CliConfigResult,
    runners,
    rest: [],
    out: () => {},
    err: () => {},
    finish: () => {},
  };
}

async function subcommandHelp(level: 'none' | 'truecolor'): Promise<string> {
  const out: string[] = [];
  const channels = {
    out: (line: string) => out.push(line),
    err: (line: string) => out.push(line),
  };
  const program = createKubicProgram(channels, {
    versionLine: 'kubic 1.2.3 (license: MIT)',
    rootHelp: ROOT_HELP,
    helpTheme: createCliTheme(level),
  });
  registerSoloCommands(program, contextFor());
  await runKubicProgram(program, ['doctor', '--help'], channels, {
    code: () => 0,
    finished: () => true,
  });
  return out.join('\n');
}

describe('subcommand help styling', () => {
  it('stays plain commander text without a coloured theme', async () => {
    const plain = await subcommandHelp('none');
    expect(plain).toContain('Usage: kubic doctor');
    expect(plain).not.toContain(ESC);
  });

  it('styles titles and terms on a coloured terminal', async () => {
    const theme = createCliTheme('truecolor');
    const rich = await subcommandHelp('truecolor');
    expect(rich).toContain(theme.ui.style({ fg: 'fg2', bold: true })('Usage:'));
    expect(rich).toContain(
      theme.ui.style({ fg: 'fg2', bold: true })('Options:'),
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR is the point
    expect(rich.replace(/\u001b\[[0-9;]*m/g, '')).toBe(
      await subcommandHelp('none'),
    );
  });
});

describe('usage errors on a colour terminal', () => {
  it('are an error block on a coloured stderr, plain otherwise', async () => {
    const run = async (level: 'none' | 'truecolor') => {
      const err: string[] = [];
      const channels = {
        out: () => {},
        err: (line: string) => err.push(line),
      };
      const program = createKubicProgram(channels, {
        versionLine: 'kubic 1.2.3 (license: MIT)',
        rootHelp: ROOT_HELP,
        errorTheme: createCliTheme(level),
      });
      registerSoloCommands(program, contextFor());
      const code = await runKubicProgram(
        program,
        ['doctor', '--bogus'],
        channels,
        { code: () => 0, finished: () => true },
      );
      return { code, text: err.join('\n') };
    };
    const plain = await run('none');
    expect(plain.code).toBe(2);
    expect(plain.text).toBe("error: unknown option '--bogus'");
    const rich = await run('truecolor');
    expect(rich.code).toBe(2);
    const theme = createCliTheme('truecolor');
    expect(rich.text).toContain(theme.ui.fg('err')('✕'));
    expect(rich.text).toContain("unknown option '--bogus'");
    expect(rich.text).toContain(theme.ui.fg('fg1')('--help'));
  });
});

// The root help in every palette and colour level — no escape
// at depth none, and no line leaves a style open.
describe('root help render matrix', () => {
  it('closes every style it opens, in every palette and level', () => {
    const failures: string[] = [];
    for (const [name, palette] of [
      ['dark', DARK_PALETTE],
      ['light', LIGHT_PALETTE],
      ['terminal', TERMINAL_PALETTE],
    ] as const) {
      for (const level of ['truecolor', '256', '16', 'none'] as const) {
        renderRootHelp(createCliTheme(level, palette, name))
          .split('\n')
          .forEach((line, index) => {
            const where = `${name}/${level} line ${index}`;
            if (level === 'none' && line.includes('\u001b')) {
              failures.push(`${where}: escape at depth none`);
            }
            const open = openStyles(line);
            if (open.length > 0) failures.push(`${where}: ${open.join(', ')}`);
          });
      }
    }
    expect(failures).toEqual([]);
  });
});
