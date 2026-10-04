// The interactive TUI's slash-command registry (issue #305; §16.4, §16.5,
// §66).
//
// One source of truth for what a `/`-command is: the palette rows, the
// editor's autocomplete, `/help` and the submit path's dispatcher all read
// this list, so a command that exists is discoverable and a command that
// does not is refused locally instead of being sent to the model as a
// prompt. Each entry names the §66 `PresentationCommand` it issues (absent
// for a purely local read like `/help`), which is what makes the dispatcher
// typed rather than a string switch.
//
// Presentation only: the registry says what a command is and which typed
// command it maps to; the composition root owns what each one DOES (it is
// the only layer that can reach the lane, the journal and the sessions
// store).

import type { PresentationCommand } from '../../core/src/presentation.js';
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from './tui-boundary.js';

export interface SlashCommandSpec {
  /** The name without the slash (`'help'`). */
  readonly name: string;
  /** One line for the palette and `/help`. */
  readonly summary: string;
  /** The usage line (`'/help [command]'`). */
  readonly usage: string;
  /**
   * The §66 command this issues. Absent for a local action or a local read
   * (`/help`, `/session`, `/diff`, `/undo`) — those never reach the lane.
   */
  readonly command?: PresentationCommand;
  /** The key equivalent, when one exists (shown by `/help`). */
  readonly keys?: string;
  /** What the argument is, for the autocomplete's hint. */
  readonly argumentHint?: string;
}

// The shipped command set. `/model`, `/thinking` and `/compact` ship from
// their own issues (#227, #328, #330) and are listed here because they
// exist: a palette that hides working capabilities is worse than one that
// names them.
export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  {
    name: 'help',
    summary: 'list the commands, or one command’s usage',
    usage: '/help [command]',
    argumentHint: 'command',
  },
  {
    name: 'session',
    summary: 'session id, model, tokens and cost',
    usage: '/session',
  },
  {
    name: 'new',
    summary: 'start a fresh session without leaving the TUI',
    usage: '/new',
    command: 'session.attach',
  },
  {
    name: 'resume',
    summary: 'switch to another session',
    usage: '/resume',
    command: 'session.attach',
  },
  {
    name: 'diff',
    summary: 'the current run’s changes',
    usage: '/diff',
    keys: 'Ctrl-O',
  },
  {
    name: 'undo',
    summary: 'restore the journaled changes',
    usage: '/undo',
  },
  {
    // No §66 command: quitting ends the process (the session close is part
    // of that), which the presentation vocabulary does not name.
    name: 'quit',
    summary: 'leave the TUI',
    usage: '/quit',
    keys: 'Esc',
  },
  {
    name: 'model',
    summary: 'switch the live lane’s model',
    usage: '/model [provider/id]',
    keys: 'Alt+M',
    argumentHint: 'provider/id',
    command: 'model.select',
  },
  {
    name: 'thinking',
    summary: 'set the live lane’s thinking level',
    usage: '/thinking [level]',
    keys: 'Alt+T',
    argumentHint: 'level',
    command: 'thinking.cycle',
  },
  {
    name: 'compact',
    summary: 'compact the session’s context',
    usage: '/compact [instructions]',
    argumentHint: 'instructions',
    command: 'lane.compact',
  },
];

export const SLASH_COMMAND_NAMES: ReadonlySet<string> = new Set(
  SLASH_COMMANDS.map((spec) => spec.name),
);

export function findSlashCommand(name: string): SlashCommandSpec | undefined {
  return SLASH_COMMANDS.find((spec) => spec.name === name);
}

// One parsed draft: the command name and the rest, verbatim (the individual
// commands own their own argument rules). `undefined` means the draft is a
// prompt, not a command — including a bare `/` and a `//`-prefixed line.
export interface ParsedSlashCommand {
  readonly name: string;
  readonly argument: string;
}

export function parseSlashCommand(
  input: string,
): ParsedSlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/') || trimmed === '/') return undefined;
  const body = trimmed.slice(1);
  // A `//`-prefixed line is the explicit escape hatch: a prompt that starts
  // with a slash, never a command.
  if (body.startsWith('/')) return undefined;
  const space = body.search(/\s/);
  if (space === -1) return { name: body, argument: '' };
  return {
    name: body.slice(0, space),
    argument: body.slice(space + 1).trim(),
  };
}

/** Whether a draft is a slash command this TUI knows. */
export function isKnownSlashCommand(input: string): boolean {
  const parsed = parseSlashCommand(input);
  return parsed !== undefined && SLASH_COMMAND_NAMES.has(parsed.name);
}

// The commands whose name starts with the draft's command prefix (`'he'` →
// `/help`), for the autocomplete and the palette's filter.
export function matchingSlashCommands(
  prefix: string,
  commands: readonly SlashCommandSpec[] = SLASH_COMMANDS,
): readonly SlashCommandSpec[] {
  const body = prefix.startsWith('/') ? prefix.slice(1) : prefix;
  if (body.includes(' ')) return [];
  return commands.filter((spec) => spec.name.startsWith(body));
}

// The palette's rows: `value` is the command with its slash (what the
// editor/loop receives), `label` the name, `description` the summary plus
// the key equivalent when there is one.
export interface SlashCommandRow {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export function slashCommandRows(
  commands: readonly SlashCommandSpec[] = SLASH_COMMANDS,
): readonly SlashCommandRow[] {
  return commands.map((spec) => ({
    value: spec.usage.split(' ')[0] ?? `/${spec.name}`,
    label: `/${spec.name}${spec.argumentHint === undefined ? '' : ` <${spec.argumentHint}>`}`,
    description:
      spec.keys === undefined ? spec.summary : `${spec.summary} · ${spec.keys}`,
  }));
}

// `/help`'s body: one line per command, generated from the registry — the
// palette and the printed help can never drift.
export function helpLines(
  commands: readonly SlashCommandSpec[] = SLASH_COMMANDS,
): readonly string[] {
  return commands.map((spec) => {
    const keys = spec.keys === undefined ? '' : ` (${spec.keys})`;
    return `${spec.usage} — ${spec.summary}${keys}`;
  });
}

// The editor's autocomplete provider (issue #305): a draft that starts with
// `/` and has no space yet offers the registry's commands, so `/` alone
// lists them and `/he<Tab>` completes `/help`. Presentation only — it
// completes TEXT; the submit path still parses and dispatches.
export class SlashCommandAutocomplete implements AutocompleteProvider {
  readonly triggerCharacters = ['/'];
  private readonly commands: readonly SlashCommandSpec[];

  constructor(commands: readonly SlashCommandSpec[] = SLASH_COMMANDS) {
    this.commands = commands;
  }

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? '';
    const before = line.slice(0, cursorCol);
    if (!before.startsWith('/') || before.includes(' ')) {
      return Promise.resolve(null);
    }
    const matches = matchingSlashCommands(before, this.commands);
    if (matches.length === 0) return Promise.resolve(null);
    return Promise.resolve({
      prefix: before,
      items: matches.map((spec) => ({
        value: `/${spec.name}`,
        label: `/${spec.name}${spec.argumentHint === undefined ? '' : ` <${spec.argumentHint}>`}`,
        description: spec.summary,
      })),
    });
  }

  // The suggestion is always the line's first token (see getSuggestions), so
  // the completion replaces the prefix and leaves the cursor after it.
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    _prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const next = [...lines];
    const line = next[cursorLine] ?? '';
    next[cursorLine] = `${item.value}${line.slice(cursorCol)}`;
    return { lines: next, cursorLine, cursorCol: item.value.length };
  }
}
