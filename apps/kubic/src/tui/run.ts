// `kubic tui` (prompt loop): interactive alt-screen over the
// lane. The composition root owns every side effect: it boots the real
// lane (same session/model setup as the headless runner), opens the
// alt-screen on the replicated presentation, routes keyboard input through
// the tui controller, drives the lane for whatever the user submits, feeds
// lane events into the tree and usage rows into the status bar, and restores
// the main screen with the final document printed — on quit, on a signal,
// and exactly once. `kubic run` is untouched (headless regression:
// tui-command.test.ts + binary exit codes).
//
// Cancellation: Ctrl-C during a turn aborts
// the in-flight conversation through the lane's own durable abort
// (conversation.abort + the conversation's kill drain) and keeps the
// session alive; a second Ctrl-C quits. While idle the first Ctrl-C quits.
// Esc and Ctrl-D-on-an-empty-draft quit too, so no honoured key is a silent
// no-op.

import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { KubicInboxItem } from '@kubic/agent/lane/events';
import { SESSION_ID_PATTERN } from '@kubic/agent/lane/session-store';
import type { ModelSelection } from '@kubic/agent/model-select';
import {
  ModelSelectError,
  NoModelAvailableError,
} from '@kubic/agent/model-select';
import { isThinkingLevel } from '@kubic/agent/models-config';
import type { EntryRecord, ModelThinkingLevel } from '@kubic/agent/pi-boundary';
import type { CommandResult, ExitCode } from '@kubic/core/cli/exit-codes';
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_PROVIDER,
  EXIT_USAGE,
  EXIT_WORKSPACE,
} from '@kubic/core/cli/exit-codes';
import { formatCost } from '@kubic/core/cli/kit';
import type { LaneImagePart } from '@kubic/core/presentation';
import { runRoleLabel } from '@kubic/core/run-role';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { applyUndo, diffEntries, planUndo } from '@kubic/exec/journal';
import {
  noIsolationNoticeLines,
  noIsolationTuiLine,
  shouldEmitNotice,
} from '@kubic/host/doctor';
import {
  FAUX_FOOTER,
  FAUX_MODEL_ID,
  FAUX_PROVIDER_ID,
} from '@kubic/host/models';
import { mapCaughtErrorToTerminus } from '@kubic/host/run';
import type { SessionSummary } from '@kubic/host/sessions';
import { createApprovalSurface } from '@kubic/tui/approval-surface';
import type { AttachmentImage } from '@kubic/tui/attachments';
import {
  formatImageBytes,
  IMAGE_MAX_BYTES,
  inlineImageTerminatorEnd,
  scanInlineImageChunk,
  validateImageAttachment,
} from '@kubic/tui/attachments';
import { formatClock } from '@kubic/tui/chrome';
import type { KeyRegistry } from '@kubic/tui/keybindings';
import { KeybindingsError } from '@kubic/tui/keybindings';
import type { ForkPoint, LaneEntryLike } from '@kubic/tui/lane-cells';
import { forkPickerRows, userPromptsOf } from '@kubic/tui/lane-cells';
import { renderNoKeyPreflight } from '@kubic/tui/preflight';
import type { Screen } from '@kubic/tui/screen';
import { bootScreen } from '@kubic/tui/screen';
import type { ParsedSlashCommand } from '@kubic/tui/slash-commands';
import {
  findSlashCommand,
  helpLines,
  parseSlashCommand,
  SLASH_COMMAND_NAMES,
  SLASH_COMMANDS,
} from '@kubic/tui/slash-commands';
import type { TuiTheme } from '@kubic/tui/theme';
import {
  detectColorLevel,
  isThemeBuiltin,
  setTuiTheme,
  ThemeError,
  tuiTheme,
} from '@kubic/tui/theme';
import type { TuiPickerRow, TuiSubmitOutcome } from '@kubic/tui/tui-app';
import { createTuiApp } from '@kubic/tui/tui-app';
import type { Terminal } from '@kubic/tui/tui-boundary';
import { isKeyRelease, isKeyRepeat } from '@kubic/tui/tui-boundary';
import { clipboardSupported, osc52 } from '@kubic/tui/ui/clipboard';
import { loadHighlighter } from '@kubic/tui/ui/highlight';
import { formatAge } from '@kubic/tui/ui/palette';
import { formatScopedModels } from '../scoped-models.js';
import { ToolSelectionError } from './boot.js';
import { TUI_CLOCK_TICK_MS } from './chrome.js';
import {
  resolveTuiKeybindings,
  resolveTuiTheme,
} from './commands/appearance.js';
import { JournalPanelFeed } from './commands/journal.js';
import {
  IMAGE_COMMAND_USAGE,
  parseImageCommand,
  readImageFile,
} from './commands/media.js';
import type {
  TuiEscalateCommand,
  TuiModelCommand,
  TuiThinkingCommand,
} from './commands/parse.js';
import {
  parseEscalateCommand,
  parseModelCommand,
  parseSkillInvokeCommand,
  parseThinkingCommand,
  parseTuiCompactCommand,
  SKILL_COMMAND_USAGE,
} from './commands/parse.js';
import { TuiCompactionTurn } from './compaction-turn.js';
import { laneEntryFor } from './entries.js';
import { keyIs, PASTE_IDLE_MS } from './input.js';
import {
  defaultDrainTimer,
  signalExitCode,
  TUI_DRAIN_TIMEOUT_MS,
  TUI_FATAL_EVENTS,
  TUI_SIGNALS,
} from './lifecycle.js';
import { footerForOutcome } from './outcome.js';
import { TuiTurnRunner } from './turn-runner.js';
import type {
  TuiBootFlags,
  TuiCommandOptions,
  TuiLaneBoot,
  TuiProcessEvents,
  TuiRunDeps,
  TuiSignal,
  TuiTurnDriver,
  TuiTurnOptions,
} from './types.js';

// The one builtin whose writes bypass the journal's own recording: a turn that
// ran it needs the reconcile sweep at settlement.
const SHELL_TOOL_NAME = 'bash';

