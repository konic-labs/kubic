// A real lane on the faux provider for the TUI tests: scripted steps (text,
// tool calls, waits) and the boot the TUI command runs over them.
import { join } from 'node:path';
import { bootLane, type Lane } from '@kubic/agent/lane/boot';
import {
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { FileJournalStore } from '@kubic/exec/journal';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { tuiLoop } from '../../src/tui/lane-loop.js';
import type { TuiRunDeps } from '../../src/tui/options.js';

export type FauxContent = Parameters<typeof fauxAssistantMessage>[0];

export type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

// A scripted response, or a factory that reads the request the harness
// built — the steer test asserts on the messages the model really saw.
export type FauxStep =
  | FauxContent
  | (() => Promise<FauxMessage>)
  | ((context: { messages: readonly unknown[] }) => FauxMessage);

export function fauxModels(steps: FauxStep[]): {
  models: MutableModels;
  setResponses: (next: FauxStep[]) => void;
  calls: () => number;
} {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const setResponses = (next: FauxStep[]): void => {
    faux.setResponses(
      next.map((step) => {
        if (typeof step === 'function') return step;
        // A message carrying a tool call must say so (pi-durable dispatches
        // the calls of a `toolUse` turn).
        const toolUse =
          Array.isArray(step) &&
          step.some(
            (part) =>
              typeof part === 'object' &&
              part !== null &&
              (part as { type?: unknown }).type === 'toolCall',
          );
        return toolUse ? fauxToolUse(step) : fauxAssistantMessage(step);
      }),
    );
  };
  setResponses(steps);
  return { models, setResponses, calls: () => faux.state.callCount };
}

// A real lane boot against a temp sessions root with the faux provider —
// the prod boot shape (bootTuiLane) with the sessions root and models
// injected, exactly like `runHeadlessPrompt` accepts its deps.
export function fauxLaneBoot(
  root: string,
  models: MutableModels,
  options: {
    // A smaller keep-recent window lets a test-sized context compact.
    compaction?: Parameters<typeof bootLane>[0]['compaction'];
    // Boot-time harness settings (retry off, so a scripted
    // provider error fails the turn deterministically).
    settings?: Parameters<typeof bootLane>[0]['settings'];
    // The booted lane, for tests that read its transcript (the /compact
    // acceptance counts pi.compaction entries).
    onBoot?: (lane: Lane) => void;
    // Hand the session journal to the TUI (its panels and the
    // turn receipt read it).
    exposeJournal?: boolean;
  } = {},
): TuiRunDeps['bootLane'] {
  return async (sessionId?: string) => {
    const bridge = createNodeFileBridge(root);
    const store = openSessionStore(root, bridge);
    const context = BACKGROUND_CONTEXT;
    const session = await createSession(store, { cwd: root }, context);
    const id = sessionId ?? session.id;
    bridge.createDir(join(id, 'journal'));
    const provider = models.getProviders()[0];
    if (provider === undefined) throw new Error('no provider registered');
    const model = models.getModels(provider.id)[0];
    if (model === undefined) throw new Error('no model registered');
    const journal = new FileJournalStore(join(root, id, 'journal'));
    const lane = await bootLane({
      session,
      models,
      model,
      env: new FakeExecutionEnv({}),
      sessionId: id,
      agentId: 'root',
      journal,
      ...(options.compaction === undefined
        ? {}
        : { compaction: options.compaction }),
      ...(options.settings === undefined ? {} : { settings: options.settings }),
    });
    options.onBoot?.(lane);
    return {
      sessionId: id,
      model: `${provider.id}/${model.id}`,
      ...(options.exposeJournal === true ? { journal } : {}),
      loop: tuiLoop(lane),
      close: async () => {
        await lane.close(context);
        await session.release(context);
      },
    };
  };
}
