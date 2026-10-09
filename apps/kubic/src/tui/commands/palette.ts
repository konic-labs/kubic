// Ctrl-P's grouped palette. The app owns the command and file rows; this
// boot supplies the model catalog and this project's other sessions, and the
// actions behind them: a command row is submitted exactly as if typed (the
// submit path dispatches it through the command registry), a model row
// switches like the picker, a session row resumes like `/resume`.
import type { TuiContext } from '../context.js';
import { resumeSession } from '../session-switch.js';
import { submitPrompt } from '../submit.js';
import { switchModelTo } from './model.js';

export function openPalette(ctx: TuiContext): void {
  if (ctx.stopped) return;
  const runner = ctx.turn;
  const { boot } = ctx;
  const list = boot.listSessions;
  const opened = ctx.app.openPalette({
    runCommand: (command) => {
      submitPrompt(ctx, command, false);
    },
    ...(runner === undefined
      ? {}
      : {
          models: async () => runner.listModels(),
          switchModel: (provider: string, id: string) => {
            if (ctx.busy()) {
              ctx.say('model: finish the current turn before switching');
              return;
            }
            switchModelTo(ctx, { provider, id });
          },
        }),
    ...(boot.summarizeSessions !== undefined
      ? {
          // The summaries `/resume` lists (titled, this
          // project only); a held session cannot resume.
          sessions: async () =>
            ((await ctx.boot.summarizeSessions?.(ctx.boot.sessionId)) ?? [])
              .filter((summary) => summary.state === 'ready')
              .map((summary) => ({
                id: summary.id,
                ...(summary.title === undefined
                  ? {}
                  : { title: summary.title }),
                ...(summary.createdAt === undefined
                  ? {}
                  : { createdAt: summary.createdAt }),
                ...(summary.turns === undefined
                  ? {}
                  : { turns: summary.turns }),
              })),
          resumeSession: (id: string) => resumeSession(ctx, id),
        }
      : list === undefined
        ? {}
        : {
            sessions: async () =>
              (await list()).filter(
                (row) =>
                  row.id !== ctx.boot.sessionId &&
                  (ctx.boot.cwd === undefined ||
                    row.cwd === undefined ||
                    row.cwd === ctx.boot.cwd),
              ),
            resumeSession: (id: string) => resumeSession(ctx, id),
          }),
    onCancel: () => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter('palette: cancelled');
      ctx.screen?.render();
    },
  });
  if (!opened) {
    ctx.app.setEditorFooter('palette needs a wider terminal — type /help');
  }
  ctx.render();
}
