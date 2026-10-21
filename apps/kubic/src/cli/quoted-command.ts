// A quoted command is not a prompt. A single argv token with whitespace is
// the headline prompt form (`kubic "fix the failing test"`), but a token that
// reads exactly as a Kubic command — `kubic "sessions list"` from a script or
// an alias — must never start a model run: each of its words is the command
// name, one of the command's subcommands, or an option. A prompt that only
// starts with a command word (`kubic "commit the staged changes"`) still
// runs.

import { COMMAND_GROUPS } from './root-help.js';

// The subcommands of the command groups. program.test.ts pins this table
// against the registered commander program, so the two cannot drift apart.
/** @internal */
export const SUBCOMMANDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['sessions', ['create', 'list', 'attach', 'fork', 'export', 'prune']],
  ['journal', ['prune']],
  ['git', ['status', 'log', 'stage', 'commit']],
  ['policy', ['explain', 'pull', 'sign']],
  ['audit', ['verify', 'flush']],
  ['keys', ['set', 'list', 'remove']],
]);

const COMMANDS: ReadonlySet<string> = new Set(
  COMMAND_GROUPS.flatMap((group) => group.commands),
);

export function isQuotedCommand(token: string): boolean {
  const [name, ...rest] = token.trim().split(/\s+/u);
  if (name === undefined || !COMMANDS.has(name)) return false;
  const subcommands = SUBCOMMANDS.get(name) ?? [];
  return rest.every(
    (word) => word.startsWith('-') || subcommands.includes(word),
  );
}
