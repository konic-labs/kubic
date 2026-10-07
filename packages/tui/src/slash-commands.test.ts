// The slash-command registry: the palette, `/help`, the
// editor's autocomplete and the submit path's dispatcher all read this one
// list, so a command that exists is discoverable and an unknown one is
// refused locally instead of being sent to the model.
import { describe, expect, it } from 'vitest';
import { isPresentationCommand } from '../../core/src/presentation.js';
import { DEFAULT_KEY_REGISTRY } from './keybindings.js';
import {
  findSlashCommand,
  helpLines,
  isKnownSlashCommand,
  matchingSlashCommands,
  parseSlashCommand,
  SLASH_COMMANDS,
  SlashCommandAutocomplete,
  skillCommandSpecs,
} from './slash-commands.js';

describe('slash-command registry', () => {
  it('lists the shipped commands exactly once, each with usage and summary', () => {
    const names = SLASH_COMMANDS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of SLASH_COMMANDS) {
      expect(spec.summary.length).toBeGreaterThan(0);
      expect(spec.usage.startsWith(`/${spec.name}`)).toBe(true);
    }
    // The eight commands this issue ships, plus the three that shipped from
    // their own issues and are listed so the palette does not hide them.
    for (const name of [
      'help',
      'session',
      'new',
      'resume',
      'diff',
      'undo',
      'quit',
      'model',
      'scoped-models',
      'thinking',
      'compact',
      'safety',
    ]) {
      expect(findSlashCommand(name)?.name).toBe(name);
    }
  });

  it('maps every non-local command to the vocabulary', () => {
    // The dispatcher is keyed by PresentationCommand, never a bare string:
    // an entry that names a command outside the contract would fail here.
    for (const spec of SLASH_COMMANDS) {
      if (spec.command === undefined) continue;
      expect(isPresentationCommand(spec.command)).toBe(true);
    }
    // `/new` and `/resume` both attach (the dispatcher keys off this); the
    // local reads and `/quit` carry no presentation command.
    expect(findSlashCommand('new')?.command).toBe('session.attach');
    expect(findSlashCommand('resume')?.command).toBe('session.attach');
    expect(findSlashCommand('model')?.command).toBe('model.select');
    expect(findSlashCommand('thinking')?.command).toBe('thinking.cycle');
    expect(findSlashCommand('compact')?.command).toBe('lane.compact');
    // A local read (or a process-exiting command) issues nothing.
    expect(findSlashCommand('help')?.command).toBeUndefined();
    expect(findSlashCommand('session')?.command).toBeUndefined();
    expect(findSlashCommand('diff')?.command).toBeUndefined();
    expect(findSlashCommand('undo')?.command).toBeUndefined();
    expect(findSlashCommand('quit')?.command).toBeUndefined();
  });

  it('parses the command name and its verbatim argument', () => {
    expect(parseSlashCommand('/help')).toEqual({ name: 'help', argument: '' });
    expect(parseSlashCommand('/help model')).toEqual({
      name: 'help',
      argument: 'model',
    });
    expect(parseSlashCommand('/compact  keep the failing test names ')).toEqual(
      {
        name: 'compact',
        argument: 'keep the failing test names',
      },
    );
    // Not commands: a bare slash, a prompt, and a `//` line.
    expect(parseSlashCommand('/')).toBeUndefined();
    expect(parseSlashCommand('hello')).toBeUndefined();
    expect(parseSlashCommand('// a comment')).toBeUndefined();
    expect(parseSlashCommand('  ')).toBeUndefined();
  });

  it('knows which drafts are commands and which are prompts', () => {
    expect(isKnownSlashCommand('/help')).toBe(true);
    expect(isKnownSlashCommand('/quit')).toBe(true);
    expect(isKnownSlashCommand('/foo')).toBe(false);
    expect(isKnownSlashCommand('/help me')).toBe(true);
    expect(isKnownSlashCommand('please /help')).toBe(false);
  });

  it('matches completions by the command prefix only', () => {
    expect(matchingSlashCommands('/he').map((spec) => spec.name)).toEqual([
      'help',
    ]);
    expect(matchingSlashCommands('/').length).toBe(SLASH_COMMANDS.length);
    expect(matchingSlashCommands('/zzz')).toEqual([]);
    // Past the name the argument is the command's own business.
    expect(matchingSlashCommands('/help m')).toEqual([]);
  });

  it('renders the help lines from the registry', () => {
    const lines = helpLines();
    expect(lines).toHaveLength(SLASH_COMMANDS.length);
    expect(lines.some((line) => line.startsWith('/quit — '))).toBe(true);
  });
});

