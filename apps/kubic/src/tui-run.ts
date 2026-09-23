// `kubic tui` (issue #75): interactive alt-screen over the solo lane.
// The composition root owns every side effect: it boots the real solo
// lane (same session/model setup as the headless runner), opens the
// alt-screen on the replicated presentation, routes keyboard input
// through the tui controller (T/t toggles per #24, Ctrl-C quits), and
// restores the main screen with the final document printed — on quit,
// on SIGINT, and exactly once. `kubic run` is untouched (headless
// regression: tui-command.test.ts + binary exit codes).

import { join } from 'node:path';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import { assembleModels } from '../../../packages/host/src/models-cli.js';
import {
  mapCaughtErrorToTerminus,
  RUN_EXIT_FAILED,
  RUN_EXIT_OK,
  RUN_EXIT_PROVIDER_PROBE_FAILED,
  RUN_EXIT_USAGE,
  RUN_EXIT_WORKSPACE_UNAVAILABLE,
  SESSION_ID_PATTERN,
} from '../../../packages/host/src/run-cli.js';
import { defaultSessionsRoot } from '../../../packages/host/src/sessions-cli.js';
import { bootScreen } from '../../../packages/tui/src/screen.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import type { Terminal } from '../../../packages/tui/src/tui-boundary.js';
import { ProcessTerminal } from '../../../packages/tui/src/tui-boundary.js';
import {
  attachSession,
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { bootSoloLane } from '../../../packages/worker/src/lane/solo.js';
import {
  ModelSelectError,
  selectModel,
} from '../../../packages/worker/src/model-select.js';
import { BACKGROUND_CONTEXT } from '../../../packages/worker/src/pi-boundary.js';

export interface TuiLaneBoot {
  sessionId: string;
  model: string;
  close?: () => Promise<void> | void;
}

export interface TuiRunDeps {
  out: (line: string) => void;
  createTerminal: () => Terminal;
  bootLane: (sessionId?: string) => Promise<TuiLaneBoot>;
}

// Prod solo boot: same session/model setup as the headless runner
// (create-or-attach, journal dir, assembled models, default select,
// lane boot) minus the prompt accept/drive — the interactive loop
// drives the lane after this slice lands the screen + input routing.
export async function bootTuiLane(sessionId?: string): Promise<TuiLaneBoot> {
  // Defense-in-depth with runTuiCommand's --session check: direct
  // callers bypass the CLI, so reject path-unsafe ids here before any
  // store attach or path join can see them (mirrors headless-run.ts).
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
  }
  const root = defaultSessionsRoot();
  const context = BACKGROUND_CONTEXT;
  const bridge = createNodeFileBridge(root);
  const store = openSessionStore(root, bridge);
  const session =
    sessionId === undefined
      ? await createSession(store, process.cwd(), context)
      : await attachSession(store, sessionId, context);
  const id = session.metadata.id;
  const close = async (): Promise<void> => {
    try {
      await session.close(context);
    } catch {
      // The mapped result stands — close failures never escape.
    }
  };
  try {
    bridge.createDir(join(id, 'journal'));
    const assembled = assembleModels(process.cwd());
    const model = selectModel(assembled.models);
    const env = new NodeExecutionEnv(process.cwd());
    await bootSoloLane({
      session,
      models: assembled.models,
      model,
      env,
      sessionId: id,
      agentId: 'root',
      journal: new FileJournalStore(join(root, id, 'journal')),
    });
    return { sessionId: id, model: `${model.provider}/${model.id}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function tuiDepsWithDefaults(provided: {
  out: (line: string) => void;
}): TuiRunDeps {
  return {
    ...provided,
    createTerminal: () => new ProcessTerminal(),
    bootLane: (sessionId?: string) => bootTuiLane(sessionId),
  };
}

export async function runTuiCommand(
  args: string[],
  deps: TuiRunDeps,
): Promise<number> {
  let sessionId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--help' || arg === '-h') {
      deps.out('usage: kubic tui [--session <id>]');
      return RUN_EXIT_OK;
    }
    if (arg === '--session') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        deps.out('error: --session needs a value');
        return RUN_EXIT_USAGE;
      }
      sessionId = value;
      i += 1;
    } else {
      deps.out(`error: unknown flag ${arg}`);
      return RUN_EXIT_USAGE;
    }
  }
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) {
    deps.out(
      `error: invalid --session id ${JSON.stringify(sessionId)} (use [A-Za-z0-9_-])`,
    );
    return RUN_EXIT_USAGE;
  }
  let boot: TuiLaneBoot;
  try {
    boot = await deps.bootLane(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.out(`error: ${message}`);
    if (error instanceof ModelSelectError)
      return RUN_EXIT_PROVIDER_PROBE_FAILED;
    return mapCaughtErrorToTerminus(error) === 'workspace_unavailable'
      ? RUN_EXIT_WORKSPACE_UNAVAILABLE
      : RUN_EXIT_FAILED;
  }
  const app = createTuiApp({ sessionId: boot.sessionId, model: boot.model });
  const terminal = deps.createTerminal();
  const screen = bootScreen(terminal, app.root);
  screen.tui.setFocus(app.tree);
  screen.render();
  let stopped = false;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const onSigint = (): void => {
    shutdown();
  };
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    process.removeListener('SIGINT', onSigint);
    screen.stop((line: string) => deps.out(line));
    void (async () => {
      try {
        await boot.close?.();
      } catch {
        // Close failures never mask the clean quit.
      }
      resolveExit();
    })();
  };
  process.once('SIGINT', onSigint);
  screen.tui.addInputListener((data: string) => {
    const routed = app.handleInput(data);
    if (routed.quit) {
      shutdown();
      return { consume: true };
    }
    return routed.consumed ? { consume: true } : undefined;
  });
  await exited;
  return RUN_EXIT_OK;
}
