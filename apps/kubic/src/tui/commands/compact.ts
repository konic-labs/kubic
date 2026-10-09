// `/compact [instructions]`: a lane operation, never a prompt. It runs
// through the same busy/cancel wrapper as a turn, so the spinner shows and
// Ctrl-C aborts it; the command text itself never reaches the model or the
// transcript.
import { TuiCompactionTurn } from '../compaction-turn.js';
import { startTurn } from '../turns.js';
import { notImplemented, refuse, type TuiCommandTable } from './handler.js';
import { parseTuiCompactCommand } from './parse.js';

export const compactCommands: TuiCommandTable = {
  compact: {
    lane: true,
    run(ctx, { prompt, busy }) {
      const command = parseTuiCompactCommand(prompt);
      if (command === undefined) return notImplemented(ctx, 'compact');
      const lane = ctx.boot.loop;
      if (busy) {
        return refuse(
          ctx,
          'compact: finish the current turn before compacting',
        );
      }
      if (lane?.compact === undefined) {
        return refuse(ctx, 'compaction needs a live lane');
      }
      startTurn(
        ctx,
        new TuiCompactionTurn(lane, command.focus, async () => {
          // The compaction entry is committed by the task, not
          // by a turn's event stream, so the transcript is re-read once
          // the task settles — the compaction cell then appears in the
          // same session (and in the quit's printed document).
          await ctx.turn?.refreshTranscript();
        }),
        prompt,
      );
      return 'accepted';
    },
  },
};
