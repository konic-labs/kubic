// `kubic tui --session` after a crash (issue #147; §21). The interactive
// boot durably aborts a turn a dead process left open (its approvals would
// need an overlay that is not on screen yet, and the operator is present to
// re-send) and names that outcome in the editor footer from the first
// render. Faux provider only; pid liveness is stubbed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import {
  createSession,
  openSessionStore,
} from '../../worker/src/lane/session-store.js';
import { bootSoloLane } from '../../worker/src/lane/solo.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';

const made: string[] = [];

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-tui-pending-'));
  made.push(dir);
  return dir;
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

async function crashAfterAccept(
  root: string,
): Promise<{ id: string; operationId: string }> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(store, '/work', BACKGROUND_CONTEXT);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('never')]);
  const solo = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env: new FakeExecutionEnv({}),
    sessionId: session.metadata.id,
    agentId: 'root',
  });
  const admission = await solo.lane.accept(
    { kind: 'prompt', prompt: 'crashed turn' },
    BACKGROUND_CONTEXT,
  );
  if (!admission.ok) throw new Error('accept failed');
  writeFileSync(
    join(root, session.metadata.id, 'lock.json'),
    JSON.stringify({ pid: 424242, startedAt: Date.now() }),
  );
  return { id: session.metadata.id, operationId: admission.value.operationId };
}

function fakeTerminal(): {
  terminal: ReturnType<TuiRunDeps['createTerminal']>;
  writes: string[];
  started: () => number;
  feed: (data: string) => void;
} {
  const writes: string[] = [];
  let started = 0;
  let handler: ((data: string) => void) | undefined;
  return {
    writes,
    started: () => started,
    feed: (data) => handler?.(data),
    terminal: {
      start: (input: (data: string) => void) => {
        started += 1;
        handler = input;
      },
      stop: () => {},
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return 240;
      },
      get rows(): number {
        return 30;
      },
      get kittyProtocolActive(): boolean {
        return false;
      },
      moveBy: () => {},
      hideCursor: () => {},
      showCursor: () => {},
      clearLine: () => {},
      clearFromCursor: () => {},
      clearScreen: () => {},
      setTitle: () => {},
      setProgress: () => {},
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('kubic tui --session after a crash (issue #147)', () => {
  it('boot aborts the pending op, names it, and the loop accepts a prompt', async () => {
    const root = tmpRoot();
    const { id, operationId } = await crashAfterAccept(root);
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }) as never);
    const boot = await bootTuiLane(id, {
      sessionsRoot: root,
      models: fauxModels(['must not run', 'fresh reply']),
      env: new FakeExecutionEnv({}),
    });
    try {
      expect(boot.pendingNotice).toMatch(
        new RegExp(
          `^pending operation ${operationId} \\(run, started .+\\) aborted after an interrupted run$`,
        ),
      );
      const admission = await boot.loop?.accept(
        'next prompt',
        BACKGROUND_CONTEXT,
      );
      expect(admission?.ok).toBe(true);
    } finally {
      await boot.close?.();
    }
  });

  it('shows the pending-op outcome in the footer from the first render', async () => {
    const fake = fakeTerminal();
    const pending = runTuiCommand(
      {},
      {
        out: () => undefined,
        createTerminal: () => fake.terminal,
        bootLane: async () => ({
          sessionId: 's1',
          model: 'faux/test',
          pendingNotice: 'pending operation op-1 (run, started x) aborted',
        }),
      },
    );
    await waitFor(() => fake.started() === 1);
    expect(fake.writes.join('')).toContain(
      'pending operation op-1 (run, started x) aborted',
    );
    fake.feed('\x03');
    expect(await pending).toBe(0);
  });
});
