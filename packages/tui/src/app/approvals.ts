// The approval surface's wiring. The surface collects the verdict; the app
// shows the ask as a blocking card in the editor's slot, at every width, and
// the card owns the decision keys while it shows.
import {
  type ApprovalCardOptions,
  renderApprovalCard,
} from '../approval-card.js';
import type { ApprovalDecision, ApprovalOverlayTui } from '../approval-view.js';
import { keyCap } from '../chrome.js';
import { tuiTheme } from '../theme.js';
import { dimFrame } from '../ui/dim.js';
import type { AppCore } from './core.js';
import type { TuiApprovalRequest, TuiInputResult } from './types.js';

// The rows an approval card leaves for the rest of the screen —
// the header, status and hint rows and three rows of transcript.
export const CARD_CHROME_ROWS = 6;

export class ApprovalsController {
  private readonly core: AppCore;

  constructor(core: AppCore) {
    this.core = core;
    const surface = core.approvalSurface;
    // The surface is created by the composition root (it must exist
    // before the lane boots — the boot installs the policy that consults the
    // seat), so the app cannot pass its own onChange at construction. It
    // attaches one here instead: every change re-syncs the overlay and asks the
    // live screen for a frame. Without the render request an ask that arrives
    // from the lane's async turn would stay invisible until the operator
    // happened to press a key.
    surface.onChange = (): void => {
      this.syncOverlay();
    };
    // Boot-time key check: a conflicting map is refused by
    // name here rather than binding one action to two keys silently.
    // An approval key may not shadow a loop key either.
    surface.checkKeys([...core.keys.globalKeys()]);
  }

  // The approval card shows whenever an ask is pending.
  cardVisible(): boolean {
    return this.core.approvalSurface.isShowing();
  }

  // The card's state, read from the surface per frame.
  cardOptions(
    allowable = this.core.approvalSurface.isAllowable(),
  ): ApprovalCardOptions {
    const { approvalSurface: surface, keys, seed } = this.core;
    const queued = surface.queued();
    const input = surface.inputMode();
    return {
      armed: surface.isArmed(),
      allowable,
      keys: surface.keys(),
      commandPage: surface.commandPage(),
      position: 1,
      total: 1 + queued.length,
      ...(queued[0] === undefined ? {} : { next: queued[0] }),
      explain: surface.explaining(),
      ...(seed.cwdLabel === undefined ? {} : { cwd: seed.cwdLabel }),
      pageKey: keyCap(keys.label('approval.page')),
      explainKey: keyCap(keys.label('approval.explain')),
      // The card's open comment or command input.
      ...(input === undefined ? {} : { input }),
    };
  }

  // An approval is a card in the editor slot, not an overlay —
  // a change only needs a frame. A palette open over it would
  // dim the card and hide it from the keys' owner, so it closes.
  syncOverlay(): void {
    if (this.cardVisible() && this.core.palette.current !== undefined) {
      this.core.palette.close(true);
    }
    this.core.requestRender();
  }

  // The live alt-screen's overlay seat (before that, or on a terminal with
  // no overlay seat, the inline body is the surface).
  attach(host: ApprovalOverlayTui): void {
    const { core } = this;
    const surface = core.approvalSurface;
    core.overlayHost = host;
    // While the palette or a picker is open the screen behind
    // it is dimmed; the key-hint row at the bottom stays lit.
    host.baseFilter = (lines: string[]): string[] =>
      core.palette.current !== undefined ||
      core.overlays.picker !== undefined ||
      core.blocks.viewer !== undefined
        ? dimFrame(tuiTheme().ui, lines)
        : lines;
    // The live screen's render request, so an ask that arrives
    // from the lane's async turn paints a frame immediately. Optional on
    // the seam (see ApprovalOverlayTui) — a host that lacks it still gets
    // the overlay, just drawn on the next frame the loop already renders.
    surface.renderRequest = (): void => {
      host.requestRender?.();
    };
    // Whether the shown ask fits the live terminal; a host
    // that reports no size keeps the fixed layout.
    // The card, the header, status and hint rows and three
    // rows of transcript must fit the terminal; until they do, only deny
    // acts (the card says so). Measured with the allow keys showing.
    surface.fitCheck = (): boolean => {
      const request = surface.pending();
      const terminal = host.terminal;
      if (request === undefined || terminal === undefined) return true;
      const rows = renderApprovalCard(
        tuiTheme().ui,
        request,
        terminal.columns,
        this.cardOptions(true),
      ).length;
      return rows + CARD_CHROME_ROWS <= terminal.rows;
    };
    // A request that arrived before boot finished is shown now.
    this.syncOverlay();
  }

  request(request: TuiApprovalRequest): Promise<ApprovalDecision> {
    const pending = this.core.approvalSurface.ask(request);
    this.syncOverlay();
    return pending;
  }

  // A pending approval is denied first by every cancel-class key: nobody
  // is left waiting on a verdict that cannot arrive (the turn
  // would otherwise hang to the lane's timeout).
  denyPending(): void {
    const surface = this.core.approvalSurface;
    if (!surface.isShowing()) return;
    surface.cancelPending();
    this.syncOverlay();
  }

  // A key while the card shows. The card owns the decision keys FIRST —
  // above every global binding: answering with Esc must deny the request,
  // not quit the session. Undefined for a global key the card leaves to the
  // loop (the draft, Ctrl-T, Ctrl-O/R and the rest keep working).
  handleKey(
    data: string,
    keyId: string | undefined,
  ): TuiInputResult | undefined {
    const { approvalSurface: surface, keys } = this.core;
    const consumed = { quit: false, consumed: true, cancel: false };
    // The card's open input takes the keys first — text never
    // reaches a decision key, Esc goes back to the card, Enter sends.
    const typed = surface.typeInto(data);
    if (typed === 'settled') {
      this.syncOverlay();
      return consumed;
    }
    if (typed === 'consumed') {
      this.core.requestRender();
      return consumed;
    }
    if (surface.decide(data)) {
      this.syncOverlay();
      return consumed;
    }
    // The approval is a capturing modal. While it shows, every
    // key it did not take — prose typed ahead for the next prompt, and a
    // decision key pressed inside the arming window — is dropped rather
    // than reaching the draft. Only the loop's global keys still act.
    // `v` pages a long command in the dialog (never decides).
    if (
      keys.actionFor('approval', keyId) === 'approval.page' &&
      surface.nextCommandPage()
    ) {
      return consumed;
    }
    // `?` opens (and closes) the card's explanation row.
    if (
      keys.actionFor('approval', keyId) === 'approval.explain' &&
      surface.toggleExplain()
    ) {
      return consumed;
    }
    if (!keys.isGlobalKey(keyId)) return consumed;
    return undefined;
  }
}
