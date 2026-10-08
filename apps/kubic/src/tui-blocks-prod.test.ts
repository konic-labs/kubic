// Block mode's copy on the real `kubic tui` path: after a real
// faux turn, Esc then `y` writes the answer to the clipboard as OSC 52 on
// the screen's terminal — through tmux's passthrough inside tmux — and a
// terminal known to drop it gets the honest notice instead.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import {
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { bootSoloLane } from '../../../packages/worker/src/lane/solo.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { runTuiCommand, soloTuiLoop, type TuiRunDeps } from './tui-run.js';

const made: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

function boot(answer: string): TuiRunDeps['bootLane'] {
  const root = mkdtempSync(join(tmpdir(), 'tui-blocks-'));
  made.push(root);
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage(answer)]);
  return async () => {
    const bridge = createNodeFileBridge(root);
    const session = await createSession(
      openSessionStore(root, bridge),
      { cwd: root },
      BACKGROUND_CONTEXT,
    );
    bridge.createDir(join(session.id, 'journal'));
    const provider = models.getProviders()[0];
    const model =
      provider === undefined ? undefined : models.getModels(provider.id)[0];
    if (provider === undefined || model === undefined)
      throw new Error('no model');
    const solo = await bootSoloLane({
      session,
      models,
      model,
      env: new FakeExecutionEnv({}),
      sessionId: session.id,
      agentId: 'root',
      journal: new FileJournalStore(join(root, session.id, 'journal')),
    });
    return {
      sessionId: session.id,
      model: `${provider.id}/${model.id}`,
      loop: soloTuiLoop(solo),
      close: async () => {
        await solo.close(BACKGROUND_CONTEXT);
        await session.release(BACKGROUND_CONTEXT);
      },
    };
  };
}

async function copyAnswer(): Promise<{ written: string; frame: string }> {
  const fake = terminalRig(120, 30);
  const pending = runTuiCommand(
    {},
    {
      out: () => {},
      createTerminal: () => fake.terminal,
      colorLevel: 'none',
      bootLane: boot('all done'),
    },
  );
  await waitFor(() => fake.counts.started === 1);
  for (const ch of 'say done') fake.feed(ch);
  fake.feed('\r');
  await waitFor(() => fake.frame.includes('all done'));
  const mark = fake.mark();
  // The turn's receipt is the last block; the answer is the one above.
  fake.feed('\u001b');
  fake.feed('k');
  fake.feed('y');
  await waitFor(() => fake.since(mark).includes('cop'));
  const written = fake.since(mark);
  fake.feed('\u0004');
  expect((await pending).exitCode).toBe(0);
  return { written, frame: fake.frame };
}

const ANSWER = Buffer.from('all done', 'utf8').toString('base64');

describe('block mode copies on kubic tui', () => {
  it('writes OSC 52 to the terminal', async () => {
    vi.stubEnv('TMUX', '');
    vi.stubEnv('TERM_PROGRAM', 'iTerm.app');
    const { written } = await copyAnswer();
    expect(written).toContain(`\u001b]52;c;${ANSWER}\u0007`);
    expect(written).toContain('copied 8 B');
  });

  it('rides tmux passthrough inside tmux', async () => {
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,1,0');
    vi.stubEnv('TERM_PROGRAM', 'tmux');
    const { written } = await copyAnswer();
    expect(written).toContain(
      `\u001bPtmux;\u001b\u001b]52;c;${ANSWER}\u0007\u001b\\`,
    );
  });

  it('says so where the terminal drops it', async () => {
    vi.stubEnv('TMUX', '');
    vi.stubEnv('TERM_PROGRAM', 'Apple_Terminal');
    const { written } = await copyAnswer();
    expect(written).not.toContain('\u001b]52;');
    expect(written).toContain('does not take clipboard writes');
  });
});
