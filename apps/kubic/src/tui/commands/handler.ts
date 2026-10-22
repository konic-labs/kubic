// The contract of a slash-command handler, and the refusals they share.
import type { ParsedSlashCommand } from '@kubic/tui/slash-commands';
import type { TuiSubmitOutcome } from '@kubic/tui/tui-app';
import type { TuiContext } from '../context.js';

interface TuiCommandInput extends ParsedSlashCommand {
  // The submitted draft, for the commands whose parser reads it whole.
  readonly prompt: string;
  // Whether a turn is running.
  readonly busy: boolean;
}

export interface TuiCommandHandler {
  // A lane command configures or drives the lane. It is answered before the
  // submit path's lane check, refusing by name when there is no live lane.
  readonly lane?: boolean;
  run(ctx: TuiContext, command: TuiCommandInput): TuiSubmitOutcome;
}

// A command family's handlers, by registry name.
export type TuiCommandTable = Readonly<Record<string, TuiCommandHandler>>;

export function refuse(ctx: TuiContext, line: string): TuiSubmitOutcome {
  ctx.say(line);
  return 'refused';
}

// The side-effecting commands are refused while a turn runs — they swap or
// close the session under it (the quit path's drain is the only place that
// owns that race).
export function busyRefusal(ctx: TuiContext, what: string): TuiSubmitOutcome {
  return refuse(ctx, `${what}: finish the current turn before switching`);
}

// A registered name whose handler cannot read the draft (an argument it
// does not parse) answers like a command this session does not implement.
export function notImplemented(
  ctx: TuiContext,
  name: string,
): TuiSubmitOutcome {
  return refuse(ctx, `'/${name}': not implemented in this session`);
}
