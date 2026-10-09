// Key routing for the interactive loop: the quit and interrupt keys, the
// global toggles, the steer key, and inline image pastes reassembled across
// input chunks before the editor would type them as text.
import {
  inlineImageTerminatorEnd,
  scanInlineImageChunk,
} from '@kubic/tui/attachments';
import type { TuiApp } from '@kubic/tui/tui-app';
import { isKeyRelease, isKeyRepeat, parseKey } from '@kubic/tui/tui-boundary';
import {
  attachPasted,
  setImagesFooter,
  TOO_LARGE_PASTE_FOOTER,
} from './commands/media.js';
import { cycleThinking, openModelPicker } from './commands/model.js';
import { openPalette } from './commands/palette.js';
import { parseModelCommand } from './commands/parse.js';
import { toggleFullAccess } from './commands/session.js';
import type { TuiContext } from './context.js';
import { submitPrompt } from './submit.js';
import type { TuiTurnDriver } from './types.js';

// How long an unterminated inline-image sequence is held before it is
// dropped with a footer: long enough for the
// chunks of one real paste (the pty delivers them back to back, and pi-tui's
// StdinBuffer flushes a partial OSC after 50 ms), short enough that a stray
// escape never swallows the operator's typing.
/** @internal */
export const PASTE_IDLE_MS = 150;

type Routed = ReturnType<TuiApp['handleInput']>;

export class TuiInput {
  private readonly ctx: TuiContext;
  // A large inline paste arrives in chunks, so a partial
  // OSC 1337 sequence is held here across listener calls (bounded) instead
  // of being typed into the draft as raw escape + base64. `droppingPaste`
  // is the state after one that was past the cap: its remaining chunks are
  // payload and are discarded up to the terminator.
  private pasteBuffer = '';
  private droppingPaste = false;
  private dropCarry = '';
  private pasteIdle: ReturnType<typeof setTimeout> | undefined;

  constructor(ctx: TuiContext) {
    this.ctx = ctx;
  }

  route(data: string): { consume: true } | undefined {
    const { ctx } = this;
    if (ctx.stopped) {
      // While a quit drains, a second Ctrl-C ends the wait.
      // Only a real press counts: a held key's repeats and
      // its release are the same key, and repeats of global keys are
      // ignored everywhere else, so a held Ctrl-C must not cut the drain.
      if (!isKeyRelease(data) && !isKeyRepeat(data) && keyIs(data, 'ctrl+c'))
        ctx.lifecycle.shutdown();
      return { consume: true };
    }
    // Defence in depth: TuiApp.handleInput already drops Kitty
    // key releases, but the quit/cancel counting below must never see one
    // even if a future caller routes around it — a Ctrl-C release counted
    // as the second Ctrl-C would quit the session on key-up.
    if (isKeyRelease(data)) return { consume: true };
    // While a paste past the cap is being
    // discarded, its remaining chunks are pure payload — consume them
    // until the sequence's terminator instead of typing base64 into the
    // draft. A chunk that ends mid-terminator keeps its ESC for the next
    // call.
    if (this.droppingPaste) {
      const text = this.dropCarry + data;
      const end = inlineImageTerminatorEnd(text);
      if (end === undefined) {
        this.dropCarry = data.endsWith('\u001b') ? '\u001b' : '';
        this.armPasteIdle();
        return { consume: true };
      }
      this.droppingPaste = false;
      this.dropCarry = '';
      this.clearPasteIdle();
      const rest = text.slice(end);
      if (rest === '') return { consume: true };
      return this.route(rest);
    }
    // A terminal that pastes an image inline (iTerm2's OSC
    // 1337 `File=` sequence) hands the bytes to the attach path — the
    // editor would otherwise insert the base64 payload as draft text. The
    // scanner also reassembles a sequence the pty split across calls; the
    // text before an unterminated sequence still routes normally.
    const scan = scanInlineImageChunk(this.pasteBuffer, data);
    if (scan.kind === 'image') {
      this.pasteBuffer = '';
      this.clearPasteIdle();
      void attachPasted(ctx, scan.image.base64, scan.image.filename);
      return { consume: true };
    }
    if (scan.kind === 'too-large') {
      this.pasteBuffer = '';
      this.droppingPaste = true;
      this.dropCarry = '';
      this.armPasteIdle();
      setImagesFooter(ctx, TOO_LARGE_PASTE_FOOTER);
    } else {
      this.pasteBuffer = scan.kind === 'pending' ? scan.buffer : '';
      if (this.pasteBuffer !== '') this.armPasteIdle();
      else this.clearPasteIdle();
    }
    const routedData =
      scan.kind === 'pending' || scan.kind === 'too-large' ? scan.head : data;
    if (routedData === '') return { consume: true };
    return this.dispatch(ctx.app.handleInput(routedData));
  }

