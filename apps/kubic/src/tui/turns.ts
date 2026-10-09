// The turns of the interactive loop: the prompt turn driver over the current
// boot, the busy latch, and one accepted prompt run to its settlement.
import type { TuiContext } from './context.js';
import { footerForOutcome } from './outcome.js';
import { TuiTurnRunner } from './turn-runner.js';
import type { TuiTurnDriver, TuiTurnOptions } from './types.js';

// The one builtin whose writes bypass the journal's own recording: a turn that
// ran it needs the reconcile sweep at settlement.
const SHELL_TOOL_NAME = 'bash';

// The prompt turn driver over the current boot's lane (none without one).
// `/new` and `/resume` replace the lane, so the drivers are rebuilt: a
// fresh runner starts with an empty feed and no subscription.
export function buildTurn(ctx: TuiContext): TuiTurnRunner | undefined {
  const { boot } = ctx;
  if (boot.loop === undefined) return undefined;
  const next = new TuiTurnRunner(
    ctx.app,
    boot.loop,
    boot.model,
    () => {
      ctx.syncPosture();
      if (!ctx.stopped) ctx.screen?.update();
    },
    (event) => {
      if (event.type === 'tool-end') {
        if (event.toolName === SHELL_TOOL_NAME) ctx.shellRanThisTurn = true;
        ctx.journalFeed?.request();
      }
      // A fresh inbox list replaces the queued rows (it is
      // a snapshot); a `run-start` names the submission the harness
      // just PLACED, so its row becomes the pending echo instead.
      // The rows are painted by the runner AFTER it writes the state
      // (the sink's own repaint): this fan-out runs first because it
      // owns the map the state resolves against, so a paint here would
      // be the frame BEFORE the write.
      if (event.type === 'inbox') {
        ctx.queuedInbox = event.items;
      }
      if (event.type === 'run-start') {
        ctx.sweepPendingShell();
        ctx.reconcileTurn += 1;
        ctx.reconcileTurnOpen = true;
        ctx.rebaseline();
        for (const input of event.inputs) {
          const id = String(input);
          const text = ctx.queuedText.get(id);
          if (text === undefined) continue;
          ctx.queuedText.delete(id);
          // The queued draft's attachments ride with its echo
          // (`setPendingImages` before `setPendingEcho`, the order the
          // echo's render reads them in).
          const images = ctx.queuedImages.get(id) ?? [];
          ctx.queuedImages.delete(id);
          ctx.app.setPendingImages(images);
          // Nothing is armed any more: the composer is empty and the echo
          // carries the images, so a blank Enter here is a no-op.
          ctx.app.setPendingAttachments(0);
          ctx.app.setPendingEcho(text);
        }
        // The placed submission is work in flight now: a queued
        // follow-up that waited behind a failed run starts the spinner
        // again.
        if (ctx.wired) syncBusy(ctx);
      }
    },
    boot.usageRows,
    boot.turnSpans,
    boot.debug,
  );
  // EVERY runner gets the loop's in-place queue
  // map, not just the initial one — `/new` and `/resume` rebuild the runner
  // (`rebindSession`), and a rebuilt runner with its own empty map resolves
  // every inbox id to nothing, so the `queued:` row never renders.
  next.setQueuedText(ctx.queuedText);
  return next;
}

// The busy latch follows PLACED work, not
// submitted promises. A follow-up waiting in the inbox — admitted while
// a turn ran, or left behind by a failed run (pi-durable keeps queued
// inputs after a fault) — is not a run: the spinner stops and the
// queued row is what the operator sees. `activeTurn` outlives it, so a
// later submit places the queue and the same driver runs again.
function syncBusy(ctx: TuiContext): void {
  if (ctx.stopped) return;
  const running = ctx.activeTurn?.isRunning() === true;
  if (running && !ctx.app.isBusy()) {
    ctx.app.setBusy(true);
    ctx.chrome.startSpinner();
  } else if (!running && ctx.app.isBusy()) {
    ctx.app.setBusy(false);
    ctx.chrome.stopSpinner();
  }
  ctx.render();
}

export function startTurn(
  ctx: TuiContext,
  driver: TuiTurnDriver,
  prompt: string,
  options?: TuiTurnOptions,
): void {
  ctx.activeTurn = driver;
  ctx.inFlightTurns += 1;
  // The receipt counts this turn from its submission.
  const startedAt = Date.now();
  ctx.app.setBusy(true);
  ctx.chrome.startSpinner();
  ctx.screen?.render();
  // The settlement footer is applied in `finally`, AFTER the busy
  // reset: `setBusy(false)` clears the footer row, so a footer set in
  // `then` would be wiped when the last turn of the busy period ends.
  let footer: string | undefined;
  void driver
    .run(prompt, {
      ...(options ?? {}),
      // The admission answer decides the latch: placed work keeps the
      // spinner, a queued item releases it.
      onSubmitted: (submissionId, admitted) => {
        options?.onSubmitted?.(submissionId, admitted);
        syncBusy(ctx);
      },
    })
    .then((outcome) => {
      ctx.syncPosture();
      // A bash-made change is journaled only by the sweep;
      // run it BEFORE the panel read so this turn's shell effects are
      // on screen at settlement, not just at quit. A quit in progress
      // owns its own final sweep (close), and a failed sweep leaves
      // the panels on the rows they have.
      if (!ctx.stopped) {
        ctx.sweepPendingShell();
        // Between turns the workspace is the operator's —
        // unless a queued follow-up is already running, whose changes
        // the next sweep still owes.
        if (ctx.turn?.isRunning() !== true) {
          ctx.reconcileTurnOpen = false;
          ctx.rebaseline();
        }
      }
      ctx.journalFeed?.now();
      // The state word follows the outcome; a completed
      // turn clears the notice row (the trust statement lives in the
      // welcome block and behind `/safety`), a cancelled or failed one
      // keeps its own report there.
      ctx.app.setTurnOutcome(outcome.status, {
        startedAt,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      });
      footer = footerForOutcome(outcome);
      if (outcome.status === 'cancelled' && ctx.droppedOnCancel > 0) {
        footer = `${footer} · dropped ${ctx.droppedOnCancel} queued prompt${ctx.droppedOnCancel === 1 ? '' : 's'}`;
      }
      // A driver with its own settlement line (the compaction's
      // `compacted: …`) reports it instead of a turn outcome.
      footer = driver.settlementFooter?.() ?? footer;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.app.setTurnOutcome('failed', { startedAt, detail: message });
      footer = `error: ${message}`;
    })
    .finally(() => {
      ctx.inFlightTurns -= 1;
      if (ctx.inFlightTurns === 0) {
        ctx.droppedOnCancel = 0;
        if (ctx.activeTurn === driver) ctx.activeTurn = undefined;
        // The turn is over — so is its edit batch.
        ctx.boot.endApprovalTurn?.();
      }
      // Sync BEFORE the footer: `setBusy(false)` clears the footer row.
      syncBusy(ctx);
      if (footer !== undefined && !ctx.stopped) ctx.app.setEditorFooter(footer);
      // The turn may have changed files or the branch.
      if (ctx.inFlightTurns === 0) ctx.chrome.refreshWorkspace();
      ctx.render();
    });
}
