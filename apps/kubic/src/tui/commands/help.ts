// `/help`, `/quit`, and the `/skill` entry the registry lists for discovery.
import {
  findSlashCommand,
  helpLines,
  SLASH_COMMANDS,
} from '@kubic/tui/slash-commands';
import { refuse, type TuiCommandTable } from './handler.js';
import { SKILL_COMMAND_USAGE } from './parse.js';

export const helpCommands: TuiCommandTable = {
  help: {
    run(ctx, command) {
      const wanted =
        command.argument === ''
          ? undefined
          : findSlashCommand(command.argument.replace(/^\//, ''));
      if (command.argument !== '' && wanted === undefined) {
        return refuse(
          ctx,
          `help: unknown command '${command.argument}' — /help lists the commands`,
        );
      }
      const lines =
        wanted === undefined
          ? helpLines()
          : [
              `${wanted.usage} — ${wanted.summary}${
                wanted.keys === undefined ? '' : ` (${wanted.keys})`
              }`,
            ];
      ctx.app.appendNotice(lines);
      ctx.say(
        wanted === undefined
          ? `help: ${SLASH_COMMANDS.length} commands — the list is in the transcript`
          : `help: ${wanted.usage}`,
      );
      return 'accepted';
    },
  },
  quit: {
    run(ctx) {
      ctx.lifecycle.shutdown();
      return 'accepted';
    },
  },
  // `/skill:<name>` runs through the submit path's skill expansion; the space
  // form (`/skill <name>`) is the colon form mistyped.
  skill: {
    run(ctx) {
      return refuse(ctx, SKILL_COMMAND_USAGE);
    },
  },
};