describe('slash-command keys', () => {
  // The palette shows a command's key from the live key registry; `/help`
  // prints the static `keys`. They must name the same default binding.
  it("every printed key is its action's default binding", () => {
    const normalize = (keys: string): string =>
      keys.toLowerCase().replaceAll('-', '+');
    for (const spec of SLASH_COMMANDS) {
      expect(spec.keys === undefined).toBe(spec.keyAction === undefined);
      if (spec.keys === undefined || spec.keyAction === undefined) continue;
      expect(normalize(spec.keys)).toBe(
        DEFAULT_KEY_REGISTRY.label(spec.keyAction),
      );
    }
  });
});

describe('slash-command autocomplete', () => {
  const provider = new SlashCommandAutocomplete();

  it('offers every command for a bare slash', async () => {
    const suggestions = await provider.getSuggestions(['/'], 0, 1);
    expect(suggestions?.prefix).toBe('/');
    expect(suggestions?.items).toHaveLength(SLASH_COMMANDS.length);
    expect(suggestions?.items.map((item) => item.value)).toContain('/help');
  });

  it('narrows to the prefix and carries the argument hint', async () => {
    const suggestions = await provider.getSuggestions(['/mod'], 0, 4);
    expect(suggestions?.items).toEqual([
      {
        value: '/model',
        label: '/model <provider/id>',
        description: findSlashCommand('model')?.summary,
      },
    ]);
  });

  it('stays quiet for prompts, past the name, and unknown prefixes', async () => {
    expect(await provider.getSuggestions(['hello'], 0, 5)).toBeNull();
    expect(await provider.getSuggestions(['/help m'], 0, 7)).toBeNull();
    expect(await provider.getSuggestions(['/zzz'], 0, 4)).toBeNull();
    expect(await provider.getSuggestions([''], 0, 0)).toBeNull();
  });

  it('completes the command name and leaves the cursor after it', () => {
    const applied = provider.applyCompletion(
      ['/he'],
      0,
      3,
      { value: '/help', label: '/help' },
      '/he',
    );
    expect(applied.lines).toEqual(['/help']);
    expect(applied.cursorLine).toBe(0);
    expect(applied.cursorCol).toBe(5);
    // A cursor in the middle keeps the tail.
    const middle = provider.applyCompletion(
      ['/he rest'],
      0,
      3,
      { value: '/help', label: '/help' },
      '/he',
    );
    expect(middle.lines).toEqual(['/help rest']);
  });
});

describe('per-skill /skill: rows', () => {
  it('builds one local row per booted skill name', () => {
    const specs = skillCommandSpecs(['hidden', 'open']);
    expect(specs.map((spec) => spec.name)).toEqual([
      'skill:hidden',
      'skill:open',
    ]);
    for (const spec of specs) {
      // A local read like /help: no presentation command, never dispatched.
      expect(spec.command).toBeUndefined();
      expect(spec.usage.startsWith(`/${spec.name}`)).toBe(true);
    }
  });

  it('completes /skill: prefixes without joining the registry', async () => {
    expect(findSlashCommand('skill')?.command).toBeUndefined();
    // The static entry stays the registry's only skill row: per-skill rows
    // live in the editor provider alone, so /help and the palette never
    // enumerate skill names.
    expect(
      SLASH_COMMANDS.filter((spec) => spec.name.startsWith('skill:')),
    ).toEqual([]);
    const provider = new SlashCommandAutocomplete([
      ...SLASH_COMMANDS,
      ...skillCommandSpecs(['hidden']),
    ]);
    const suggestions = await provider.getSuggestions(['/skill:hi'], 0, 9);
    expect(suggestions?.items.map((item) => item.value)).toEqual([
      '/skill:hidden',
    ]);
  });
});
