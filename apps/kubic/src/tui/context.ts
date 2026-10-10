// The state of one `kubic tui` loop: what its features share, in one object
// instead of closure-captured locals. The boot is replaced by `/new`,
// `/resume` and `/fork`; everything else lives as long as the screen.
import type { KubicInboxItem } from '@kubic/agent/lane/events';
import { EXIT_OK, type ExitCode } from '@kubic/core/cli/exit-codes';
import type { LaneImagePart } from '@kubic/core/presentation';
import type { FileBridge } from '@kubic/exec/file-bridge';
import type { ApprovalSurface } from '@kubic/tui/approval-surface';
import type { AttachmentImage } from '@kubic/tui/attachments';
import type { KeyRegistry } from '@kubic/tui/keybindings';
import type { Screen } from '@kubic/tui/screen';
import type { TuiTheme } from '@kubic/tui/theme';
import type { TuiApp } from '@kubic/tui/tui-app';
import type { Terminal } from '@kubic/tui/tui-boundary';
import type { TuiChrome } from './chrome.js';
import type { JournalPanelFeed } from './commands/journal.js';
import type { ContextMeter } from './context-meter.js';
import type { TuiLifecycle } from './lifecycle.js';
import type { TuiBootFlags, TuiRunDeps } from './options.js';
import type { TuiTurnRunner } from './turn-runner.js';
import type { TuiLaneBoot, TuiTurnDriver } from './types.js';

export class TuiContext {
  readonly deps: TuiRunDeps;
  // The parsed parity flags every boot of this loop gets.
  readonly flags: TuiBootFlags;
  // The exec file bridge at the workspace: the theme, the keybindings and
  // `/image` read through it.
  readonly files: FileBridge;
  // The theme the run resolved before the screen opened.
  readonly theme: TuiTheme;
  readonly keys: KeyRegistry;
  // The approval surface. Its seat is what every boot's installed policy
  // consults and the app renders the same object, so the verdict collected
  // on screen is the verdict the lane receives.
  readonly surface: ApprovalSurface;
  // The current boot: replaced by a session switch or a fork.
  boot: TuiLaneBoot;
  // Set once, right after construction: the app's callbacks read this
  // context.
  app!: TuiApp;
  chrome!: TuiChrome;
  lifecycle!: TuiLifecycle;
  // The terminal the screen opens on (block mode's copies), and the screen.
  terminal: Terminal | undefined;
  screen: Screen | undefined;
  stopped = false;
  exitCode: ExitCode = EXIT_OK;
  // The submit path is wired only when the first boot has a lane. A boot
  // without one is the viewer shell: the screen and restore contract, and
  // nothing else.
  wired = false;
  // The Ctrl-O / Ctrl-R panels' feed over the current boot's journal.
  journalFeed: JournalPanelFeed | undefined;
  // The context gauge's reading over the current boot's lane.
  contextMeter: ContextMeter | undefined;
  // Set when a shell tool ended in the turn in flight — the only
  // builtin whose writes bypass the journal, so the only reason a settlement
  // needs the reconcile sweep (which walks and hashes the whole workspace:
  // not free, so file-tool and read-only turns skip it).
  shellRanThisTurn = false;
  // The reconciliation turn — one per placed run in this
  // process. A run start re-baselines (sweeping a shell turn first if its
  // settlement has not yet), a settlement with no other run in flight
  // re-baselines again, and so does an idle quit: the sweep only ever
  // journals what changed while a turn was running.
  reconcileTurn = 0;
  // Open from a run start until that turn's settlement re-baselines: a quit
  // while a turn is open (even one already drained) leaves the baseline
  // alone so the close's sweep journals that turn's late writes.
  reconcileTurnOpen = false;
  // The conversation's inbox as the lane reports it (`pi.inbox`
  // via `inbox_update`), plus the prompt text of every submission the loop
  // queued — the inbox carries ids, not content. The `queued: …` rows are
  // derived from the two (and only from them), so admission, placement and
  // withdrawal all come from pi-durable's own queue: Kubic owns no queue
  // state and cannot promise a delivery the harness did not take.
  queuedInbox: readonly KubicInboxItem[] = [];
  readonly queuedText = new Map<string, string>();
  // The images a queued follow-up carries, keyed by submission
  // id — the inbox carries ids, not content, so the echo that replaces the
  // queued row when the harness PLACES it must render them from here.
  readonly queuedImages = new Map<string, readonly LaneImagePart[]>();
  // The prompt turn driver of the current boot (none without a lane), and
  // the driver of the turn in flight (a prompt turn or a compaction).
  turn: TuiTurnRunner | undefined;
  activeTurn: TuiTurnDriver | undefined;
  // One accepted prompt → one turn on its driver. A busy
  // Enter starts a SECOND run while the first is still in flight (the
  // harness queues it), so the busy latch counts turns instead of
  // holding one: the spinner and the editor stay in flight until the
  // last settles.
  inFlightTurns = 0;
  // How many queued prompts the cancel in flight is about to
  // withdraw. pi-durable's abort clears the inbox, so the settlement
  // footer of every cancelled turn names the count — deterministic,
  // whichever of the running/queued turns settles last.
  droppedOnCancel = 0;
  // The images the next submitted prompt carries.
  // Each one is validated (magic bytes, size) and capability-checked
  // against the live model at ATTACH time, so a submit never spends a turn
  // on bytes the provider would reject.
  pendingImages: AttachmentImage[] = [];
  // The theme `/theme` keeps for this session (`default` is the dark brand
  // palette's other name).
  activeTheme: string;

  constructor(init: {
    deps: TuiRunDeps;
    flags: TuiBootFlags;
    files: FileBridge;
    theme: TuiTheme;
    keys: KeyRegistry;
    surface: ApprovalSurface;
    boot: TuiLaneBoot;
  }) {
    this.deps = init.deps;
    this.flags = init.flags;
    this.files = init.files;
    this.theme = init.theme;
    this.keys = init.keys;
    this.surface = init.surface;
    this.boot = init.boot;
    const configured = init.deps.theme;
    this.activeTheme =
      configured === undefined || configured === '' || configured === 'default'
        ? 'dark'
        : configured;
  }

  // A frame now, unless the loop is stopping.
  render(): void {
    if (!this.stopped) this.screen?.render();
  }

  // The footer line, painted at once.
  say(line: string): void {
    this.app.setEditorFooter(line);
    this.render();
  }

  // Re-read after each turn (and each mid-turn refresh): a posture change
  // lands on the indicator in the same frame the loop paints next.
  syncPosture(): void {
    if (this.boot.approvalsSkipped !== undefined)
      this.app.setApprovalsSkipped(this.boot.approvalsSkipped());
  }

  // The LIVE posture, read from the same
  // predicate the status bar uses, so a direction can be checked against
  // what is actually in force.
  fullAccessLive(): boolean {
    return this.boot.approvalsSkipped?.() ?? this.boot.fullAccess === true;
  }

  busy(): boolean {
    return this.activeTurn?.isRunning() === true;
  }

  queuedCount(): number {
    return this.queuedInbox.filter((item) => this.queuedText.has(item.id))
      .length;
  }

  sweepPendingShell(): void {
    if (!this.shellRanThisTurn) return;
    this.shellRanThisTurn = false;
    try {
      this.boot.reconcile?.();
    } catch {
      // Reconciliation observes, it never gates the loop.
    }
  }

  rebaseline(): void {
    try {
      this.boot.rebaseline?.(this.reconcileTurn);
    } catch {
      // A failed capture leaves the previous baseline; the loop stands.
    }
  }
}
