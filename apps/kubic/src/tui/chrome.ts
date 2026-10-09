// The loop's chrome: the app with its welcome and notice rows, the header
// clock, the working spinner, the workspace facts and the recent sessions.
import { formatCost } from '@kubic/core/cli/kit';
import { runRoleLabel } from '@kubic/core/run-role';
import { noIsolationTuiLine, shouldEmitNotice } from '@kubic/host/doctor';
import {
  FAUX_FOOTER,
  FAUX_MODEL_ID,
  FAUX_PROVIDER_ID,
} from '@kubic/host/models';
import { formatClock } from '@kubic/tui/chrome';
import { createTuiApp, type TuiApp } from '@kubic/tui/tui-app';
import { clipboardSupported, osc52 } from '@kubic/tui/ui/clipboard';
import { formatAge } from '@kubic/tui/ui/palette';
import type { TuiContext } from './context.js';
import { tildePath } from './paths.js';

// How often the header clock checks whether its minute changed.
export const TUI_CLOCK_TICK_MS = 30_000;

// The app over the first boot. Its callbacks read the context, so they
// follow the boot a session switch puts in its place.
export function createLoopApp(
  ctx: TuiContext,
  role: string | undefined,
): TuiApp {
  const { boot, deps } = ctx;
  // The no-isolation notice: the trust statement is in the welcome block from
  // the first frame. Suppressed by the documented KUBIC_NO_NOTICE opt-out; the
  // text is no-isolation-notice.ts's, never re-worded here.
  const noIsolationNotice = shouldEmitNotice(process.env)
    ? noIsolationTuiLine()
    : '';
  // The faux testing provider is never silent: while it answers, the
  // welcome block says so next to (or instead of) the lane notice.
  const noticeFor = (): string =>
    ctx.boot.model === `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`
      ? [FAUX_FOOTER, noIsolationNotice]
          .filter((part) => part !== '')
          .join(' · ')
      : noIsolationNotice;
  return createTuiApp({
    sessionId: boot.sessionId,
    model: boot.model,
    // The tree's head row names the run's role: the `--role` name, cut to
    // its column, else the default role.
    label: runRoleLabel(role),
    // The bar shows the lane's committed level
    // from the first frame — never the seed default the lane already moved
    // past (a clamped resume would otherwise read 'off' until Alt+T or a
    // turn refreshed it). Absent on injected boots means that default.
    thinking: boot.thinking ?? 'off',
    approvalSurface: ctx.surface,
    keys: ctx.keys,
    ...(boot.listFiles === undefined ? {} : { listFiles: boot.listFiles }),
    // File references link under the workspace root.
    fileRoot: boot.cwd ?? process.cwd(),
    // The workspace as the approval card names it.
    cwdLabel: tildePath(boot.cwd ?? process.cwd()),
    // The boot's skill names complete `/skill:` in the
    // editor's popup.
    ...(boot.skillInvocation === undefined
      ? {}
      : { skillNames: boot.skillInvocation.names }),
    // The posture comes from the installed policy.
    approvalsSkipped: boot.approvalsSkipped?.() ?? boot.fullAccess === true,
    ...(boot.contextLimits?.contextWindow === undefined
      ? {}
      : { contextWindow: boot.contextLimits.contextWindow }),
    ...(boot.contextLimits?.compactionThreshold === undefined
      ? {}
      : { compactionThreshold: boot.contextLimits.compactionThreshold }),
    // The welcome block's honest notice, and the header clock.
    laneNotice: noticeFor,
    // The status line's word on a turn's edit batch — the
    // policy of whichever boot is current.
    editsApprovedThisTurn: () => ctx.boot.editsApprovedThisTurn?.() === true,
    // Block mode's copies — OSC 52 on the terminal the screen
    // runs on (through tmux's passthrough when inside it); refused on a
    // terminal known to drop it, so a copy is never claimed falsely.
    clipboard: (text: string): boolean => {
      if (!clipboardSupported(process.env)) return false;
      const target = ctx.terminal;
      if (target === undefined) return false;
      target.write(osc52(text, { tmux: (process.env.TMUX ?? '') !== '' }));
      return true;
    },
    // The first screen's facts only this boot has.
    preflight: {
      ...(deps.version === undefined ? {} : { version: deps.version }),
      ...(boot.keySourceOf === undefined
        ? {}
        : { keySource: boot.keySourceOf }),
      testingModel: `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`,
      ...(deps.projectTrust === undefined ? {} : { trust: deps.projectTrust }),
      // The limits modules' own lines, verbatim (and suppressed the same
      // way); the faux note is the provider row's, not the isolation row's.
      isolation: noticeFor,
    },
    ...(deps.clock === undefined
      ? {}
      : { clock: () => formatClock(deps.clock?.() ?? new Date()) }),
  });
}

