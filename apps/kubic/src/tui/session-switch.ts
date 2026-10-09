// `/new`, `/resume`, `/fork` and `/tree`: the session is swapped under the
// running TUI. The next lane boots FIRST (a failed boot keeps the session the
// operator was in), the previous one closes, and every lane-bound object and
// session-scoped surface is rebuilt — the alt-screen, the terminal and the app
// itself are never torn down.
import type { EntryRecord } from '@kubic/agent/pi-boundary';
import { formatCost } from '@kubic/core/cli/kit';
import type { SessionSummary } from '@kubic/host/sessions';
import type { ForkPoint } from '@kubic/tui/lane-cells';
import { forkPickerRows, userPromptsOf } from '@kubic/tui/lane-cells';
import type { TuiPickerRow, TuiSubmitOutcome } from '@kubic/tui/tui-app';
import { formatAge } from '@kubic/tui/ui/palette';
import {
  busyRefusal,
  refuse,
  type TuiCommandTable,
} from './commands/handler.js';
import type { TuiContext } from './context.js';
import { laneEntryFor } from './entries.js';
import { buildTurn } from './turns.js';
import type { TuiLaneBoot } from './types.js';

export const sessionSwitchCommands: TuiCommandTable = {
  new: {
    run(ctx, { busy }) {
      if (busy) return busyRefusal(ctx, 'session');
      return openNewSession(ctx);
    },
  },
  resume: {
    run(ctx, { busy }) {
      if (busy) return busyRefusal(ctx, 'session');
      return openResumePicker(ctx);
    },
  },
  tree: {
    run(ctx, { busy }) {
      if (busy) return busyRefusal(ctx, 'fork');
      return openTreePicker(ctx);
    },
  },
  fork: {
    run(ctx, { argument, busy }) {
      if (busy) return busyRefusal(ctx, 'fork');
      const at = /^\d+$/.test(argument) ? Number(argument) : undefined;
      if (at === undefined) {
        return refuse(
          ctx,
          'usage: /fork <entry> — /tree picks an earlier prompt',
        );
      }
      return runFork(ctx, at);
    },
  },
};

async function rebindSession(
  ctx: TuiContext,
  nextSessionId?: string,
): Promise<void> {
  const previous = ctx.boot;
  const next = await ctx.deps.bootLane(
    nextSessionId,
    ctx.surface.seat,
    ctx.flags,
  );
  await previous.close?.();
  await adoptBoot(ctx, next);
}

// Every lane-bound object and session-scoped surface follows the boot.
async function adoptBoot(ctx: TuiContext, next: TuiLaneBoot): Promise<void> {
  ctx.boot = next;
  // Every re-boot (session switch, fork) gets the live
  // counter too — a fresh boot's cell starts unwired.
  next.setCurrentTurnSupplier?.(() => ctx.reconcileTurn);
  ctx.activeTurn = undefined;
  ctx.inFlightTurns = 0;
  ctx.droppedOnCancel = 0;
  ctx.queuedInbox = [];
  ctx.queuedText.clear();
  ctx.shellRanThisTurn = false;
  ctx.reconcileTurn = 0;
  ctx.reconcileTurnOpen = false;
  ctx.turn = buildTurn(ctx);
  ctx.app.resetSession({
    sessionId: next.sessionId,
    model: next.model,
    usage: next.usageRows ?? [],
  });
  ctx.syncPosture();
  ctx.app.setEditorFooter(
    [next.pendingNotice, next.modelNotice]
      .filter((line): line is string => line !== undefined)
      .join(' · '),
  );
  ctx.journalFeed?.now();
  await ctx.turn?.refreshTranscript();
  // After the first read: a transcript snapshot replaces the notice
  // cells, so an earlier append would be wiped. The alt-screen is up, so
  // the new lane's boot notices (full access, skipped skills) join its
  // queued warnings here, as transcript rows and never on stderr.
  const rows = [
    ...(next.notices ?? []).map((notice) => `warning: ${notice}`),
    ...(next.loop?.drainNotices?.() ?? []),
  ];
  for (const line of rows) ctx.app.appendNotice([line]);
  ctx.render();
}

