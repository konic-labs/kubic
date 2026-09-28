// Change-journal commands (VCS-independent): diff, undo, log, status, plus
// the git helper. Registered on the root program by ../dispatch.ts.

import type { CommandRegistrar } from '../cli/context.js';
import { registerForwarder } from '../cli/program.js';

const JOURNAL: readonly (readonly [string, string])[] = [
  ['diff', 'show journaled changes'],
  ['undo', 'restore journaled changes'],
  ['log', 'list journaled steps'],
  ['status', 'summarize the journal'],
];

export const registerJournalCommands: CommandRegistrar = (program, ctx) => {
  const { runners, config } = ctx;
  for (const [name, summary] of JOURNAL) {
    // The journal runner takes the command name as its first argv entry.
    registerForwarder(
      program,
      ctx,
      name,
      (rest) => runners.journal([name, ...rest], config),
      { summary },
    );
  }
  registerForwarder(program, ctx, 'git', (rest) => runners.git(rest, config), {
    summary: 'git helpers over the session journal',
  });
};
