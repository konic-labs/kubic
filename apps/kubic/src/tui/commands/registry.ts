// The handlers behind the slash-command registry (`@kubic/tui/slash-commands`),
// one per registry name. The palette, the editor's autocomplete and `/help`
// list the registry's specs; the submit path runs these handlers, so every
// listed command does something and nothing else is a command.
import { sessionSwitchCommands } from '../session-switch.js';
import { appearanceCommands } from './appearance.js';
import { compactCommands } from './compact.js';
import type { TuiCommandHandler } from './handler.js';
import { helpCommands } from './help.js';
import { journalCommands } from './journal.js';
import { mediaCommands } from './media.js';
import { modelCommands } from './model.js';
import { sessionCommands } from './session.js';

export const TUI_COMMANDS: ReadonlyMap<string, TuiCommandHandler> = new Map(
  Object.entries({
    ...helpCommands,
    ...sessionCommands,
    ...sessionSwitchCommands,
    ...journalCommands,
    ...modelCommands,
    ...compactCommands,
    ...mediaCommands,
    ...appearanceCommands,
  }),
);