function openNewSession(ctx: TuiContext): TuiSubmitOutcome {
  ctx.say('session: booting a fresh session…');
  void rebindSession(ctx, undefined)
    .then(() => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(`session: ${ctx.boot.sessionId} (new)`);
      ctx.screen?.render();
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `session: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.screen?.render();
    });
  return 'accepted';
}

// `/resume`'s choice, and the palette's SESSIONS rows.
export function resumeSession(ctx: TuiContext, id: string): void {
  if (ctx.busy()) {
    busyRefusal(ctx, 'session');
    return;
  }
  ctx.app.setEditorFooter(`session: attaching ${id}…`);
  ctx.screen?.render();
  void rebindSession(ctx, id)
    .then(() => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(`session: ${ctx.boot.sessionId} (resumed)`);
      ctx.screen?.render();
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `session: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.screen?.render();
    });
}

// One picker row per summarized session — its first
// prompt, then age · turns · cost; a held one greyed with why.
function sessionPickerRow(summary: SessionSummary): TuiPickerRow {
  const created =
    summary.createdAt === undefined
      ? Number.NaN
      : Date.parse(summary.createdAt);
  const detail = [
    Number.isNaN(created) ? undefined : formatAge(Date.now() - created),
    summary.turns === undefined
      ? undefined
      : `${summary.turns} turn${summary.turns === 1 ? '' : 's'}`,
    summary.costUsd === undefined ? undefined : formatCost(summary.costUsd),
  ].filter((part): part is string => part !== undefined);
  return {
    value: summary.id,
    label: summary.title ?? summary.id,
    ...(detail.length === 0 ? {} : { description: detail.join(' · ') }),
    ...(summary.state === 'ready'
      ? {}
      : { disabled: true, note: 'in use by another kubic' }),
  };
}

function openResumePicker(ctx: TuiContext): TuiSubmitOutcome {
  if (ctx.boot.summarizeSessions !== undefined) {
    return openSessionPicker(ctx, ctx.boot.summarizeSessions);
  }
  const list = ctx.boot.listSessions;
  if (list === undefined) {
    return refuse(ctx, 'resume: this session cannot list other sessions');
  }
  void list()
    .then((rows) => {
      if (ctx.stopped) return;
      const others = rows.filter((row) => row.id !== ctx.boot.sessionId);
      if (others.length === 0) {
        ctx.app.setEditorFooter('resume: no other sessions');
        ctx.screen?.render();
        return;
      }
      const opened = ctx.app.openPicker({
        rows: others.map((row) => ({
          value: row.id,
          label: row.id,
          description: [row.cwd, row.createdAt]
            .filter((part): part is string => part !== undefined)
            .join(' · '),
        })),
        onSelect: (id) => resumeSession(ctx, id),
        onCancel: () => {
          if (ctx.stopped) return;
          ctx.app.setEditorFooter('resume: cancelled');
          ctx.screen?.render();
        },
      });
      if (!opened) {
        ctx.app.setEditorFooter(
          'resume needs a wider terminal — use kubic sessions list',
        );
      }
      ctx.screen?.render();
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `resume: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.screen?.render();
    });
  return 'accepted';
}

function openSessionPicker(
  ctx: TuiContext,
  summarize: (exclude?: string) => Promise<readonly SessionSummary[]>,
): TuiSubmitOutcome {
  ctx.say('resume: reading this project’s sessions…');
  void summarize(ctx.boot.sessionId)
    .then((summaries) => {
      if (ctx.stopped) return;
      if (summaries.length === 0) {
        ctx.app.setEditorFooter('resume: no other sessions in this project');
        ctx.screen?.render();
        return;
      }
      ctx.app.setEditorFooter('');
      const opened = ctx.app.openPicker({
        title: 'Session',
        rows: summaries.map(sessionPickerRow),
        onSelect: (id) => resumeSession(ctx, id),
        onCancel: () => {
          if (ctx.stopped) return;
          ctx.app.setEditorFooter('resume: cancelled');
          ctx.screen?.render();
        },
      });
      if (!opened) {
        ctx.app.setEditorFooter(
          'resume needs a wider terminal — use kubic sessions list',
        );
      }
      ctx.screen?.render();
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `resume: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.screen?.render();
    });
  return 'accepted';
}

