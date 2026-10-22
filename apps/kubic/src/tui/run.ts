// `kubic tui`: the interactive alt-screen over the lane. The composition root
// owns every side effect: it boots the real lane (the session bootstrap
// `kubic run` uses), opens the alt-screen on the replicated presentation,
// routes keyboard input through the tui controller, drives the lane for
// whatever the operator submits, feeds lane events into the transcript and
// usage rows into the status bar, and restores the main screen with the
// final document printed — on quit, on a signal, and exactly once.
//
// Cancellation: Ctrl-C or Esc during a turn aborts the in-flight
// conversation through the lane's own durable abort (conversation.abort and
// the conversation's kill drain) and keeps the session alive; a second
// Ctrl-C quits. While idle, Ctrl-C quits.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SESSION_ID_PATTERN } from '@kubic/agent/lane/session-store';
import {
  ModelSelectError,
  NoModelAvailableError,
} from '@kubic/agent/model-select';
import {
  type CommandResult,
  EXIT_FAILED,
  EXIT_PROVIDER,
  EXIT_USAGE,
  EXIT_WORKSPACE,
} from '@kubic/core/cli/exit-codes';
import { createNodeFileBridge, type FileBridge } from '@kubic/exec/file-bridge';
import { SpendWatch, spentToday } from '@kubic/host/cost';
import { mapCaughtErrorToTerminus } from '@kubic/host/run';
import { defaultSessionsRoot } from '@kubic/host/sessions';
import {
  type ApprovalSurface,
  createApprovalSurface,
} from '@kubic/tui/approval-surface';
import { KeybindingsError, type KeyRegistry } from '@kubic/tui/keybindings';
import type { LaneEntryLike } from '@kubic/tui/lane-cells';
import { userPromptsOf } from '@kubic/tui/lane-cells';
import { renderNoKeyPreflight } from '@kubic/tui/preflight';
import { bootScreen } from '@kubic/tui/screen';
import {
  detectColorLevel,
  setTuiTheme,
  ThemeError,
  type TuiTheme,
  tuiTheme,
} from '@kubic/tui/theme';
import type { Terminal } from '@kubic/tui/tui-boundary';
import { loadHighlighter } from '@kubic/tui/ui/highlight';
import { ToolSelectionError } from './boot.js';
import { createLoopApp, TuiChrome } from './chrome.js';
import {
  resolveTuiKeybindings,
  resolveTuiTheme,
} from './commands/appearance.js';
import { journalPanelFeed } from './commands/journal.js';
import { TuiContext } from './context.js';
import { contextMeter } from './context-meter.js';
import { laneEntryFor } from './entries.js';
import { TuiInput } from './input.js';
import { TuiLifecycle } from './lifecycle.js';
import type { TuiBootFlags, TuiCommandOptions, TuiRunDeps } from './options.js';
import { tildePath } from './paths.js';
import { submitPrompt } from './submit.js';
import { buildTurn } from './turns.js';
import type { TuiLaneBoot } from './types.js';

