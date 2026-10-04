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
): Promise<{ id: string; submissionId: string }> {
  const store = openSessionStore(root, createNodeFileBridge(root));
  const session = await createSession(
    store,
    { cwd: '/work' },
    BACKGROUND_CONTEXT,
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  // The dead process's generation never answers: the durable work stays
  // unfinished, exactly what a crash leaves behind.
  faux.setResponses([() => new Promise(() => {})]);
  const solo = await bootSoloLane({
    session,
    models,
    model: faux.getModel(),
    env: new FakeExecutionEnv({}),
    sessionId: session.id,
    agentId: 'root',
  });
  const submission = await solo.conversation.submit(
    { type: 'input', content: 'crashed turn', requestId: 'crashed-turn' },
    BACKGROUND_CONTEXT,
  );
  writeFileSync(
    join(root, session.id, 'lock.json'),
    JSON.stringify({ pid: 424242, startedAt: Date.now() }),
  );
  return { id: session.id, submissionId: String(submission.id) };
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
  it('boot aborts the pending work, names it, and the loop takes a prompt', async () => {
    const root = tmpRoot();
    const { id, submissionId } = await crashAfterAccept(root);
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    }) as never);
    const boot = await bootTuiLane(id, {
      sessionsRoot: root,
      models: fauxModels(['must not run', 'fresh reply']),
      env: new FakeExecutionEnv({}),
    });
    try {
      // #396's notice: the durable work, the settlement and — for #147's
      // "this very prompt" rule — the interrupted prompt itself.
      expect(boot.pendingNotice).toContain(`submission ${submissionId}`);
      expect(boot.pendingNotice).toContain('aborted after an interrupted run');
      expect(boot.pendingNotice).toContain('interrupted prompt: crashed turn');
      const turn = await boot.loop?.runTurn('next prompt', {
        requestId: 'next-prompt',
        context: BACKGROUND_CONTEXT,
        whenBusy: 'reject',
      });
      expect(turn?.kind).toBe('completed');
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
          modelNotice: "model: session keeps its own model 'faux/a'",
        }),
      },
    );
    await waitFor(() => fake.started() === 1);
    expect(fake.writes.join('')).toContain(
      'pending operation op-1 (run, started x) aborted',
    );
    // Issue #148: the model reconciliation line shares the first footer.
    expect(fake.writes.join('')).toContain(
      "model: session keeps its own model 'faux/a'",
    );
    fake.feed('\x03');
    expect(await pending).toBe(0);
  });
});