  // What the app made of the key: a global toggle, the steer key, the
  // interrupt, a quit, or a key it consumed.
  private dispatch(routed: Routed): { consume: true } | undefined {
    const { ctx } = this;
    if (routed.pickModel === true) {
      if (ctx.wired) openModelPicker(ctx);
      return { consume: true };
    }
    if (routed.cycleThinking === true) {
      if (ctx.wired) cycleThinking(ctx);
      return { consume: true };
    }
    if (routed.palette === true) {
      if (ctx.wired) openPalette(ctx);
      return { consume: true };
    }
    if (routed.fullAccess === true) {
      if (ctx.wired) toggleFullAccess(ctx);
      return { consume: true };
    }
    // Alt+Enter carried the draft out of the editor. Busy, the
    // text steers the running turn through the harness' steer queue; idle,
    // it submits like Enter (with the same pending echo).
    if (routed.steer !== undefined) {
      const steered = routed.steer;
      const outcome = ctx.wired ? submitPrompt(ctx, steered, true) : undefined;
      if (outcome === 'refused') {
        // Only a REFUSAL hands the draft back — the
        // app already cleared it for the key, and an accepted `/model`
        // steer must not resurrect the command it just ran.
        ctx.app.restoreDraft(steered);
      } else if (
        outcome === 'accepted' &&
        parseModelCommand(steered) === undefined
      ) {
        ctx.app.setPendingEcho(steered);
      }
      return { consume: true };
    }
    // Esc interrupts a running turn and never quits — a second
    // Esc while the interrupt drains does nothing, and a lane that cannot
    // cancel says so instead of quitting.
    if (routed.interrupt === true) {
      const running = ctx.activeTurn;
      if (running?.isRunning() === true) {
        if (!running.canCancel()) {
          ctx.app.setEditorFooter(
            `this run cannot be interrupted here — press ${ctx.keys.label('app.interrupt')} twice to quit`,
          );
        } else if (!running.isCancelling()) {
          this.interruptTurn(running);
          return { consume: true };
        }
      }
      ctx.screen?.update();
      return { consume: true };
    }
    if (routed.quit) {
      const running = ctx.activeTurn;
      if (routed.cancel && running?.isRunning()) {
        // A lane that cannot cancel never fakes it — Ctrl-C
        // quits instead (the shutdown drain is bounded).
        if (!running.canCancel()) {
          ctx.lifecycle.shutdown();
          return { consume: true };
        }
        // Ctrl-C during a turn. The first one cancels the operation and
        // keeps the session alive; a second one (while the cancellation is
        // still draining) quits, which is the contract docs/cli/commands.md
        // ships.
        if (!running.isCancelling()) {
          this.interruptTurn(running);
          return { consume: true };
        }
      }
      ctx.lifecycle.shutdown();
      return { consume: true };
    }
    // A consuming listener pre-empts pi-tui's own post-input
    // render (it only runs on the focused-component path), so every key
    // the app consumed — a typed character, a global toggle, an approval
    // decision — asks for its frame here. Without it nothing repaints
    // while idle: no spinner, no turn refresh.
    if (routed.consumed) {
      ctx.screen?.update();
      return { consume: true };
    }
    return undefined;
  }

  // The interrupt both keys share: Ctrl-C's first press during a turn
  // and Esc. The footer is set synchronously so the
  // cancellation is visible on the very next frame — the abort itself is
  // async.
  private interruptTurn(running: TuiTurnDriver): void {
    const { ctx } = this;
    // The queue is pi-durable's, and the abort withdraws
    // every queued input with it (`conversation.abort()`). Count what
    // goes so the cancelled turns' footers can say it, instead of the
    // prompts silently vanishing.
    ctx.droppedOnCancel = ctx.queuedCount();
    ctx.app.setEditorFooter('cancelling…');
    ctx.app.setCancelling(true);
    ctx.screen?.render();
    void running
      .cancel()
      .then((accepted) => {
        if (ctx.stopped) return;
        // A refused abort must never be silent: without this the
        // operator presses the key, the lane refuses (requestLaneAbort
        // throws LaneDriveError), and the screen shows nothing — a
        // no-op key with no explanation. The loop keeps running.
        if (!accepted) {
          ctx.droppedOnCancel = 0;
          ctx.app.setCancelling(false);
          ctx.app.setEditorFooter('cancel failed — turn still running');
        }
        ctx.screen?.render();
      })
      .catch((error: unknown) => {
        if (ctx.stopped) return;
        ctx.app.setCancelling(false);
        ctx.app.setEditorFooter(
          `cancel failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        ctx.screen?.render();
      });
  }

  // A partial sequence that never completes must not swallow the operator's
  // typing for the rest of the session: after
  // a short idle window the held bytes are dropped and the footer says so.
  // The discard state needs the same valve: a paste whose
  // terminator never arrives — a >5 MB one the pty truncated, the very
  // condition that gets you into that state — would otherwise swallow every
  // later keystroke, Ctrl-C included, until stdin closed. The window is
  // re-armed by each chunk of a live paste, so the state survives a paste
  // that is still arriving and ends once the stream stops.
  private armPasteIdle(): void {
    if (this.pasteIdle !== undefined) clearTimeout(this.pasteIdle);
    this.pasteIdle = setTimeout(() => {
      this.pasteIdle = undefined;
      if (this.ctx.stopped) return;
      const wasDropping = this.droppingPaste;
      if (this.pasteBuffer !== '') this.pasteBuffer = '';
      else if (wasDropping) {
        this.droppingPaste = false;
        this.dropCarry = '';
      } else return;
      // The discard state keeps its own, more useful message: the paste
      // really was over the cap, and the operator needs to know input is
      // live again.
      setImagesFooter(
        this.ctx,
        wasDropping
          ? TOO_LARGE_PASTE_FOOTER
          : 'pasted image incomplete — ignored',
      );
    }, PASTE_IDLE_MS);
    this.pasteIdle.unref?.();
  }

  private clearPasteIdle(): void {
    if (this.pasteIdle === undefined) return;
    clearTimeout(this.pasteIdle);
    this.pasteIdle = undefined;
  }
}

function keyIs(data: string, key: string): boolean {
  try {
    return parseKey(data) === key;
  } catch {
    return false;
  }
}