export async function runTuiCommand(
  options: TuiCommandOptions,
  deps: TuiRunDeps,
): Promise<CommandResult> {
  const report = deps.err ?? deps.out;
  // The selection is a usage rule the
  // parser owns — both flags at once exit 2 before the alt-screen (the
  // boot re-validates names/agreement with the reason).
  if (options.tools !== undefined && options.noTools === true) {
    report('error: --tools and --no-tools are mutually exclusive');
    return { exitCode: EXIT_USAGE };
  }
  // commander validated the id already; re-checked because it becomes a
  // path segment under the sessions root.
  const sessionId = options.session;
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    report(
      `error: invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
    return { exitCode: EXIT_USAGE };
  }
  const flags = bootFlags(options);
  // The theme and the keybindings are read through the exec file bridge,
  // the same seam `/image` uses.
  const files = createNodeFileBridge(process.cwd());
  const appearance = resolveAppearance(deps, files);
  if ('refused' in appearance) return appearance.refused;
  const { theme, keys } = appearance;
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
  const booted = await bootFirstLane(deps, theme, surface, sessionId, flags);
  if ('refused' in booted) return booted.refused;
  const ctx = new TuiContext({
    deps,
    flags,
    files,
    theme,
    keys,
    surface,
    boot: booted.boot,
  });
  ctx.spend = await tuiSpendWatch(deps);
  return runLoop(ctx, options);
}

// The `kubic tui` parity flags the boot receives.
function bootFlags(options: TuiCommandOptions): TuiBootFlags {
  const flags: TuiBootFlags = {};
  if (options.role !== undefined) flags.role = options.role;
  if (options.noSkills === true) flags.noSkills = true;
  const skillsList = options.skills ?? [];
  if (skillsList.length > 0) flags.skillsList = [...skillsList];
  if (options.dangerouslySkipApprovals === true) {
    flags.dangerouslySkipApprovals = true;
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    flags.tools = [...options.tools];
  }
  if (options.noTools === true) flags.noTools = true;
  return flags;
}

// The `[ui] theme` reference and the keybinding registry, resolved and
// validated BEFORE anything opens — a missing or invalid file is a named
// `error:` line and exit 2, never a half-painted screen or a silent fallback
// to the default palette. Keybinding conflicts and displaced defaults are
// reported on stderr (the main screen) and the TUI still starts.
function resolveAppearance(
  deps: TuiRunDeps,
  files: FileBridge,
): { theme: TuiTheme; keys: KeyRegistry } | { refused: CommandResult } {
  const report = deps.err ?? deps.out;
  let theme: TuiTheme;
  try {
    theme = resolveTuiTheme(
      deps.theme,
      deps.colorLevel ??
        detectColorLevel(process.env, process.stdout.isTTY === true),
      files,
    );
  } catch (error) {
    if (error instanceof ThemeError) {
      report(`error: ${error.message}`);
      return { refused: { exitCode: EXIT_USAGE } };
    }
    throw error;
  }
  let keys: KeyRegistry;
  try {
    keys = resolveTuiKeybindings(
      deps.keybindingsFile ?? join(homedir(), '.kubic', 'keybindings.json'),
      files,
    );
  } catch (error) {
    if (error instanceof KeybindingsError) {
      report(`error: ${error.message}`);
      return { refused: { exitCode: EXIT_USAGE } };
    }
    throw error;
  }
  for (const notice of keys.notices) report(`warning: ${notice}`);
  return { theme, keys };
}

// The first boot. A boot that fails ends the command before the alt-screen
// opens, with one `error:` line on stderr.
async function bootFirstLane(
  deps: TuiRunDeps,
  theme: TuiTheme,
  surface: ApprovalSurface,
  sessionId: string | undefined,
  flags: TuiBootFlags,
): Promise<{ boot: TuiLaneBoot } | { refused: CommandResult }> {
  const report = deps.err ?? deps.out;
  try {
    return { boot: await deps.bootLane(sessionId, surface.seat, flags) };
  } catch (error) {
    // No provider has a key — the first screen's
    // no-key block, printed to the terminal (no alt screen was entered, so
    // the `export` lines stay in the scrollback), then exit 6.
    if (error instanceof NoModelAvailableError) {
      const workspace = await deps.readWorkspace?.().catch(() => undefined);
      for (const line of renderNoKeyPreflight(theme.ui, {
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
        report(line);
      }
      return { refused: { exitCode: EXIT_PROVIDER } };
    }
    const message = error instanceof Error ? error.message : String(error);
    report(`error: ${message}`);
    if (error instanceof ModelSelectError) {
      return { refused: { exitCode: EXIT_PROVIDER } };
    }
    // A refused tool selection is a usage error (exit 2), not a
    // generic lane boot failure.
    if (error instanceof ToolSelectionError) {
      return { refused: { exitCode: EXIT_USAGE } };
    }
    return {
      refused: {
        exitCode:
          mapCaughtErrorToTerminus(error) === 'workspace_unavailable'
            ? EXIT_WORKSPACE
            : EXIT_FAILED,
      },
    };
  }
}

// The loop over the booted lane: the app, the screen, the input, and the
// lifecycle that ends it.
async function runLoop(
  ctx: TuiContext,
  options: TuiCommandOptions,
): Promise<CommandResult> {
  const { deps } = ctx;
  // Tool-journaled entries share the sweep numbering — the
  // supplier reads the loop's live counter (it is only ever invoked during
  // turns).
  ctx.boot.setCurrentTurnSupplier?.(() => ctx.reconcileTurn);
  // Colour only for a real terminal; NO_COLOR / FORCE_COLOR honoured.
  // The level is injectable (tests pass 'none', so the suite
  // never depends on the shell's colour variables) and the theme this run
  // replaces is restored when it ends — the global never leaks.
  const previousTheme = tuiTheme();
  setTuiTheme(ctx.theme);
  // The full-access warning lands on stderr (the main screen)
  // before the alt-screen opens, and the bar shows OFF from the first frame.
  for (const notice of ctx.boot.notices ?? []) {
    (deps.err ?? deps.out)(`warning: ${notice}`);
  }
  ctx.app = createLoopApp(ctx, options.role);
  // The resumed session's committed spend is on the bar from the
  // first frame, not only after the next turn's usage event.
  ctx.app.setUsage(ctx.boot.usageRows ?? []);
  await seedPromptHistory(ctx, options.session);
  // Code highlighting's grammars load once, before the first
  // frame — the other commands never pay for them.
  await loadHighlighter();
  ctx.terminal = deps.createTerminal();
  ctx.journalFeed = journalPanelFeed(ctx);
  ctx.journalFeed?.now();
  ctx.contextMeter = contextMeter(ctx);
  void ctx.contextMeter.request();
  ctx.turn = buildTurn(ctx);
  ctx.chrome = new TuiChrome(ctx);
  ctx.lifecycle = new TuiLifecycle(ctx);
  try {
    await openScreen(ctx, ctx.terminal);
  } catch (error) {
    // Post-start setup (boot/setFocus/render/input routing) can throw
    // after the alt-screen went active — restore the main screen and
    // close the lane so the reject never strands either. The setup
    // error stands.
    await ctx.lifecycle.abandon();
    setTuiTheme(previousTheme);
    throw error;
  }
  await ctx.lifecycle.exited;
  setTuiTheme(previousTheme);
  return { exitCode: ctx.exitCode };
}

// A resumed session's committed prompts seed the
// editor's Up history before the screen opens. Best-effort: a read that
// fails leaves the history empty, never the boot.
async function seedPromptHistory(
  ctx: TuiContext,
  sessionId: string | undefined,
): Promise<void> {
  const loop = ctx.boot.loop;
  if (sessionId === undefined || loop === undefined) return;
  try {
    const entries = await loop.entries(loop.context);
    ctx.app.seedPromptHistory(
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

async function openScreen(ctx: TuiContext, terminal: Terminal): Promise<void> {
  const { app } = ctx;
  const screen = bootScreen(terminal, app.root);
  ctx.screen = screen;
  // Focus the editor, not the tree — the loop's primary input
  // target is the prompt. T/t do not toggle (they type); Ctrl-T does.
  screen.tui.setFocus(app.editor);
  app.editor.bind(screen.tui);
  // The overlay seat. The app renders the approval through the
  // live alt-screen from here on; on a terminal too narrow for the overlay
  // (its own visible() gate) the inline body is the surface instead.
  app.attachApprovalOverlay(screen.tui);
  // A pending operation settled at boot (and a model notice)
  // is on the notice row from the first frame. The trust statement is the
  // welcome block's.
  app.setEditorFooter(
    [ctx.boot.pendingNotice, ctx.boot.modelNotice]
      .filter((line): line is string => line !== undefined)
      .join(' · '),
  );
  ctx.lifecycle.attachFatal();
  screen.render();
  ctx.chrome.startClock();
  ctx.chrome.refreshWorkspace();
  ctx.chrome.loadRecentSessions();
  ctx.lifecycle.attachSignals();
  ctx.lifecycle.attachStdin();
  const input = new TuiInput(ctx);
  screen.tui.addInputListener((data: string) => {
    // An exception anywhere in input handling (including the
    // synchronous paints it triggers) restores the terminal first.
    try {
      return input.route(data);
    } catch (error) {
      ctx.lifecycle.fatal(error);
      return { consume: true };
    }
  });
  // A boot without a lane is the viewer shell: no submit path.
  const turn = ctx.turn;
  if (turn === undefined) return;
  ctx.wired = true;
  app.onSubmit((prompt: string) => submitPrompt(ctx, prompt, false));
  await turn.refreshTranscript();
  // The boot's warnings (an unresolvable --skill) land after the first
  // read: a transcript snapshot replaces the notice cells.
  for (const line of ctx.boot.loop?.drainNotices?.() ?? []) {
    app.appendNotice([line]);
  }
  ctx.render();
}

// The process's spend against the `[policy]` caps; undefined when none is set.
// The day's spend is read only when a daily cap needs it.
async function tuiSpendWatch(
  deps: TuiRunDeps,
): Promise<SpendWatch | undefined> {
  const caps = deps.spend?.caps;
  if (
    caps === undefined ||
    (caps.run === undefined && caps.daily === undefined)
  ) {
    return undefined;
  }
  const today =
    caps.daily === undefined
      ? 0
      : await spentToday(deps.spend?.sessionsRoot ?? defaultSessionsRoot());
  return new SpendWatch(caps, today);
}