export async function runTuiCommand(
  options: TuiCommandOptions,
  deps: TuiRunDeps,
): Promise<CommandResult> {
  const sessionId = options.session;
  const flags: TuiBootFlags = {};
  if (options.role !== undefined) flags.role = options.role;
  if (options.noSkills === true) flags.noSkills = true;
  const skillsList = options.skills ?? [];
  if (skillsList.length > 0) flags.skillsList = [...skillsList];
  if (options.dangerouslySkipApprovals === true) {
    flags.dangerouslySkipApprovals = true;
  }
  // The selection is a usage rule the
  // parser owns — both flags at once exit 2 before the alt-screen (the
  // boot re-validates names/agreement with the reason).
  if (options.tools !== undefined && options.noTools === true) {
    (deps.err ?? deps.out)(
      'error: --tools and --no-tools are mutually exclusive',
    );
    return { exitCode: EXIT_USAGE };
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    flags.tools = [...options.tools];
  }
  if (options.noTools === true) flags.noTools = true;
  // commander validated the id already; re-checked because it becomes a
  // path segment under the sessions root.
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    (deps.err ?? deps.out)(
      `error: invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
    return { exitCode: EXIT_USAGE };
  }
  // The `[ui] theme` reference is resolved and validated
  // BEFORE anything opens — a missing or invalid theme file is a named
  // `error:` line and exit 2, never a half-painted screen or a silent
  // fallback to the default palette. The path form is read through the exec
  // file bridge, the same seam `/image` uses.
  const files = createNodeFileBridge(process.cwd());
  let resolvedTheme: TuiTheme;
  try {
    resolvedTheme = resolveTuiTheme(
      deps.theme,
      deps.colorLevel ??
        detectColorLevel(process.env, process.stdout.isTTY === true),
      files,
    );
  } catch (error) {
    if (error instanceof ThemeError) {
      (deps.err ?? deps.out)(`error: ${error.message}`);
      return { exitCode: EXIT_USAGE };
    }
    throw error;
  }
  // The keybinding registry, resolved before anything opens. A
  // broken file refuses the boot by name; conflicts and displaced defaults
  // are reported on stderr (the main screen) and the TUI still starts.
  let keys: KeyRegistry;
  try {
    keys = resolveTuiKeybindings(
      deps.keybindingsFile ?? join(homedir(), '.kubic', 'keybindings.json'),
      files,
    );
  } catch (error) {
    if (error instanceof KeybindingsError) {
      (deps.err ?? deps.out)(`error: ${error.message}`);
      return { exitCode: EXIT_USAGE };
    }
    throw error;
  }
  for (const notice of keys.notices) {
    (deps.err ?? deps.out)(`warning: ${notice}`);
  }
  // The approval surface must exist BEFORE the lane boots, because
  // the boot installs the policy that consults the seat. The root therefore
  // creates the surface, hands its ask to the boot AS the seat, and attaches
  // the same surface to the app it builds for this boot — one object, so the
  // verdict collected on screen is the verdict the lane receives.
  const surface = createApprovalSurface({
    keyOverrides: keys.approvalOverrides(),
    ...(deps.approvalArmingMs === undefined
      ? {}
      : { armingMs: deps.approvalArmingMs }),
    ...(deps.approvalClock === undefined ? {} : { now: deps.approvalClock }),
  });
  let boot: TuiLaneBoot;
  try {
    boot = await deps.bootLane(sessionId, surface.seat, flags);
    // Tool-journaled entries share the sweep numbering — the
    // supplier reads the live counter, so creating it before the `let`
    // below executes is safe (it is only ever invoked during turns).
    boot.setCurrentTurnSupplier?.(() => reconcileTurn);
  } catch (error) {
    // No provider has a key — the first screen's
    // no-key block, printed to the terminal (no alt screen was entered, so
    // the `export` lines stay in the scrollback), then exit 6.
    if (error instanceof NoModelAvailableError) {
      const workspace = await deps.readWorkspace?.().catch(() => undefined);
      for (const line of renderNoKeyPreflight(resolvedTheme.ui, {
        project: {
          path: tildePath(process.cwd()),
          ...(workspace === undefined
            ? {}
            : workspace.branch === undefined
              ? { git: false }
              : {
                  branch: workspace.branch,
                  ...(workspace.dirty === undefined
                    ? {}
                    : { dirty: workspace.dirty }),
                }),
        },
      })) {
        (deps.err ?? deps.out)(line);
      }
      return { exitCode: EXIT_PROVIDER };
    }
    const message = error instanceof Error ? error.message : String(error);
    (deps.err ?? deps.out)(`error: ${message}`);
    if (error instanceof ModelSelectError) return { exitCode: EXIT_PROVIDER };
    // A refused tool selection is a usage error (exit 2), not a
    // generic lane boot failure.
    if (error instanceof ToolSelectionError) return { exitCode: EXIT_USAGE };
    return {
      exitCode:
        mapCaughtErrorToTerminus(error) === 'workspace_unavailable'
          ? EXIT_WORKSPACE
          : EXIT_FAILED,
    };
  }
  // Colour only for a real terminal; NO_COLOR / FORCE_COLOR honoured.
  // The level is injectable (tests pass 'none', so the suite
  // never depends on the shell's colour variables) and the theme this run
  // replaces is restored when it ends — the global never leaks.
  const previousTheme = tuiTheme();
  setTuiTheme(resolvedTheme);
  // The full-access warning lands on stderr (the main screen)
  // before the alt-screen opens, and the bar shows OFF from the first frame.
  for (const notice of boot.notices ?? []) {
    (deps.err ?? deps.out)(`warning: ${notice}`);
  }
  // The no-isolation notice: the trust statement is in the welcome block from
  // the first frame. Suppressed by the documented KUBIC_NO_NOTICE opt-out; the
  // text is no-isolation-notice.ts's, never re-worded here.
  const noIsolationNotice = shouldEmitNotice(process.env)
    ? noIsolationTuiLine()
    : '';
  // The faux testing provider is never silent: while it answers, the
  // welcome block says so next to (or instead of) the lane notice.
  const noticeFor = (): string =>
    boot.model === `${FAUX_PROVIDER_ID}/${FAUX_MODEL_ID}`
      ? [FAUX_FOOTER, noIsolationNotice]
          .filter((part) => part !== '')
          .join(' · ')
      : noIsolationNotice;
  // The terminal the screen opens on (block mode's copies).
  let screenTerminal: Terminal | undefined;
  const app = createTuiApp({
    sessionId: boot.sessionId,
    model: boot.model,
    // The tree's head row names the run's role: the `--role` name, cut to
    // its column, else the default role.
    label: runRoleLabel(options.role),
    // The bar shows the lane's committed level
    // from the first frame — never the seed default the lane already moved
    // past (a clamped resume would otherwise read 'off' until Alt+T or a
    // turn refreshed it). Absent on injected boots means that default.
    thinking: boot.thinking ?? 'off',
    approvalSurface: surface,
    keys,
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
    // Block mode's copies — OSC 52 on the terminal the screen
    // runs on (through tmux's passthrough when inside it); refused on a
    // terminal known to drop it, so a copy is never claimed falsely.
    // The status line's word on a turn's edit batch — the
    // policy of whichever boot is current.
    editsApprovedThisTurn: () => boot.editsApprovedThisTurn?.() === true,
    clipboard: (text: string): boolean => {
      if (!clipboardSupported(process.env)) return false;
      const target = screenTerminal;
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
  // The resumed session's committed spend is on the bar from the
  // first frame, not only after the next turn's usage event.
  app.setUsage(boot.usageRows ?? []);
  // A resumed session's committed prompts seed the
  // editor's Up history before the screen opens. Best-effort: a read that
  // fails leaves the history empty, never the boot.
  if (sessionId !== undefined && boot.loop !== undefined) {
    try {
      const entries = await boot.loop.entries(boot.loop.context);
      app.seedPromptHistory(
        userPromptsOf(
          entries
            .map(laneEntryFor)
            .filter((entry): entry is LaneEntryLike => entry !== undefined),
        ),
      );
    } catch {
      // Recall is a convenience; the resumed session stands without it.
    }
  }
  // Re-read after each turn (and each mid-turn refresh): a posture change
  // lands on the indicator in the same frame the loop paints next.
  const syncPosture = (): void => {
    if (boot.approvalsSkipped !== undefined)
      app.setApprovalsSkipped(boot.approvalsSkipped());
  };
  // Code highlighting's grammars load once, before the first
  // frame — the other commands never pay for them.
  await loadHighlighter();
  const terminal = deps.createTerminal();
  screenTerminal = terminal;
  // The Ctrl-O / Ctrl-R panels read the session journal the
  // boot created — loaded once now (a resumed session shows its earlier
  // turns), after each tool call (throttled) and at every settlement.
  // Declared before the feed: its `apply` reads both, and the boot read below
  // runs synchronously — a `let` declared later is a TDZ ReferenceError there
  // that the feed's catch would swallow on every boot.
  let screen: Screen | undefined;
  let stopped = false;
  // The feed reads the CURRENT boot's store, so `/new` and
  // `/resume` never leave a stale reader behind (the feed itself is
  // session-agnostic and is built once).
  const journalFeed =
    boot.journal === undefined && deps.journalFeedError === undefined
      ? undefined
      : new JournalPanelFeed({
          read: () => {
            const store = boot.journal;
            return store === undefined ? [] : diffEntries(store, {});
          },
          apply: (rows) => {
            app.setJournalChanges(rows);
            if (!stopped) screen?.update();
          },
          ...(deps.journalFeedError === undefined
            ? {}
            : { onError: deps.journalFeedError }),
        });
  journalFeed?.now();
  // Set when a shell tool ended in the turn in flight — the only
  // builtin whose writes bypass the journal, so the only reason a settlement
  // needs the reconcile sweep (which walks and hashes the whole workspace:
  // not free, so file-tool and read-only turns skip it).
  let shellRanThisTurn = false;
  // The reconciliation turn — one per placed run in this
  // process. A run start re-baselines (sweeping a shell turn first if its
  // settlement has not yet), a settlement with no other run in flight
  // re-baselines again, and so does an idle quit: the sweep only ever
  // journals what changed while a turn was running.
  let reconcileTurn = 0;
  // Open from a run start until that turn's settlement re-baselines: a quit
  // while a turn is open (even one already drained) leaves the baseline
  // alone so the close's sweep journals that turn's late writes.
  let reconcileTurnOpen = false;
  const sweepPendingShell = (): void => {
    if (!shellRanThisTurn) return;
    shellRanThisTurn = false;
    try {
      boot.reconcile?.();
    } catch {
      // Reconciliation observes, it never gates the loop.
    }
  };
  const rebaseline = (): void => {
    try {
      boot.rebaseline?.(reconcileTurn);
    } catch {
      // A failed capture leaves the previous baseline; the loop stands.
    }
  };
  // The conversation's inbox as the lane reports it (`pi.inbox`
  // via `inbox_update`), plus the prompt text of every submission the loop
  // queued — the inbox carries ids, not content. The `queued: …` rows are
  // derived from the two (and only from them), so admission, placement and
  // withdrawal all come from pi-durable's own queue: Kubic owns no queue
  // state and cannot promise a delivery the harness did not take.
  let queuedInbox: readonly KubicInboxItem[] = [];
  const queuedText = new Map<string, string>();
  // The images a queued follow-up carries, keyed by submission
  // id — the inbox carries ids, not content, so the echo that replaces the
  // queued row when the harness PLACES it must render them from here.
  const queuedImages = new Map<string, readonly LaneImagePart[]>();
  const queuedCount = (): number =>
    queuedInbox.filter((item) => queuedText.has(item.id)).length;
  // No `app.setQueuedPrompts` here — the state carries
  // the queue (`turn.setQueuedText(queuedText)` below) and the app writes the
  // rows from it on every presentation apply. Writing them from this side too
  // was the bug: the app's own write on the NEXT event wiped what this one
  // had just set.
  // `/new` and `/resume` replace the lane, so the drivers are
  // rebuilt (a fresh runner starts with an empty feed and no subscription).
  let turn: TuiTurnRunner | undefined;
  const buildTurn = (): TuiTurnRunner | undefined => {
    if (boot.loop === undefined) return undefined;
    const next = new TuiTurnRunner(
      app,
      boot.loop,
      boot.model,
      () => {
        syncPosture();
        if (!stopped) screen?.update();
      },
      (event) => {
        if (event.type === 'tool-end') {
          if (event.toolName === SHELL_TOOL_NAME) shellRanThisTurn = true;
          journalFeed?.request();
        }
        // A fresh inbox list replaces the queued rows (it is
        // a snapshot); a `run-start` names the submission the harness
        // just PLACED, so its row becomes the pending echo instead.
        // The rows are painted by the runner AFTER it writes the state
        // (the sink's own repaint): this fan-out runs first because it
        // owns the map the state resolves against, so a paint here would
        // be the frame BEFORE the write.
        if (event.type === 'inbox') {
          queuedInbox = event.items;
        }
        if (event.type === 'run-start') {
          sweepPendingShell();
          reconcileTurn += 1;
          reconcileTurnOpen = true;
          rebaseline();
          for (const input of event.inputs) {
            const id = String(input);
            const text = queuedText.get(id);
            if (text === undefined) continue;
            queuedText.delete(id);
            // The queued draft's attachments ride with its echo
            // (`setPendingImages` before `setPendingEcho`, the order the
            // echo's render reads them in).
            const images = queuedImages.get(id) ?? [];
            queuedImages.delete(id);
            app.setPendingImages(images);
            // Nothing is armed any more: the composer is empty and the echo
            // carries the images, so a blank Enter here is a no-op.
            app.setPendingAttachments(0);
            app.setPendingEcho(text);
          }
          // The placed submission is work in flight now: a queued
          // follow-up that waited behind a failed run starts the spinner
          // again.
          syncBusyForLoop?.();
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
    next.setQueuedText(queuedText);
    return next;
  };
  turn = buildTurn();
  // The driver of the turn in flight (a prompt turn or a compaction).
  let activeTurn: TuiTurnDriver | undefined;
  // The busy latch follows PLACED work, and the lane
  // event handler above (registered before the submit path exists) must
  // re-sync it when the harness places a queued submission.
  let syncBusyForLoop: (() => void) | undefined;
  // Alt+M / Alt+T, defined with the lane wiring below (the key
  // router is registered first).
  let pickModelForLoop: (() => void) | undefined;
  let cycleThinkingForLoop: (() => void) | undefined;
  // Ctrl-P's palette, defined with the submit path below.
  let paletteForLoop: (() => void) | undefined;
  // Alt+A's full-access toggle, defined with the submit path.
  let fullAccessForLoop: (() => void) | undefined;
  // The working indicator animates while a turn runs.
  let spinner: ReturnType<typeof setInterval> | undefined;
  const stopSpinner = (): void => {
    if (spinner !== undefined) clearInterval(spinner);
    spinner = undefined;
  };
  const startSpinner = (): void => {
    stopSpinner();
    spinner = setInterval(() => {
      if (stopped || app.busyElapsedMs() === undefined) {
        stopSpinner();
        return;
      }
      screen?.update();
    }, 100);
    spinner.unref?.();
  };
  // The header clock repaints only when the shown minute
  // changes; a 30 s tick lands within half a minute of it.
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  const stopClock = (): void => {
    if (clockTimer !== undefined) clearInterval(clockTimer);
    clockTimer = undefined;
  };
  const startClock = (): void => {
    const clock = deps.clock;
    if (clock === undefined) return;
    stopClock();
    let shown = formatClock(clock());
    clockTimer = setInterval(() => {
      if (stopped) {
        stopClock();
        return;
      }
      const now = formatClock(clock());
      if (now === shown) return;
      shown = now;
      screen?.update();
    }, TUI_CLOCK_TICK_MS);
    clockTimer.unref?.();
  };
  // The header's project / branch / dirty count — read once the
  // screen is up and after every settled turn. A failed read keeps the last
  // facts (the reader itself never throws).
  // This project's recent sessions on the first screen, read in
  // the background (the cached read also serves `/resume` and the palette).
  const loadRecentSessions = (): void => {
    const summarize = boot.summarizeSessions;
    if (summarize === undefined) return;
    void summarize(boot.sessionId).then(
      (summaries) => {
        if (stopped) return;
        app.setRecentSessions(
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
        screen?.update();
      },
      () => {},
    );
  };
  const refreshWorkspace = (): void => {
    const read = deps.readWorkspace;
    if (read === undefined) return;
    void read().then(
      (next) => {
        if (stopped) return;
        app.setWorkspace(next);
        screen?.update();
      },
      () => {},
    );
  };
  let exitCode: ExitCode = EXIT_OK;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  // SIGINT, SIGTERM and SIGHUP all run the same
  // shutdown (mid-turn drain, restore, sweep, close) and exit 128+signo. The
  // listeners stay attached until the terminal is restored, so a second
  // signal during the drain only shortens it; they are detached before the
  // session close, so a signal after that takes the default disposition.
  const signals: TuiProcessEvents = deps.signals ?? process;
  const signalListeners = new Map<TuiSignal, (value: unknown) => void>();
  for (const name of TUI_SIGNALS) {
    signalListeners.set(name, () => {
      if (!stopped) exitCode = signalExitCode(name);
      shutdown();
    });
  }
  let signalsAttached = false;
  const attachSignals = (): void => {
    if (signalsAttached) return;
    signalsAttached = true;
    for (const [name, listener] of signalListeners) signals.on(name, listener);
  };
  const detachSignals = (): void => {
    if (!signalsAttached) return;
    signalsAttached = false;
    for (const [name, listener] of signalListeners) signals.off(name, listener);
  };
  // The last-resort restore. An exception in input or render, or
  // an unhandled rejection, would otherwise kill the process with the alt
  // screen, raw mode, mouse tracking and the Kitty protocol still active.
  // The terminal is restored first (nothing is printed — the layout may be
  // what threw), then the error is reported and the process exits 1.
  let fatalHandled = false;
  const fatal = (error: unknown): void => {
    if (fatalHandled) return;
    fatalHandled = true;
    stopped = true;
    exitCode = EXIT_FAILED;
    stopSpinner();
    stopClock();
    endDrain?.();
    try {
      screen?.restore();
    } catch {
      // Best effort: the report below must still happen.
    }
    detachSignals();
    detachFatal();
    stdin?.removeListener('end', onStdinEnd);
    stdin?.removeListener('close', onStdinEnd);
    surface.cancelPending('the session ended before the approval was answered');
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    (deps.err ?? deps.out)(`error: kubic tui crashed: ${detail}`);
    (deps.exit ?? ((code: number) => process.exit(code)))(EXIT_FAILED);
    resolveExit();
  };
  const fatalListener = (value: unknown): void => {
    fatal(value);
  };
  let fatalAttached = false;
  const attachFatal = (): void => {
    if (fatalAttached) return;
    fatalAttached = true;
    for (const name of TUI_FATAL_EVENTS) signals.on(name, fatalListener);
  };
  const detachFatal = (): void => {
    if (!fatalAttached) return;
    fatalAttached = false;
    for (const name of TUI_FATAL_EVENTS) signals.off(name, fatalListener);
  };
  // Stdin EOF (a closed pty, `kubic tui < /dev/null`, or a shell that
  // detached the tty) is a quit: Pi's terminal never reports it, so a
  // missing handler would leave the alt-screen hung on a dead input stream
  // forever. Registered only when the stream exists, and always removed.
  const stdin = process.stdin;
  const onStdinEnd = (): void => {
    shutdown();
  };
  // Set while a quit drains a running turn; calling it ends the
  // wait at once (a second Ctrl-C, a second SIGINT, or the bound firing).
  let endDrain: (() => void) | undefined;
  const shutdown = (): void => {
    if (stopped) {
      // A second quit while the drain waits shortens it: the kills already
      // ran, so the loop exits now instead of at the bound.
      endDrain?.();
      return;
    }
    stopped = true;
    stopSpinner();
    stopClock();
    // A quit (SIGINT, stdin EOF, or the loop's own quit path) must
    // settle a pending approval as a deny — the turn that is waiting on it
    // would otherwise sit until the lane's timeout, and the operator gets no
    // second chance to answer a screen they have left.
    surface.cancelPending('the session quit before the approval was answered');
    stdin?.removeListener('end', onStdinEnd);
    stdin?.removeListener('close', onStdinEnd);
    // A turn still running is aborted and
    // drained BEFORE the sweep and the session close — otherwise its detached
    // process group outlives the session, its late writes escape both the
    // journal and the reconciliation, and the operation never records a
    // terminal status. The screen stays up (footer: cancelling…) until the
    // drain ends, bounded by drainTimeoutMs.
    const draining = activeTurn?.isRunning() === true;
    // The drain has its own bound, and the close gets a FRESH one
    // of its own: pi-durable's `Harness.close` joins live task invocations
    // (`beforeClose`), so a provider that ignores the abort must not hang the
    // quit — but a drain that consumed its whole budget must not leave the
    // close (the session lock release among it) zero time either.
    let drainBound: Promise<void> | undefined;
    let endBound: () => void = () => {};
    if (draining) {
      drainBound = new Promise<void>((resolve) => {
        endDrain = resolve;
        endBound = (deps.setDrainTimer ?? defaultDrainTimer)(
          deps.drainTimeoutMs ?? TUI_DRAIN_TIMEOUT_MS,
          resolve,
        );
      });
      app.setEditorFooter('cancelling…');
      app.setCancelling(true);
      screen?.render();
    }
    void (async () => {
      if (draining && activeTurn !== undefined && drainBound !== undefined) {
        try {
          await activeTurn.drainForQuit(drainBound);
        } catch {
          // The drain is best-effort; the sweep and close still run.
        }
      }
      if (fatalHandled) return;
      // Pop the Kitty protocol and let late input (the quitting
      // key's release, especially over SSH) arrive and be swallowed here
      // instead of printing as `[27;1:3u` in the operator's shell.
      try {
        await terminal.drainInput();
      } catch {
        // Draining is best effort; the restore below still runs.
      }
      if (fatalHandled) return;
      try {
        screen?.stop((line: string) => deps.out(line));
      } catch {
        // Restore failures never mask the clean quit.
      }
      detachSignals();
      // The close joins the harness's live task invocations: a close that
      // cannot finish inside ITS OWN fresh bound is abandoned — the process is
      // leaving anyway, and the next attach reclaims the stale lock by pid
      // liveness. The harness's own storage may stay open until then. A quit
      // key that arrives while the close waits ends that wait at once
      // (`endDrain` points at the close bound from here on).
      endBound();
      const closeBound = new Promise<void>((resolve) => {
        endDrain = resolve;
        endBound = (deps.setDrainTimer ?? defaultDrainTimer)(
          deps.drainTimeoutMs ?? TUI_DRAIN_TIMEOUT_MS,
          resolve,
        );
      });
      // An idle quit re-baselines first, so the close's sweep
      // (which still catches a turn the quit interrupted) never journals an
      // edit the operator made after the last turn settled.
      if (!reconcileTurnOpen) rebaseline();
      try {
        await Promise.race([boot.close?.(), closeBound]);
      } catch {
        // Close failures never mask the clean quit.
      }
      endBound();
      endDrain = undefined;
      detachFatal();
      resolveExit();
    })();
  };
  try {
    const booted = bootScreen(terminal, app.root);
    screen = booted;
    // Focus the editor, not the tree — the loop's primary input
    // target is the prompt. T/t do not toggle (they type); Ctrl-T does.
    booted.tui.setFocus(app.editor);
    app.editor.bind(booted.tui);
    // The overlay seat. The app renders the approval through the
    // live alt-screen from here on; on a terminal too narrow for the overlay
    // (its own visible() gate) the inline body is the surface instead.
    app.attachApprovalOverlay(booted.tui);
    // A pending operation settled at boot (and a model notice)
    // is on the notice row from the first frame. The trust statement is the
    // welcome block's.
    app.setEditorFooter(
      [boot.pendingNotice, boot.modelNotice]
        .filter((line): line is string => line !== undefined)
        .join(' · '),
    );
    attachFatal();

    booted.render();
    startClock();
    refreshWorkspace();
    loadRecentSessions();
    attachSignals();
    stdin?.once('end', onStdinEnd);
    stdin?.once('close', onStdinEnd);
    booted.tui.addInputListener((data: string) => {
      // An exception anywhere in input handling (including the
      // synchronous paints it triggers) restores the terminal first.
      try {
        return routeInput(data);
      } catch (error) {
        fatal(error);
        return { consume: true };
      }
    });
    // The one submit path is defined with the lane wiring below
    // (it needs the drivers and the session mode), while this key router is
    // registered first — so the steer key reaches it through this holder.
    let submitForLoop:
      | ((prompt: string, steer: boolean) => TuiSubmitOutcome)
      | undefined;
    // How many queued prompts the cancel in flight is about to
    // withdraw. pi-durable's abort clears the inbox, so the settlement
    // footer of every cancelled turn names the count — deterministic,
    // whichever of the running/queued turns settles last.
    let droppedOnCancel = 0;
    // The images the next submitted prompt carries.
    // Each one is validated (magic bytes, size) and capability-checked
    // against the live model at ATTACH time, so a submit never spends a turn
    // on bytes the provider would reject.
    let pendingImages: AttachmentImage[] = [];
    // The exec file bridge the `/image` read goes through: the same
    // seam the session store uses, rooted at the workspace, and an absolute
    // path is taken as typed because the operator named it. The theme
    // resolution above uses the same bridge.
    const imageFiles = files;
    // A large inline paste arrives in chunks, so a partial
    // OSC 1337 sequence is held here across listener calls (bounded) instead
    // of being typed into the draft as raw escape + base64. `droppingPaste`
    // is the state after one that was past the cap: its remaining chunks are
    // payload and are discarded up to the terminator.
    let pasteBuffer = '';
    let droppingPaste = false;
    let dropCarry = '';
    let pasteIdle: ReturnType<typeof setTimeout> | undefined;
    // A partial sequence that never completes must not swallow the operator's
    // typing for the rest of the session: after
    // a short idle window the held bytes are dropped and the footer says so.
    // The discard state needs the same valve: a paste whose
    // terminator never arrives — a >5 MB one the pty truncated, the very
    // condition that gets you into that state — would otherwise swallow every
    // later keystroke, Ctrl-C included, until stdin closed. The window is
    // re-armed by each chunk of a live paste, so the state survives a paste
    // that is still arriving and ends once the stream stops.
    const armPasteIdle = (): void => {
      if (pasteIdle !== undefined) clearTimeout(pasteIdle);
      pasteIdle = setTimeout(() => {
        pasteIdle = undefined;
        if (stopped) return;
        const wasDropping = droppingPaste;
        if (pasteBuffer !== '') pasteBuffer = '';
        else if (wasDropping) {
          droppingPaste = false;
          dropCarry = '';
        } else return;
        // The discard state keeps its own, more useful message: the paste
        // really was over the cap, and the operator needs to know input is
        // live again.
        setImagesFooter(
          wasDropping ? tooLargeFooter : 'pasted image incomplete — ignored',
        );
      }, PASTE_IDLE_MS);
      pasteIdle.unref?.();
    };
    const clearPasteIdle = (): void => {
      if (pasteIdle === undefined) return;
      clearTimeout(pasteIdle);
      pasteIdle = undefined;
    };
    const tooLargeFooter = `pasted image is too large (> ${formatImageBytes(IMAGE_MAX_BYTES)})`;
    const setImagesFooter = (text: string): void => {
      app.setEditorFooter(text);
      if (!stopped) screen?.render();
    };
    const attachImage = async (offer: {
      filename: string;
      bytes: Uint8Array;
    }): Promise<void> => {
      const verdict = validateImageAttachment({
        filename: offer.filename,
        bytes: offer.bytes,
      });
      if (!verdict.ok) {
        setImagesFooter(verdict.message);
        return;
      }
      const loop = boot.loop;
      const supported = await loop?.supportsImages?.(loop.context);
      if (supported !== true) {
        setImagesFooter(
          `image refused: ${turn?.modelRef ?? boot.model} does not accept image input`,
        );
        return;
      }
      const image: AttachmentImage = {
        filename: offer.filename,
        mimeType: verdict.mimeType,
        bytes: offer.bytes.byteLength,
        data: Buffer.from(offer.bytes).toString('base64'),
      };
      pendingImages = [...pendingImages, image];
      app.setPendingImages(pendingImages);
      // The armed-but-unsubmitted count the
      // editor's blank-submit rule reads.
      app.setPendingAttachments(pendingImages.length);
      setImagesFooter(
        `image attached: ${image.filename} (${formatImageBytes(image.bytes)}) — Enter sends it`,
      );
    };
    const attachFromPath = async (path: string): Promise<void> => {
      const read = readImageFile(imageFiles, path);
      if (!read.ok) {
        setImagesFooter(read.message);
        return;
      }
      await attachImage({ filename: read.filename, bytes: read.bytes });
    };
    const attachPasted = async (
      base64: string,
      filename: string,
    ): Promise<void> => {
      // Refuse an oversize paste BEFORE decoding it: the
      // base64 text is already in memory (the terminal delivered it), but the
      // decoded payload would be a second, larger allocation. 4/3 is base64's
      // own expansion; the slack covers padding and line breaks.
      if (base64.length > Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 4) {
        setImagesFooter(
          `'${filename}' is too large (> ${formatImageBytes(IMAGE_MAX_BYTES)})`,
        );
        return;
      }
      await attachImage({
        filename,
        bytes: Buffer.from(base64, 'base64'),
      });
    };
    const routeInput = (data: string): { consume: true } | undefined => {
      if (stopped) {
        // While a quit drains, a second Ctrl-C ends the wait.
        // Only a real press counts: a held key's repeats and
        // its release are the same key, and repeats of global keys are
        // ignored everywhere else, so a held Ctrl-C must not cut the drain.
        if (!isKeyRelease(data) && !isKeyRepeat(data) && keyIs(data, 'ctrl+c'))
          shutdown();
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
      if (droppingPaste) {
        const text = dropCarry + data;
        const end = inlineImageTerminatorEnd(text);
        if (end === undefined) {
          dropCarry = data.endsWith('\u001b') ? '\u001b' : '';
          armPasteIdle();
          return { consume: true };
        }
        droppingPaste = false;
        dropCarry = '';
        clearPasteIdle();
        const rest = text.slice(end);
        if (rest === '') return { consume: true };
        return routeInput(rest);
      }
      // A terminal that pastes an image inline (iTerm2's OSC
      // 1337 `File=` sequence) hands the bytes to the attach path — the
      // editor would otherwise insert the base64 payload as draft text. The
      // scanner also reassembles a sequence the pty split across calls; the
      // text before an unterminated sequence still routes normally.
      const scan = scanInlineImageChunk(pasteBuffer, data);
      if (scan.kind === 'image') {
        pasteBuffer = '';
        clearPasteIdle();
        void attachPasted(scan.image.base64, scan.image.filename);
        return { consume: true };
      }
      if (scan.kind === 'too-large') {
        pasteBuffer = '';
        droppingPaste = true;
        dropCarry = '';
        armPasteIdle();
        setImagesFooter(tooLargeFooter);
      } else {
        pasteBuffer = scan.kind === 'pending' ? scan.buffer : '';
        if (pasteBuffer !== '') armPasteIdle();
        else clearPasteIdle();
      }
      const routedData =
        scan.kind === 'pending' || scan.kind === 'too-large' ? scan.head : data;
      if (routedData === '') return { consume: true };
      const routed = app.handleInput(routedData);
      // Alt+Enter carried the draft out of the editor. Busy, the
      // text steers the running turn through the harness' steer queue; idle,
      // it submits like Enter (with the same pending echo).
      if (routed.pickModel === true) {
        pickModelForLoop?.();
        return { consume: true };
      }
      if (routed.cycleThinking === true) {
        cycleThinkingForLoop?.();
        return { consume: true };
      }
      if (routed.palette === true) {
        paletteForLoop?.();
        return { consume: true };
      }
      if (routed.fullAccess === true) {
        fullAccessForLoop?.();
        return { consume: true };
      }
      if (routed.steer !== undefined) {
        const steered = routed.steer;
        const outcome = submitForLoop?.(steered, true);
        if (outcome === 'refused') {
          // Only a REFUSAL hands the draft back — the
          // app already cleared it for the key, and an accepted `/model`
          // steer must not resurrect the command it just ran.
          app.restoreDraft(steered);
        } else if (
          outcome === 'accepted' &&
          parseModelCommand(steered) === undefined
        ) {
          app.setPendingEcho(steered);
        }
        return { consume: true };
      }
      // The interrupt both keys share: Ctrl-C's first press during a turn
      // and Esc. The footer is set synchronously so the
      // cancellation is visible on the very next frame — the abort itself is
      // async.
      const interruptTurn = (running: TuiTurnDriver): void => {
        // The queue is pi-durable's, and the abort withdraws
        // every queued input with it (`conversation.abort()`). Count what
        // goes so the cancelled turns' footers can say it, instead of the
        // prompts silently vanishing.
        droppedOnCancel = queuedCount();
        app.setEditorFooter('cancelling…');
        app.setCancelling(true);
        screen?.render();
        void running
          .cancel()
          .then((accepted) => {
            if (stopped) return;
            // A refused abort must never be silent: without this the
            // operator presses the key, the lane refuses (requestLaneAbort
            // throws LaneDriveError), and the screen shows nothing — a
            // no-op key with no explanation. The loop keeps running.
            if (!accepted) {
              droppedOnCancel = 0;
              app.setCancelling(false);
              app.setEditorFooter('cancel failed — turn still running');
            }
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setCancelling(false);
            app.setEditorFooter(
              `cancel failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };
      // Esc interrupts a running turn and never quits — a second
      // Esc while the interrupt drains does nothing, and a lane that cannot
      // cancel says so instead of quitting.
      if (routed.interrupt === true) {
        const running = activeTurn;
        if (running?.isRunning() === true) {
          if (!running.canCancel()) {
            app.setEditorFooter(
              `this run cannot be interrupted here — press ${keys.label('app.interrupt')} twice to quit`,
            );
          } else if (!running.isCancelling()) {
            interruptTurn(running);
            return { consume: true };
          }
        }
        screen?.update();
        return { consume: true };
      }
      if (routed.quit) {
        if (routed.cancel && activeTurn?.isRunning()) {
          // A lane that cannot cancel never fakes it — Ctrl-C
          // quits instead (the shutdown drain is bounded).
          if (!activeTurn.canCancel()) {
            shutdown();
            return { consume: true };
          }
          // Ctrl-C during a turn. The first one cancels the operation and
          // keeps the session alive; a second one (while the cancellation is
          // still draining) quits, which is the contract docs/cli/commands.md
          // ships.
          if (!activeTurn.isCancelling()) {
            interruptTurn(activeTurn);
            return { consume: true };
          }
        }
        shutdown();
        return { consume: true };
      }
      // A consuming listener pre-empts pi-tui's own post-input
      // render (it only runs on the focused-component path), so every key
      // the app consumed — a typed character, a global toggle, an approval
      // decision — asks for its frame here. Without it nothing repaints
      // while idle: no spinner, no turn refresh.
      if (routed.consumed) {
        screen?.update();
        return { consume: true };
      }
      return undefined;
    };
    if (turn !== undefined) {
      // `/model` never reaches the lane as a prompt. The report
      // and the refusal are footer lines (the editor row's always-visible
      // status surface); a successful switch updates the app's model label
      // and leaves a confirmation behind.
      const handleModelCommand = (command: TuiModelCommand): void => {
        if (turn === undefined) {
          app.setEditorFooter('model switch needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        // A bare `/model` opens the picker (the way in where
        // Alt+M types `µ`, as macOS Option does).
        if (command.kind === 'pick') {
          openModelPicker();
          return;
        }
        if (command.kind === 'invalid') {
          app.setEditorFooter(`model switch failed: ${command.message}`);
          if (!stopped) screen?.render();
          return;
        }
        switchModelTo(command.selection);
      };
      // `/escalate <ref> [reason]` — the explicit
      // climb. Same busy guard and switch path as `/model`; the reason
      // travels to the loop so the escalation event names it.
      const handleEscalateCommand = (command: TuiEscalateCommand): void => {
        if (turn === undefined) {
          app.setEditorFooter('model switch needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        if (command.kind === 'invalid') {
          app.setEditorFooter(`escalation failed: ${command.message}`);
          if (!stopped) screen?.render();
          return;
        }
        switchModelTo(command.selection, command.reason);
      };
      // `/new` and `/resume` swap the session under the running
      // TUI. The next lane boots FIRST (a failed boot keeps the session the
      // operator was in), the previous one closes, and every lane-bound
      // object and session-scoped surface is rebuilt — the alt-screen, the
      // terminal and the app itself are never torn down.
      const rebindSession = async (nextSessionId?: string): Promise<void> => {
        const previous = boot;
        const next = await deps.bootLane(nextSessionId, surface.seat, flags);
        await previous.close?.();
        await adoptBoot(next);
      };
      // Every lane-bound object and session-scoped surface follows the boot.
      const adoptBoot = async (next: TuiLaneBoot): Promise<void> => {
        boot = next;
        // Every re-boot (session switch, fork) gets the live
        // counter too — a fresh boot's cell starts unwired.
        next.setCurrentTurnSupplier?.(() => reconcileTurn);
        activeTurn = undefined;
        inFlightTurns = 0;
        droppedOnCancel = 0;
        queuedInbox = [];
        queuedText.clear();
        shellRanThisTurn = false;
        reconcileTurn = 0;
        reconcileTurnOpen = false;
        turn = buildTurn();
        app.resetSession({
          sessionId: next.sessionId,
          model: next.model,
          usage: next.usageRows ?? [],
        });
        syncPosture();
        app.setEditorFooter(
          [next.pendingNotice, next.modelNotice]
            .filter((line): line is string => line !== undefined)
            .join(' · '),
        );
        journalFeed?.now();
        await turn?.refreshTranscript();
        // After the first read: a transcript snapshot replaces the notice
        // cells, so an earlier append would be wiped. The alt-screen is up, so
        // the new lane's boot notices (full access, skipped skills) join its
        // queued warnings here, as transcript rows and never on stderr.
        const rows = [
          ...(next.notices ?? []).map((notice) => `warning: ${notice}`),
          ...(next.loop?.drainNotices?.() ?? []),
        ];
        for (const line of rows) app.appendNotice([line]);
        if (!stopped) screen?.render();
      };

      // The commands this TUI answers itself. Every one of them
      // reports on the footer (and, when there is something to read, in the
      // transcript) and NONE of them reaches the model.
      // The commands this TUI answers itself. Every one of them
      // reports on the footer (and, when there is something to read, in the
      // transcript) and NONE of them reaches the model.
      //
      // The side-effecting entries dispatch on the `command` their
      // registry row names (typed, never a bare string); the local reads
      // carry no presentation command and dispatch by name. The
      // side-effecting commands are refused while a turn runs — they swap or
      // close the session under it (the quit path's drain is the only place
      // that owns that race).
      const busyRefusal = (what: string): TuiSubmitOutcome => {
        app.setEditorFooter(
          `${what}: finish the current turn before switching`,
        );
        if (!stopped) screen?.render();
        return 'refused';
      };
      const openNewSession = (): TuiSubmitOutcome => {
        app.setEditorFooter('session: booting a fresh session…');
        if (!stopped) screen?.render();
        void rebindSession(undefined)
          .then(() => {
            if (stopped) return;
            app.setEditorFooter(`session: ${boot.sessionId} (new)`);
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `session: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
        return 'accepted';
      };
      // `/resume`'s choice, and the palette's SESSIONS rows.
      const resumeSession = (id: string): void => {
        if (activeTurn?.isRunning() === true) {
          busyRefusal('session');
          return;
        }
        app.setEditorFooter(`session: attaching ${id}…`);
        screen?.render();
        void rebindSession(id)
          .then(() => {
            if (stopped) return;
            app.setEditorFooter(`session: ${boot.sessionId} (resumed)`);
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `session: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };
      // One picker row per summarized session — its first
      // prompt, then age · turns · cost; a held one greyed with why.
      const sessionPickerRow = (summary: SessionSummary): TuiPickerRow => {
        const created =
          summary.createdAt === undefined
            ? Number.NaN
            : Date.parse(summary.createdAt);
        const detail = [
          Number.isNaN(created) ? undefined : formatAge(Date.now() - created),
          summary.turns === undefined
            ? undefined
            : `${summary.turns} turn${summary.turns === 1 ? '' : 's'}`,
          summary.costUsd === undefined
            ? undefined
            : formatCost(summary.costUsd),
        ].filter((part): part is string => part !== undefined);
        return {
          value: summary.id,
          label: summary.title ?? summary.id,
          ...(detail.length === 0 ? {} : { description: detail.join(' · ') }),
          ...(summary.state === 'ready'
            ? {}
            : { disabled: true, note: 'in use by another kubic' }),
        };
      };
      const openSessionPicker = (
        summarize: (exclude?: string) => Promise<readonly SessionSummary[]>,
      ): TuiSubmitOutcome => {
        app.setEditorFooter('resume: reading this project’s sessions…');
        if (!stopped) screen?.render();
        void summarize(boot.sessionId)
          .then((summaries) => {
            if (stopped) return;
            if (summaries.length === 0) {
              app.setEditorFooter('resume: no other sessions in this project');
              screen?.render();
              return;
            }
            app.setEditorFooter('');
            const opened = app.openPicker({
              title: 'Session',
              rows: summaries.map(sessionPickerRow),
              onSelect: resumeSession,
              onCancel: () => {
                if (stopped) return;
                app.setEditorFooter('resume: cancelled');
                screen?.render();
              },
            });
            if (!opened) {
              app.setEditorFooter(
                'resume needs a wider terminal — use kubic sessions list',
              );
            }
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `resume: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
        return 'accepted';
      };
      const openResumePicker = (): TuiSubmitOutcome => {
        if (boot.summarizeSessions !== undefined) {
          return openSessionPicker(boot.summarizeSessions);
        }
        const list = boot.listSessions;
        if (list === undefined) {
          app.setEditorFooter(
            'resume: this session cannot list other sessions',
          );
          if (!stopped) screen?.render();
          return 'refused';
        }
        void list()
          .then((rows) => {
            if (stopped) return;
            const others = rows.filter((row) => row.id !== boot.sessionId);
            if (others.length === 0) {
              app.setEditorFooter('resume: no other sessions');
              screen?.render();
              return;
            }
            const opened = app.openPicker({
              rows: others.map((row) => ({
                value: row.id,
                label: row.id,
                description: [row.cwd, row.createdAt]
                  .filter((part): part is string => part !== undefined)
                  .join(' · '),
              })),
              onSelect: resumeSession,
              onCancel: () => {
                if (stopped) return;
                app.setEditorFooter('resume: cancelled');
                screen?.render();
              },
            });
            if (!opened) {
              app.setEditorFooter(
                'resume needs a wider terminal — use kubic sessions list',
              );
            }
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `resume: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
        return 'accepted';
      };
      // Pi-durable branches by forking, so `/fork` and `/tree` fork the live
      // session into a NEW session (the store fork) and switch the TUI to it;
      // the original keeps the abandoned path. The fork needs the session's
      // lock, so this boot closes FIRST; a failed fork re-attaches the session
      // the operator was in.
      const forkInto = async (at: number, prefill?: string): Promise<void> => {
        const previous = boot;
        const fork = previous.forkAt;
        if (fork === undefined) throw new Error('this session cannot fork');
        const sourceId = previous.sessionId;
        await previous.close?.();
        let forkId: string;
        try {
          forkId = await fork(at);
        } catch (error) {
          await adoptBoot(await deps.bootLane(sourceId, surface.seat, flags));
          throw error;
        }
        await adoptBoot(await deps.bootLane(forkId, surface.seat, flags));
        if (prefill !== undefined) app.editor.setText(prefill);
        app.setEditorFooter(
          `fork: ${forkId} — from ${sourceId} at #${at}${prefill === undefined ? '' : ' (edit the prompt and press enter)'}`,
        );
      };
      const runFork = (at: number, prefill?: string): TuiSubmitOutcome => {
        app.setEditorFooter(`fork: forking at #${at}…`);
        if (!stopped) screen?.render();
        void forkInto(at, prefill)
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `fork: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            if (!stopped) screen?.render();
          });
        return 'accepted';
      };
      // `/tree`: the lane's earlier prompts, each forking just BEFORE itself.
      const openTreePicker = (): TuiSubmitOutcome => {
        const loop = boot.loop;
        if (loop === undefined || boot.forkAt === undefined) {
          app.setEditorFooter('tree: this session cannot fork');
          if (!stopped) screen?.render();
          return 'refused';
        }
        void loop
          .entries(loop.context)
          .then((raw) => {
            if (stopped) return;
            const sorted = [...raw].sort((a, b) => Number(a.id) - Number(b.id));
            const points: ForkPoint[] = [];
            for (let i = 1; i < sorted.length; i += 1) {
              const lane = laneEntryFor(sorted[i] as EntryRecord);
              const text =
                lane === undefined ? undefined : userPromptsOf([lane])[0];
              if (text === undefined) continue;
              points.push({
                entryId: Number(sorted[i]?.id),
                at: Number(sorted[i - 1]?.id),
                text,
              });
            }
            if (points.length === 0) {
              app.setEditorFooter('tree: no earlier prompts to fork from');
              screen?.render();
              return;
            }
            const opened = app.openPicker({
              rows: forkPickerRows(points),
              onSelect: (value) => {
                const [at, entryId] = value.split(':').map(Number);
                const point = points.find((p) => p.entryId === entryId);
                if (at === undefined || point === undefined) return;
                runFork(at, point.text);
              },
              onCancel: () => {
                if (stopped) return;
                app.setEditorFooter('tree: cancelled');
                screen?.render();
              },
            });
            if (!opened) {
              app.setEditorFooter(
                'tree needs a wider terminal — use kubic sessions fork',
              );
            }
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `tree: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
        return 'accepted';
      };
      // `/theme [name]` — the built-ins and the configured theme
      // file, previewed live as the selection moves; ⏎ keeps it for this
      // session (the config is never written), esc restores the one before.
      const configuredTheme =
        deps.theme !== undefined &&
        deps.theme !== '' &&
        !isThemeBuiltin(deps.theme)
          ? deps.theme
          : undefined;
      // `default` is the dark brand palette's other name.
      let activeTheme =
        deps.theme === undefined ||
        deps.theme === '' ||
        deps.theme === 'default'
          ? 'dark'
          : deps.theme;
      const themeChoices = (): string[] => [
        'dark',
        'light',
        'terminal',
        ...(configuredTheme === undefined ? [] : [configuredTheme]),
      ];
      const applyTheme = (name: string): boolean => {
        try {
          setTuiTheme(resolveTuiTheme(name, resolvedTheme.level, files));
        } catch (error) {
          app.setEditorFooter(
            `theme: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (!stopped) screen?.render();
          return false;
        }
        if (!stopped) screen?.render();
        return true;
      };
      const keepTheme = (name: string): void => {
        activeTheme = name;
        app.appendNotice([
          `theme: ${name} for this session — to keep it: [ui] theme = "${name}" in ~/.kubic/config.toml`,
        ]);
        app.setEditorFooter(`theme: ${name}`);
        if (!stopped) screen?.render();
      };
      const openThemePicker = (argument: string): TuiSubmitOutcome => {
        if (argument !== '') {
          if (!themeChoices().includes(argument)) {
            app.setEditorFooter(
              `theme: unknown theme '${argument}' — ${themeChoices().join(', ')}`,
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          if (!applyTheme(argument)) return 'refused';
          keepTheme(argument);
          return 'command';
        }
        const before = activeTheme;
        const opened = app.openPicker({
          title: 'Theme',
          rows: themeChoices().map((name) => ({
            value: name,
            label: name === configuredTheme ? basename(name) : name,
            ...(name === activeTheme ? { current: true } : {}),
            ...(name === configuredTheme
              ? { description: 'from [ui] theme' }
              : {}),
          })),
          onMove: (value) => {
            if (value !== undefined) applyTheme(value);
          },
          onSelect: (value) => {
            if (applyTheme(value)) keepTheme(value);
          },
          onCancel: () => {
            if (stopped) return;
            applyTheme(before);
            app.setEditorFooter(`theme: ${before} (kept)`);
            screen?.render();
          },
        });
        if (!opened) {
          app.setEditorFooter(
            'theme picker needs a wider terminal — use /theme <name>',
          );
          if (!stopped) screen?.render();
        }
        return 'command';
      };
      const runLocalCommand = (
        command: ParsedSlashCommand,
      ): TuiSubmitOutcome => {
        const spec = findSlashCommand(command.name);
        switch (spec?.command) {
          case 'session.attach': {
            if (activeTurn?.isRunning() === true) return busyRefusal('session');
            return command.name === 'resume'
              ? openResumePicker()
              : openNewSession();
          }
          case 'session.fork': {
            if (activeTurn?.isRunning() === true) return busyRefusal('fork');
            if (command.name === 'tree') return openTreePicker();
            const at = /^\d+$/.test(command.argument)
              ? Number(command.argument)
              : undefined;
            if (at === undefined) {
              app.setEditorFooter(
                'usage: /fork <entry> — /tree picks an earlier prompt',
              );
              if (!stopped) screen?.render();
              return 'refused';
            }
            return runFork(at);
          }
          default: {
            break;
          }
        }
        switch (command.name) {
          case 'help': {
            const wanted =
              command.argument === ''
                ? undefined
                : findSlashCommand(command.argument.replace(/^\//, ''));
            if (command.argument !== '' && wanted === undefined) {
              app.setEditorFooter(
                `help: unknown command '${command.argument}' — /help lists the commands`,
              );
              if (!stopped) screen?.render();
              return 'refused';
            }
            const lines =
              wanted === undefined
                ? helpLines()
                : [
                    `${wanted.usage} — ${wanted.summary}${
                      wanted.keys === undefined ? '' : ` (${wanted.keys})`
                    }`,
                  ];
            app.appendNotice(lines);
            app.setEditorFooter(
              wanted === undefined
                ? `help: ${SLASH_COMMANDS.length} commands — the list is in the transcript`
                : `help: ${wanted.usage}`,
            );
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'theme':
            return openThemePicker(command.argument);
          case 'safety': {
            // The honest limits, in full. The wording is the
            // limits module's (never re-worded here), and an explicit ask is
            // answered even where the startup notice is suppressed.
            app.appendNotice(
              noIsolationNoticeLines().map((line) =>
                line.replace(/^warning: /, ''),
              ),
            );
            app.setEditorFooter('safety: the limits are in the transcript');
            if (!stopped) screen?.render();
            // A local read with its own output: no prompt echo under it.
            return 'command';
          }
          case 'session': {
            const report = app.sessionReport(boot.cwd);
            app.appendNotice([report]);
            app.setEditorFooter(report);
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'scoped-models': {
            // The role's resolved allowed set: a
            // local read like `/session` — the loop reports, nothing is
            // sent, and a bare inspection never mutates the transcript
            // beyond the report row.
            const report = formatScopedModels(
              boot.scopedModels?.role,
              boot.scopedModels?.models,
            );
            app.appendNotice([report]);
            app.setEditorFooter(report);
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'approvals': {
            const argument = command.argument.trim().toLowerCase();
            if (argument === '') {
              app.setEditorFooter(
                fullAccessLive()
                  ? 'approvals: full access ON for this session'
                  : 'approvals: enforced — challenged calls ask',
              );
              if (!stopped) screen?.render();
              return 'accepted';
            }
            // The argument names a DIRECTION,
            // so it never flips the other way. `on` in a session that is
            // already on is a report (it must not toggle off, and it must
            // not open a dialog that would); `off` in a session that is
            // already off is a report too — never a second no-op row for a
            // change that did not happen. Only `Alt+A` toggles.
            if (argument === 'on') {
              if (fullAccessLive()) {
                app.setEditorFooter(
                  'approvals: full access already ON for this session',
                );
                if (!stopped) screen?.render();
                return 'accepted';
              }
              return openFullAccessConfirm();
            }
            if (argument === 'off') {
              if (!fullAccessLive()) {
                app.setEditorFooter('approvals: enforced — nothing to change');
                if (!stopped) screen?.render();
                return 'accepted';
              }
              return applyFullAccess(false);
            }
            app.setEditorFooter(
              `approvals: expected 'on' or 'off' (got '${command.argument}')`,
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          case 'diff': {
            app.openPanel('diff');
            app.setEditorFooter('diff: panel open (Ctrl-O closes)');
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'undo': {
            if (activeTurn?.isRunning() === true) return busyRefusal('undo');
            const store = boot.journal;
            const root = boot.cwd;
            if (store === undefined || root === undefined) {
              app.setEditorFooter('undo: this session has no journal to undo');
              if (!stopped) screen?.render();
              return 'refused';
            }
            const plan = planUndo(store, {}, root);
            if (plan.steps.length === 0) {
              app.setEditorFooter('undo: nothing to undo');
              if (!stopped) screen?.render();
              return 'accepted';
            }
            const result = applyUndo(store, plan, root, {});
            const summary = `undo: ${result.restored.length} restored, ${result.skipped.length} skipped`;
            app.appendNotice([
              summary,
              ...result.warnings.map((warning) => `warn: ${warning}`),
            ]);
            app.setEditorFooter(summary);
            journalFeed?.now();
            if (!stopped) screen?.render();
            return 'accepted';
          }
          case 'quit': {
            shutdown();
            return 'accepted';
          }
          case 'skill': {
            // The space form (`/skill <name>`) is the colon form mistyped.
            app.setEditorFooter(SKILL_COMMAND_USAGE);
            if (!stopped) screen?.render();
            return 'refused';
          }
          case 'image': {
            // `/image <path>` attaches one image to the
            // next prompt. The registry owns discovery (palette,
            // autocomplete, `/help`); the read and the validation are the
            // composition root's, and a bare `/image` is the usage error.
            const parsed = parseImageCommand(
              command.argument === '' ? '/image' : `/image ${command.argument}`,
            );
            if (parsed === undefined || parsed.kind === 'invalid') {
              app.setEditorFooter(
                parsed === undefined ? IMAGE_COMMAND_USAGE : parsed.message,
              );
              if (!stopped) screen?.render();
              return 'refused';
            }
            void attachFromPath(parsed.path);
            return 'command';
          }
          default: {
            app.setEditorFooter(
              `'/${command.name}': not implemented in this session`,
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
        }
      };

      // One switch path for `/model <id>` and the picker's
      // Enter — the same footer wording and the same refusal text.
      // Adds the reason: `/escalate <id> [reason]` records it
      // in the escalation event; `/model` passes none (a silent climb).
      // `thinking` is the level the model picker chose with the
      // model; it is set once the switch (which re-clamps the old one) lands.
      const switchModelTo = (
        selection: ModelSelection,
        reason?: string,
        thinking?: ModelThinkingLevel,
      ): void => {
        if (turn === undefined) {
          app.setEditorFooter('model switch needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        app.setEditorFooter(
          `switching model to ${selection.provider}/${selection.id}…`,
        );
        if (!stopped) screen?.render();
        void turn
          .switchModel(selection, reason)
          .then(async (label) => {
            if (stopped) return;
            // The climb just recorded reports its
            // transcript row now — not on the next settled turn. The
            // drain is idempotent, so the turn drain later finds nothing.
            for (const row of boot.loop?.drainEscalationRows?.() ?? []) {
              app.appendNotice([row]);
            }
            // The new model may not accept images. The
            // attachments were validated against the OLD model, so they are
            // dropped rather than sent to a model that cannot take them.
            if (pendingImages.length > 0) {
              const loop = boot.loop;
              const supported = await loop?.supportsImages?.(loop.context);
              if (stopped) return;
              if (supported !== true) {
                const dropped = pendingImages.length;
                pendingImages = [];
                app.setPendingImages([]);
                app.setPendingAttachments(0);
                app.setEditorFooter(
                  `model: ${label} (switched) · dropped ${dropped} attached image${dropped === 1 ? '' : 's'} — ${label} does not accept image input`,
                );
                screen?.render();
                return;
              }
            }
            app.setEditorFooter(`model: ${label} (switched)`);
            screen?.render();
            if (thinking !== undefined) {
              handleThinkingCommand({ kind: 'switch', level: thinking });
            }
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `model switch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };

      // `/thinking <level>` — report, switch (clamped by the lane
      // to what the live model supports) or refuse an unknown level by name.
      const handleThinkingCommand = (command: TuiThinkingCommand): void => {
        if (turn === undefined) {
          app.setEditorFooter('thinking needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        // A bare `/thinking` picks from the levels the live
        // model supports (Alt+T keeps cycling them).
        if (command.kind === 'pick') {
          const runner = turn;
          void Promise.all([runner.supportedThinking(), runner.liveThinking()])
            .then(([levels, live]) => {
              if (stopped) return;
              const opened = app.openPicker({
                title: 'Thinking',
                rows: levels.map((level) => ({
                  value: level,
                  label: level,
                  ...(level === live ? { current: true } : {}),
                })),
                onSelect: (value) => {
                  if (value !== live && isThinkingLevel(value)) {
                    handleThinkingCommand({ kind: 'switch', level: value });
                  } else {
                    app.setEditorFooter(`thinking: ${live}`);
                    screen?.render();
                  }
                },
                onCancel: () => {
                  if (stopped) return;
                  app.setEditorFooter(`thinking: ${live} (picker cancelled)`);
                  screen?.render();
                },
              });
              if (!opened) app.setEditorFooter(`thinking: ${live}`);
              screen?.render();
            })
            .catch((error: unknown) => {
              if (stopped) return;
              app.setEditorFooter(
                `thinking: ${error instanceof Error ? error.message : String(error)}`,
              );
              screen?.render();
            });
          return;
        }
        if (command.kind === 'invalid') {
          app.setEditorFooter(`thinking: ${command.message}`);
          if (!stopped) screen?.render();
          return;
        }
        const requested = command.level;
        void turn
          .switchThinking(requested)
          .then((effective) => {
            if (stopped) return;
            app.setEditorFooter(
              effective === requested
                ? `thinking: ${effective}`
                : `thinking: ${effective} (clamped from ${requested})`,
            );
            screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `thinking switch failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };

      // Alt+T cycles the level over what the live model supports
      // (thinking.cycle), committing each step through the same path.
      const cycleThinking = (): void => {
        if (stopped) return;
        if (activeTurn?.isRunning() === true) {
          app.setEditorFooter(
            'thinking: finish the current turn before switching',
          );
          screen?.render();
          return;
        }
        if (turn === undefined) {
          app.setEditorFooter('thinking needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        void (async () => {
          const [current, levels] = await Promise.all([
            turn.liveThinking(),
            turn.supportedThinking(),
          ]);
          if (levels.length === 0) {
            app.setEditorFooter('thinking: this model has no thinking levels');
            if (!stopped) screen?.render();
            return;
          }
          const at = levels.indexOf(current);
          const next = levels[(at + 1) % levels.length] ?? levels[0];
          const effective = await turn.switchThinking(next);
          if (stopped) return;
          app.setEditorFooter(`thinking: ${effective}`);
          screen?.render();
        })().catch((error: unknown) => {
          if (stopped) return;
          app.setEditorFooter(
            `thinking switch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          screen?.render();
        });
      };

      // Alt+M opens the picker over the usable catalog rows. The
      // overlay owns the modal input; a pick goes through `switchModelTo`.
      const openModelPicker = (): void => {
        if (stopped) return;
        if (activeTurn?.isRunning() === true) {
          app.setEditorFooter(
            'model: finish the current turn before switching',
          );
          screen?.render();
          return;
        }
        if (turn === undefined) {
          app.setEditorFooter('model switch needs a live lane');
          if (!stopped) screen?.render();
          return;
        }
        // Captured: the callbacks below run after a `/new` may have replaced
        // the runner, and they must report the one this picker came from.
        const runner = turn;
        void Promise.all([
          runner.listModels(),
          runner.listProviders(),
          runner.liveThinking().catch(() => undefined),
        ])
          .then(([rows, providers, thinking]) => {
            if (stopped) return;
            const opened = app.openModelPicker({
              rows: rows.map((row) => ({
                provider: row.provider,
                id: row.id,
                label: `${row.provider}/${row.id}`,
                current: row.current,
                ...(row.note === undefined ? {} : { note: row.note }),
                ...(row.contextWindow === undefined
                  ? {}
                  : { contextWindow: row.contextWindow }),
                ...(row.reasoning === undefined
                  ? {}
                  : { reasoning: row.reasoning }),
                ...(row.thinking === undefined
                  ? {}
                  : { thinking: row.thinking }),
              })),
              providers,
              ...(thinking === undefined ? {} : { thinking }),
              // Model and thinking level are one decision —
              // the level follows the switch (which re-clamps it), and is
              // set only when the operator moved it.
              onSelect: (row, level) => {
                const moved =
                  level !== undefined &&
                  level !== thinking &&
                  isThinkingLevel(level);
                if (row.current === true) {
                  if (moved) handleThinkingCommand({ kind: 'switch', level });
                  else app.setEditorFooter(`model: ${runner.modelRef}`);
                  if (!stopped) screen?.render();
                  return;
                }
                switchModelTo(
                  { provider: row.provider, id: row.id },
                  undefined,
                  moved ? level : undefined,
                );
              },
              onCancel: () => {
                if (stopped) return;
                app.setEditorFooter(
                  `model: ${runner.modelRef} (picker cancelled)`,
                );
                screen?.render();
              },
            });
            if (!opened) {
              app.setEditorFooter(
                'model picker unavailable on this terminal — use /model <provider/id>',
              );
            }
            if (!stopped) screen?.render();
          })
          .catch((error: unknown) => {
            if (stopped) return;
            app.setEditorFooter(
              `model picker failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            screen?.render();
          });
      };
      pickModelForLoop = openModelPicker;
      cycleThinkingForLoop = cycleThinking;

      // Ctrl-P's grouped palette. The app owns the
      // command and file rows; this boot supplies the model catalog and this
      // project's other sessions, and the actions behind them: a command row
      // is submitted exactly as if typed (the dispatcher above owns the
      // rest), a model row switches like the picker, a session row resumes
      // like `/resume`.
      const openPalette = (): void => {
        if (stopped) return;
        const runner = turn;
        const list = boot.listSessions;
        const opened = app.openPalette({
          runCommand: (command) => {
            submitForLoop?.(command, false);
          },
          ...(runner === undefined
            ? {}
            : {
                models: async () => runner.listModels(),
                switchModel: (provider: string, id: string) => {
                  if (activeTurn?.isRunning() === true) {
                    app.setEditorFooter(
                      'model: finish the current turn before switching',
                    );
                    if (!stopped) screen?.render();
                    return;
                  }
                  switchModelTo({ provider, id });
                },
              }),
          ...(boot.summarizeSessions !== undefined
            ? {
                // The summaries `/resume` lists (titled, this
                // project only); a held session cannot resume.
                sessions: async () =>
                  ((await boot.summarizeSessions?.(boot.sessionId)) ?? [])
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
                resumeSession,
              }
            : list === undefined
              ? {}
              : {
                  sessions: async () =>
                    (await list()).filter(
                      (row) =>
                        row.id !== boot.sessionId &&
                        (boot.cwd === undefined ||
                          row.cwd === undefined ||
                          row.cwd === boot.cwd),
                    ),
                  resumeSession,
                }),
          onCancel: () => {
            if (stopped) return;
            app.setEditorFooter('palette: cancelled');
            screen?.render();
          },
        });
        if (!opened) {
          app.setEditorFooter('palette needs a wider terminal — type /help');
        }
        if (!stopped) screen?.render();
      };
      paletteForLoop = openPalette;

      // The in-session full-access toggle. The host
      // path writes posture.json + one audit row and flips the INSTALLED
      // policy's live posture, so the next challenged call follows; the
      // indicator is re-read from the same predicate in this frame.
      const applyFullAccess = (enabled: boolean): TuiSubmitOutcome => {
        const setFullAccess = boot.setFullAccess;
        if (setFullAccess === undefined) {
          app.setEditorFooter(
            'approvals: this session cannot change its posture',
          );
          if (!stopped) screen?.render();
          return 'refused';
        }
        try {
          const grant = setFullAccess(enabled);
          syncPosture();
          app.appendNotice([grant.warning]);
          app.setEditorFooter(
            enabled
              ? 'approvals: full access ON for this session — every challenged call runs without asking'
              : 'approvals: enforced again — the next challenged call asks',
          );
        } catch (error) {
          app.setEditorFooter(
            `approvals: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!stopped) screen?.render();
        return 'accepted';
      };
      // Enabling asks first (the dialog names the consequence); disabling is
      // immediate. The dialog accepts only its deliberate key.
      //
      // The confirmation is a modal of its
      // own and `Alt+A` is a GLOBAL key, so it would otherwise open OVER a
      // pending approval — where its advertised Ctrl-S is swallowed by the
      // approval surface and Esc/Ctrl-C DENY the challenged call instead of
      // cancelling the dialog. One modal at a time: while an approval owns
      // the keys the confirmation refuses by name.
      const openFullAccessConfirm = (): TuiSubmitOutcome => {
        if (stopped) return 'refused';
        if (app.hasPendingApproval()) {
          app.setEditorFooter('approvals: answer the pending request first');
          if (!stopped) screen?.render();
          return 'refused';
        }
        const opened = app.openConfirm({
          title: 'enable full access for this session?',
          body: [
            'every challenged call in this session will run without asking',
            'the change is written to posture.json and one audit row',
          ],
          confirmKey: 'ctrl+s',
          confirmLabel: 'Ctrl-S',
          onConfirm: () => {
            applyFullAccess(true);
          },
          onCancel: () => {
            if (stopped) return;
            app.setEditorFooter('approvals: unchanged');
            screen?.render();
          },
        });
        if (!opened) {
          app.setEditorFooter(
            'approvals: the confirmation needs the overlay — this terminal is too narrow',
          );
          if (!stopped) screen?.render();
          return 'refused';
        }
        if (!stopped) screen?.render();
        return 'accepted';
      };
      // The LIVE posture, read from the same
      // predicate the status bar uses, so a direction can be checked against
      // what is actually in force.
      const fullAccessLive = (): boolean =>
        boot.approvalsSkipped?.() ?? boot.fullAccess === true;
      // `Alt+A` is the TOGGLE: an already-on session flips off through it.
      const toggleFullAccess = (): TuiSubmitOutcome =>
        fullAccessLive() ? applyFullAccess(false) : openFullAccessConfirm();
      fullAccessForLoop = () => {
        toggleFullAccess();
      };

      // One accepted prompt → one turn on its driver. A busy
      // Enter starts a SECOND run while the first is still in flight (the
      // harness queues it), so the busy latch counts turns instead of
      // holding one: the spinner and the editor stay in flight until the
      // last settles.
      let inFlightTurns = 0;
      // The busy latch follows PLACED work, not
      // submitted promises. A follow-up waiting in the inbox — admitted while
      // a turn ran, or left behind by a failed run (pi-durable keeps queued
      // inputs after a fault) — is not a run: the spinner stops and the
      // queued row is what the operator sees. `activeTurn` outlives it, so a
      // later submit places the queue and the same driver runs again.
      const syncBusy = (): void => {
        if (stopped) return;
        const running = activeTurn?.isRunning() === true;
        if (running && !app.isBusy()) {
          app.setBusy(true);
          startSpinner();
        } else if (!running && app.isBusy()) {
          app.setBusy(false);
          stopSpinner();
        }
        if (!stopped) screen?.render();
      };
      syncBusyForLoop = syncBusy;
      const startTurn = (
        driver: TuiTurnDriver,
        prompt: string,
        options?: TuiTurnOptions,
      ): void => {
        activeTurn = driver;
        inFlightTurns += 1;
        // The receipt counts this turn from its submission.
        const startedAt = Date.now();
        app.setBusy(true);
        startSpinner();
        screen?.render();
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
              syncBusy();
            },
          })
          .then((outcome) => {
            syncPosture();
            // A bash-made change is journaled only by the sweep;
            // run it BEFORE the panel read so this turn's shell effects are
            // on screen at settlement, not just at quit. A quit in progress
            // owns its own final sweep (close), and a failed sweep leaves
            // the panels on the rows they have.
            if (!stopped) {
              sweepPendingShell();
              // Between turns the workspace is the operator's —
              // unless a queued follow-up is already running, whose changes
              // the next sweep still owes.
              if (turn?.isRunning() !== true) {
                reconcileTurnOpen = false;
                rebaseline();
              }
            }
            journalFeed?.now();
            // The state word follows the outcome; a completed
            // turn clears the notice row (the trust statement lives in the
            // welcome block and behind `/safety`), a cancelled or failed one
            // keeps its own report there.
            app.setTurnOutcome(outcome.status, {
              startedAt,
              ...(outcome.detail === undefined
                ? {}
                : { detail: outcome.detail }),
            });
            footer = footerForOutcome(outcome);
            if (outcome.status === 'cancelled' && droppedOnCancel > 0) {
              footer = `${footer} · dropped ${droppedOnCancel} queued prompt${droppedOnCancel === 1 ? '' : 's'}`;
            }
            // A driver with its own settlement line (the compaction's
            // `compacted: …`) reports it instead of a turn outcome.
            footer = driver.settlementFooter?.() ?? footer;
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            app.setTurnOutcome('failed', { startedAt, detail: message });
            footer = `error: ${message}`;
          })
          .finally(() => {
            inFlightTurns -= 1;
            if (inFlightTurns === 0) {
              droppedOnCancel = 0;
              if (activeTurn === driver) activeTurn = undefined;
              // The turn is over — so is its edit batch.
              boot.endApprovalTurn?.();
            }
            // Sync BEFORE the footer: `setBusy(false)` clears the footer row.
            syncBusy();
            if (footer !== undefined && !stopped) app.setEditorFooter(footer);
            // The turn may have changed files or the branch.
            if (inFlightTurns === 0) refreshWorkspace();
            if (!stopped) screen?.render();
          });
      };

      // The one submit path — Enter, and Alt+Enter when idle.
      // `steer` marks the Alt+Enter form, which becomes a harness steer
      // while a turn runs instead of a queued follow-up.
      const submitPrompt = (
        prompt: string,
        steer: boolean,
      ): TuiSubmitOutcome => {
        if (stopped) return 'refused';
        const busy = activeTurn?.isRunning() === true;
        // The command attaches one image to
        // the next prompt. Nothing is echoed and nothing is restored on
        // success — the draft was a command, and the footer names the
        // attachment; a usage error hands the draft back.
        // `/compact [instructions]` is a lane operation, never a
        // prompt. It runs through the same busy/cancel wrapper as a turn, so
        // the spinner shows and Ctrl-C aborts it; the command text itself
        // never reaches the model or the transcript.
        // `/skill:<name> [instructions]` expands to
        // the skill content plus instructions and submits AS the prompt —
        // the mode, busy and attachment rules below apply unchanged. An
        // unknown name refuses locally by name (withheld skills resolve
        // unknown too, so the refusal never leaks their existence) and
        // never reaches the model.
        const skillCommand = parseSkillInvokeCommand(prompt);
        if (skillCommand !== undefined) {
          if (skillCommand.kind === 'invalid') {
            app.setEditorFooter(SKILL_COMMAND_USAGE);
            if (!stopped) screen?.render();
            return 'refused';
          }
          const invocation = boot.skillInvocation;
          if (invocation === undefined) {
            app.setEditorFooter(
              'skill: explicit invocation is unavailable in this session',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          try {
            prompt = invocation.invoke(
              skillCommand.name,
              skillCommand.instructions,
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            app.setEditorFooter(`skill: ${message}`);
            if (!stopped) screen?.render();
            return 'refused';
          }
        }
        // A slash command is never a prompt. An unknown one is
        // refused locally — it must not reach the model — and the registry's
        // own commands dispatch below. An expanded skill is
        // already a prompt, never a command — parsing it again would let a
        // skill body starting with `/` hijack the submit.
        const slashCommand =
          skillCommand !== undefined ? undefined : parseSlashCommand(prompt);
        if (
          slashCommand !== undefined &&
          !SLASH_COMMAND_NAMES.has(slashCommand.name)
        ) {
          app.setEditorFooter(
            `unknown command '/${slashCommand.name}' — /help lists the commands`,
          );
          if (!stopped) screen?.render();
          return 'refused';
        }
        const compactCommand =
          skillCommand !== undefined
            ? undefined
            : parseTuiCompactCommand(prompt);
        if (compactCommand !== undefined) {
          const lane = boot.loop;
          if (busy) {
            app.setEditorFooter(
              'compact: finish the current turn before compacting',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          if (lane?.compact === undefined) {
            app.setEditorFooter('compaction needs a live lane');
            if (!stopped) screen?.render();
            return 'refused';
          }
          startTurn(
            new TuiCompactionTurn(lane, compactCommand.focus, async () => {
              // The compaction entry is committed by the task, not
              // by a turn's event stream, so the transcript is re-read once
              // the task settles — the compaction cell then appears in the
              // same session (and in the quit's printed document).
              await turn?.refreshTranscript();
            }),
            prompt,
          );
          return 'accepted';
        }
        // `/thinking <level>` — same busy rule as `/model`: a
        // live switch never races a run. Skipped for an expanded
        // skill (a prompt, never a command).
        const thinkingCommand =
          skillCommand !== undefined ? undefined : parseThinkingCommand(prompt);
        if (thinkingCommand !== undefined) {
          if (busy) {
            app.setEditorFooter(
              'thinking: finish the current turn before switching',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          handleThinkingCommand(thinkingCommand);
          return 'accepted';
        }
        // Skipped for an expanded skill (a prompt, never a
        // command).
        const modelCommand =
          skillCommand !== undefined ? undefined : parseModelCommand(prompt);
        if (modelCommand !== undefined) {
          // A live switch is a conversation.configure: it never races a run.
          if (busy) {
            app.setEditorFooter(
              'model: finish the current turn before switching',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          handleModelCommand(modelCommand);
          return 'accepted';
        }
        // `/escalate <ref> [reason]` climbs the same
        // ladder as `/model` — the busy guard matches, since the climb is
        // a conversation.configure too. Skipped for an expanded skill.
        const escalateCommand =
          skillCommand !== undefined ? undefined : parseEscalateCommand(prompt);
        if (escalateCommand !== undefined) {
          if (busy) {
            app.setEditorFooter(
              'escalation: finish the current turn before climbing',
            );
            if (!stopped) screen?.render();
            return 'refused';
          }
          handleEscalateCommand(escalateCommand);
          return 'accepted';
        }
        // A session booted without a lane refuses by name instead of
        // pretending the prompt ran.
        const driver = turn;
        if (driver === undefined) {
          app.setEditorFooter('error: the lane is unavailable in this session');
          if (!stopped) screen?.render();
          return 'refused';
        }
        // The remaining registry commands answer locally.
        if (slashCommand !== undefined) {
          return runLocalCommand(slashCommand);
        }
        const sentImages = pendingImages;
        const imageOptions: TuiTurnOptions =
          sentImages.length === 0 ? {} : { images: sentImages };
        const imagesSent = (): void => {
          pendingImages = [];
          // The app keeps the sent images on the echo until the lane's own
          // prompt cell replaces it; the composer itself is empty again.
          app.setPendingImages(sentImages);
          // ... but nothing is armed any more: a blank Enter between this
          // submit and the echo's replacement is a no-op again.
          app.setPendingAttachments(0);
        };
        if (busy) {
          // The lane queues the prompt in the conversation's OWN
          // inbox — a follow-up (placed when the run answers) for Enter, a
          // steer (placed after the current tool round, joining the running
          // work) for Alt+Enter.
          startTurn(
            driver,
            prompt,
            steer
              ? { whenBusy: 'steer', ...imageOptions }
              : {
                  whenBusy: 'followUp',
                  onSubmitted: (id) => {
                    // The rows follow from the state: the id's text is what
                    // the projector resolves against this map.
                    queuedText.set(id, prompt);
                    // The images of a queued draft are remembered
                    // per submission id, so the echo that replaces the row
                    // carries them too.
                    if (sentImages.length > 0) queuedImages.set(id, sentImages);
                    turn?.refreshPresentation();
                  },
                  ...imageOptions,
                },
          );
          imagesSent();
          return 'queued';
        }
        startTurn(driver, prompt, imageOptions);
        imagesSent();
        return 'accepted';
      };

      app.onSubmit((prompt: string) => submitPrompt(prompt, false));
      // The steer key's own entry point (the key router is defined above).
      submitForLoop = submitPrompt;
      await turn?.refreshTranscript();
      // The boot's warnings (an unresolvable --skill) land after the first
      // read: a transcript snapshot replaces the notice cells.
      for (const line of boot.loop?.drainNotices?.() ?? []) {
        app.appendNotice([line]);
      }
      if (!stopped) screen?.render();
    }
  } catch (error) {
    // Post-start setup (boot/setFocus/render/input routing) can throw
    // after the alt-screen went active — restore the main screen and
    // close the lane so the reject never strands either. The setup
    // error stands.
    stopClock();
    detachSignals();
    detachFatal();
    stdin?.removeListener('end', onStdinEnd);
    stdin?.removeListener('close', onStdinEnd);
    try {
      screen?.stop((line: string) => deps.out(line));
    } catch {
      // Restore failures never mask the setup error.
    }
    try {
      await boot.close?.();
    } catch {
      // Close failures never mask the setup error.
    }
    setTuiTheme(previousTheme);
    throw error;
  }
  await exited;
  setTuiTheme(previousTheme);
  return { exitCode };
}

// A path under the home directory, written `~/…`.
function tildePath(path: string, home: string = homedir()): string {
  if (home === '' || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