export class TuiChrome {
  private readonly ctx: TuiContext;
  // The working indicator animates while a turn runs.
  private spinner: ReturnType<typeof setInterval> | undefined;
  // The header clock repaints only when the shown minute
  // changes; a 30 s tick lands within half a minute of it.
  private clockTimer: ReturnType<typeof setInterval> | undefined;

  constructor(ctx: TuiContext) {
    this.ctx = ctx;
  }

  startSpinner(): void {
    this.stopSpinner();
    this.spinner = setInterval(() => {
      if (this.ctx.stopped || this.ctx.app.busyElapsedMs() === undefined) {
        this.stopSpinner();
        return;
      }
      this.ctx.screen?.update();
    }, 100);
    this.spinner.unref?.();
  }

  stopSpinner(): void {
    if (this.spinner !== undefined) clearInterval(this.spinner);
    this.spinner = undefined;
  }

  startClock(): void {
    const clock = this.ctx.deps.clock;
    if (clock === undefined) return;
    this.stopClock();
    let shown = formatClock(clock());
    this.clockTimer = setInterval(() => {
      if (this.ctx.stopped) {
        this.stopClock();
        return;
      }
      const now = formatClock(clock());
      if (now === shown) return;
      shown = now;
      this.ctx.screen?.update();
    }, TUI_CLOCK_TICK_MS);
    this.clockTimer.unref?.();
  }

  stopClock(): void {
    if (this.clockTimer !== undefined) clearInterval(this.clockTimer);
    this.clockTimer = undefined;
  }

  // This project's recent sessions on the first screen, read in
  // the background (the cached read also serves `/resume` and the palette).
  loadRecentSessions(): void {
    const ctx = this.ctx;
    const summarize = ctx.boot.summarizeSessions;
    if (summarize === undefined) return;
    void summarize(ctx.boot.sessionId).then(
      (summaries) => {
        if (ctx.stopped) return;
        ctx.app.setRecentSessions(
          summaries
            // A session that never ran a prompt is not worth a row here
            // (`/resume` still lists it).
            .filter(
              (summary) =>
                summary.state === 'ready' && (summary.turns ?? 0) > 0,
            )
            .slice(0, 3)
            .map((summary) => {
              const created =
                summary.createdAt === undefined
                  ? Number.NaN
                  : Date.parse(summary.createdAt);
              const turns = summary.turns ?? 0;
              return {
                title: summary.title ?? summary.id,
                age: Number.isNaN(created)
                  ? ''
                  : formatAge(Date.now() - created),
                detail: `${turns} turn${turns === 1 ? '' : 's'}${
                  summary.costUsd === undefined
                    ? ''
                    : ` · ${formatCost(summary.costUsd)}`
                }`,
              };
            }),
        );
        ctx.screen?.update();
      },
      () => {},
    );
  }

  // The header's project / branch / dirty count — read once the
  // screen is up and after every settled turn. A failed read keeps the last
  // facts (the reader itself never throws).
  refreshWorkspace(): void {
    const ctx = this.ctx;
    const read = ctx.deps.readWorkspace;
    if (read === undefined) return;
    void read().then(
      (next) => {
        if (ctx.stopped) return;
        ctx.app.setWorkspace(next);
        ctx.screen?.update();
      },
      () => {},
    );
  }
}
