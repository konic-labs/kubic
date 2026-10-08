// The root help (`kubic --help`).
// Commands are grouped by job; the same table is the source of the command
// names the dispatcher routes (dispatch.ts COMMAND_NAMES), so a command can
// never ship without a place in the help. Plain when piped (the binary
// contract pins that text literally), coloured on a TTY.

import { type CliTheme, createCliTheme } from '@kubic/core/cli/theme';
import { padVisible } from '@kubic/core/cli/width';

export interface CommandGroup {
  readonly label: string;
  readonly commands: readonly string[];
  readonly summary: string;
}

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    label: 'session',
    commands: ['run', 'tui', 'resume', 'attach', 'sessions'],
    summary: 'work with the agent',
  },
  {
    label: 'changes',
    commands: ['diff', 'undo', 'log', 'status', 'commit', 'git', 'journal'],
    summary: 'review and revert what it did',
  },
  {
    label: 'setup',
    commands: ['setup', 'models', 'config', 'trust', 'doctor', 'skills'],
    summary: 'providers, project, health',
  },
  {
    label: 'analysis',
    commands: [
      'cost',
      'eval',
      'benchmark',
      'replay',
      'export',
      'policy',
      'audit',
    ],
    summary: '',
  },
];

const LABEL_WIDTH = 11;

const USAGE: readonly (readonly [form: string, meaning: string])[] = [
  ['kubic', 'open the TUI (on a terminal)'],
  ['kubic "<prompt>"', 'run one prompt, like kubic run -p'],
  ['kubic <command> [options]', ''],
];

const EXAMPLES: readonly string[] = [
  'kubic "fix the failing test"',
  'kubic run -p "add tests for titleCase" --json',
  'kubic diff && kubic undo',
];

/** The root help for a theme; `createCliTheme('none')` gives the plain text. */
export function renderRootHelp(theme: CliTheme): string {
  const ui = theme.ui;
  const label = (text: string): string =>
    ui.style({ fg: 'fg2', bold: true })(
      padVisible(text.toUpperCase(), LABEL_WIDTH),
    );
  const blank = ' '.repeat(LABEL_WIDTH);
  const muted = ui.fg('fg2');
  const command = ui.fg('fg0');
  const example = ui.fg('fg1');
  const dot = ui.fg('fg3')(' · ');

  const lines: string[] = [
    `${ui.style({ fg: 'accent', bold: true })('■ kubic')} ${muted('— terminal coding agent by Konic')}`,
    '',
  ];

  const formWidth = Math.max(...USAGE.map(([form]) => form.length));
  USAGE.forEach(([form, meaning], index) => {
    const head = index === 0 ? label('usage') : blank;
    const text =
      meaning === ''
        ? command(form)
        : `${command(padVisible(form, formWidth))}   ${muted(meaning)}`;
    lines.push(`${head}${text}`.trimEnd());
  });
  lines.push('');

  const listed = COMMAND_GROUPS.map((group) => group.commands.join(' · '));
  const listWidth = Math.max(
    ...COMMAND_GROUPS.map((group, index) =>
      group.summary === '' ? 0 : (listed[index] ?? '').length,
    ),
  );
  for (const group of COMMAND_GROUPS) {
    const names = group.commands.map((name) => command(name)).join(dot);
    const plainWidth = group.commands.join(' · ').length;
    const padding = ' '.repeat(Math.max(0, listWidth - plainWidth));
    const summary =
      group.summary === '' ? '' : `${padding}   ${muted(group.summary)}`;
    lines.push(`${label(group.label)}${names}${summary}`);
  }
  lines.push('');

  EXAMPLES.forEach((text, index) => {
    lines.push(`${index === 0 ? label('examples') : blank}${example(text)}`);
  });
  lines.push('');
  lines.push(
    `${example('kubic <command> --help')}${muted(' for options · ')}${example('docs/cli/README.md')}`,
  );
  return lines.join('\n');
}

/** The plain root help: what pipes, files and the binary contract see. */
export const ROOT_HELP = renderRootHelp(createCliTheme('none'));
