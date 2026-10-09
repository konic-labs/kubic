// Steering an approval on the real `kubic tui` path: the operator answers a
// challenged call with an edited command, and the lane runs the edit. Real
// code end to end, as in tui/approval.test.ts: the prod boot on a faux lane, a
// fake terminal driving the real alt-screen, and the real key path; a clean
// quit still restores the main screen. Faux provider only: zero network, zero
// paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootLane } from '@kubic/agent/lane/boot';
import {
  createSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { FileJournalStore } from '@kubic/exec/journal';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { tuiLoop } from '../../src/tui/lane-loop.js';
import type { TuiRunDeps } from '../../src/tui/options.js';
import { runTuiCommand } from '../../src/tui/run.js';
import type { TuiApprovalSeat } from '../../src/tui/types.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-tui-approval-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

// A message carrying a tool call must say so: pi-durable dispatches the calls
// of a `toolUse` turn.
function toolUse(message: FauxMessage): FauxMessage {
  const hasCall = message.content.some((part) => part.type === 'toolCall');
  return hasCall ? fauxToolUse(message.content) : message;
}

function fauxModels(steps: FauxMessage[]): {
  models: MutableModels;
} {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps.map(toolUse));
  return { models };
}

// The prod boot shape with the sessions root + models injected (same pattern as
// tui/prompt-loop.test.ts). The seat arrives as bootLane's second argument — the same
// way runTuiCommand hands the real one to the real boot — and is forwarded to
// installPolicy exactly like prod does.
function fauxLaneBoot(
  root: string,
  models: MutableModels,
  env: FakeExecutionEnv,
): TuiRunDeps['bootLane'] {
  return async (sessionId?: string, answer?: TuiApprovalSeat) => {
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
    // The production policy derivation, with the seat the composition root
    // would attach (the TUI command does this on the real path).
    const { installPolicy } = await import('@kubic/host/approvals');
    const installed = installPolicy({
      workspace: '/fake',
      sessionDir: join(root, id),
      ...(answer === undefined ? {} : { answer }),
    });
    const lane = await bootLane({
      session,
      models,
      model,
      env,
      sessionId: id,
      agentId: 'root',
      journal: new FileJournalStore(join(root, id, 'journal')),
      policy: {
        classes: installed.classes,
        interceptors: installed.interceptors,
        contributions: installed.contributions,
      },
    });
    return {
      sessionId: id,
      model: `${provider.id}/${model.id}`,
      loop: tuiLoop(lane),
      close: async () => {
        await lane.close(context);
        await session.release(context);
      },
    };
  };
}

function fakeTerminal(width: number) {
  return terminalRig(width, 30);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

describe('steering an approval in the TUI', () => {
  it('`e` runs the edited command instead of the proposed one', async () => {
    const root = tmpRoot();
    const fake = fakeTerminal(110);
    const env = new FakeExecutionEnv({});
    const { models } = fauxModels([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf build/' }),
      ]),
      fauxAssistantMessage('cleaned'),
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        approvalArmingMs: 0,
        bootLane: fauxLaneBoot(root, models, env),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('edit command'));
    fake.feed('e');
    await waitFor(() => fake.frame.includes('edit the command ›'));
    fake.feed('\u0015');
    for (const ch of 'ls build/') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('cleaned'));
    expect(fake.frame).toContain('edited by the user — ran: ls build/');
    const ran = JSON.stringify(env.calls);
    expect(ran).toContain('ls build/');
    expect(ran).not.toContain('rm -rf build/');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
  });

  it('`c` denies with a comment the model reads', async () => {
    const root = tmpRoot();
    const fake = fakeTerminal(110);
    const env = new FakeExecutionEnv({});
    const { models } = fauxModels([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf build/' }),
      ]),
      fauxAssistantMessage('understood'),
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        approvalArmingMs: 0,
        bootLane: fauxLaneBoot(root, models, env),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('deny + comment'));
    fake.feed('c');
    await waitFor(() => fake.frame.includes('deny with a comment ›'));
    for (const ch of 'keep build') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('understood'));
    expect(fake.frame).toContain('denied by the user: keep build');
    expect(JSON.stringify(env.calls)).not.toContain('rm -rf build/');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
  });
});