// Pi-durable branches by forking, so `/fork` and `/tree` fork the live
// session into a NEW session (the store fork) and switch the TUI to it;
// the original keeps the abandoned path. The fork needs the session's
// lock, so this boot closes FIRST; a failed fork re-attaches the session
// the operator was in.
async function forkInto(
  ctx: TuiContext,
  at: number,
  prefill?: string,
): Promise<void> {
  const previous = ctx.boot;
  const fork = previous.forkAt;
  if (fork === undefined) throw new Error('this session cannot fork');
  const sourceId = previous.sessionId;
  await previous.close?.();
  let forkId: string;
  try {
    forkId = await fork(at);
  } catch (error) {
    await adoptBoot(
      ctx,
      await ctx.deps.bootLane(sourceId, ctx.surface.seat, ctx.flags),
    );
    throw error;
  }
  await adoptBoot(
    ctx,
    await ctx.deps.bootLane(forkId, ctx.surface.seat, ctx.flags),
  );
  if (prefill !== undefined) ctx.app.editor.setText(prefill);
  ctx.app.setEditorFooter(
    `fork: ${forkId} — from ${sourceId} at #${at}${prefill === undefined ? '' : ' (edit the prompt and press enter)'}`,
  );
}

function runFork(
  ctx: TuiContext,
  at: number,
  prefill?: string,
): TuiSubmitOutcome {
  ctx.say(`fork: forking at #${at}…`);
  void forkInto(ctx, at, prefill)
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `fork: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      ctx.render();
    });
  return 'accepted';
}

// `/tree`: the lane's earlier prompts, each forking just BEFORE itself.
function openTreePicker(ctx: TuiContext): TuiSubmitOutcome {
  const loop = ctx.boot.loop;
  if (loop === undefined || ctx.boot.forkAt === undefined) {
    return refuse(ctx, 'tree: this session cannot fork');
  }
  void loop
    .entries(loop.context)
    .then((raw) => {
      if (ctx.stopped) return;
      const sorted = [...raw].sort((a, b) => Number(a.id) - Number(b.id));
      const points: ForkPoint[] = [];
      for (let i = 1; i < sorted.length; i += 1) {
        const lane = laneEntryFor(sorted[i] as EntryRecord);
        const text = lane === undefined ? undefined : userPromptsOf([lane])[0];
        if (text === undefined) continue;
        points.push({
          entryId: Number(sorted[i]?.id),
          at: Number(sorted[i - 1]?.id),
          text,
        });
      }
      if (points.length === 0) {
        ctx.app.setEditorFooter('tree: no earlier prompts to fork from');
        ctx.screen?.render();
        return;
      }
      const opened = ctx.app.openPicker({
        rows: forkPickerRows(points),
        onSelect: (value) => {
          const [at, entryId] = value.split(':').map(Number);
          const point = points.find((p) => p.entryId === entryId);
          if (at === undefined || point === undefined) return;
          runFork(ctx, at, point.text);
        },
        onCancel: () => {
          if (ctx.stopped) return;
          ctx.app.setEditorFooter('tree: cancelled');
          ctx.screen?.render();
        },
      });
      if (!opened) {
        ctx.app.setEditorFooter(
          'tree needs a wider terminal — use kubic sessions fork',
        );
      }
      ctx.screen?.render();
    })
    .catch((error: unknown) => {
      if (ctx.stopped) return;
      ctx.app.setEditorFooter(
        `tree: ${error instanceof Error ? error.message : String(error)}`,
      );
      ctx.screen?.render();
    });
  return 'accepted';
}
