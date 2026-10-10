// The session's own reads and posture: `/session`, `/safety`, and
// `/approvals` with the full-access toggle behind Alt+A.
import { noIsolationNoticeLines } from '@kubic/host/doctor';
import type { TuiSubmitOutcome } from '@kubic/tui/tui-app';
import type { TuiContext } from '../context.js';
import { refuse, type TuiCommandTable } from './handler.js';

export const sessionCommands: TuiCommandTable = {
  session: {
    run(ctx) {
      const report = ctx.app.sessionReport(ctx.boot.cwd);
      ctx.app.appendNotice([report]);
      ctx.say(report);
      return 'accepted';
    },
  },
  safety: {
    run(ctx) {
      // The honest limits, in full. The wording is the
      // limits module's (never re-worded here), and an explicit ask is
      // answered even where the startup notice is suppressed.
      ctx.app.appendNotice(
        noIsolationNoticeLines().map((line) => line.replace(/^warning: /, '')),
      );
      ctx.say('safety: the limits are in the transcript');
      // A local read with its own output: no prompt echo under it.
      return 'command';
    },
  },
  approvals: {
    run(ctx, command) {
      const argument = command.argument.trim().toLowerCase();
      if (argument === '') {
        ctx.say(
          ctx.fullAccessLive()
            ? 'approvals: OFF — full access for this session'
            : 'approvals: on — challenged calls ask',
        );
        return 'accepted';
      }
      // The argument names the state of APPROVALS (the header's
      // `approvals on` / `approvals OFF`), so it never flips the other way.
      // `on` in a session that is already on is a report, and so is `off`
      // in a session that is already off — no dialog, and no posture row for
      // a change that did not happen. Only `Alt+A` toggles.
      if (argument === 'on') {
        if (!ctx.fullAccessLive()) {
          ctx.say('approvals: already on — challenged calls ask');
          return 'accepted';
        }
        return applyFullAccess(ctx, false);
      }
      if (argument === 'off') {
        if (ctx.fullAccessLive()) {
          ctx.say('approvals: already OFF — full access for this session');
          return 'accepted';
        }
        return openFullAccessConfirm(ctx);
      }
      return refuse(
        ctx,
        `approvals: expected 'on' or 'off' (got '${command.argument}')`,
      );
    },
  },
};

// `Alt+A` is the TOGGLE: an already-on session flips off through it.
export function toggleFullAccess(ctx: TuiContext): TuiSubmitOutcome {
  return ctx.fullAccessLive()
    ? applyFullAccess(ctx, false)
    : openFullAccessConfirm(ctx);
}

// The in-session full-access toggle. The host
// path writes posture.json + one audit row and flips the INSTALLED
// policy's live posture, so the next challenged call follows; the
// indicator is re-read from the same predicate in this frame.
function applyFullAccess(ctx: TuiContext, enabled: boolean): TuiSubmitOutcome {
  const setFullAccess = ctx.boot.setFullAccess;
  if (setFullAccess === undefined) {
    return refuse(ctx, 'approvals: this session cannot change its posture');
  }
  try {
    const grant = setFullAccess(enabled);
    ctx.syncPosture();
    ctx.app.appendNotice([grant.warning]);
    ctx.app.setEditorFooter(
      enabled
        ? 'approvals: OFF — every challenged call in this session runs without asking'
        : 'approvals: on again — the next challenged call asks',
    );
  } catch (error) {
    ctx.app.setEditorFooter(
      `approvals: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  ctx.render();
  return 'accepted';
}

// Turning approvals off asks first (the dialog names the consequence);
// turning them back on is immediate. The dialog accepts only its deliberate
// key.
//
// The confirmation is a modal of its
// own and `Alt+A` is a GLOBAL key, so it would otherwise open OVER a
// pending approval — where its advertised Ctrl-S is swallowed by the
// approval surface and Esc/Ctrl-C DENY the challenged call instead of
// cancelling the dialog. One modal at a time: while an approval owns
// the keys the confirmation refuses by name.
function openFullAccessConfirm(ctx: TuiContext): TuiSubmitOutcome {
  if (ctx.stopped) return 'refused';
  if (ctx.app.hasPendingApproval()) {
    return refuse(ctx, 'approvals: answer the pending request first');
  }
  const opened = ctx.app.openConfirm({
    title: 'turn approvals off for this session?',
    body: [
      'every challenged call in this session will run without asking',
      'the change is written to posture.json and one audit row',
    ],
    confirmKey: 'ctrl+s',
    confirmLabel: 'Ctrl-S',
    onConfirm: () => {
      applyFullAccess(ctx, true);
    },
    onCancel: () => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter('approvals: unchanged');
      ctx.screen?.render();
    },
  });
  if (!opened) {
    return refuse(
      ctx,
      'approvals: the confirmation needs the overlay — this terminal is too narrow',
    );
  }
  ctx.render();
  return 'accepted';
}
