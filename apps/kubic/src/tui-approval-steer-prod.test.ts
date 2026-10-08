// Steering an approval on the real `kubic tui` composition path — adapted from
// tui-approval-prod.test.ts. Before `kubic tui` installed the approval policy
// but attached no answer seat, so a challenged call was refused with
// NO_ANSWER_SURFACE_REASON and the operator could never approve anything.
//
// Real code end to end: the prod boot (bootTuiLane) on a real faux lane, a
// real ProcessTerminal-shaped fake Terminal driving the real alt-screen, and
// the real key path. Criterion 6 (clean quit restores the main screen and
// exits 0) rides the same run: the card must not break the restore.
//
// Lives in host next to tui-loop.test.ts (it reaches the composition root as
// a black-box caller). Faux provider only: zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import { FileJournalStore } from '../../../packages/exec/src/journal.js';
import {
  createSession,
  openSessionStore,
} from '../../../packages/worker/src/lane/session-store.js';
import { bootSoloLane } from '../../../packages/worker/src/lane/solo.js';
import { fauxToolUse } from '../../../packages/worker/src/lane/test-harness.js';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import {
  runTuiCommand,
  soloTuiLoop,
  type TuiApprovalSeat,
  type TuiRunDeps,
} from './tui-run.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-96-tui-'));
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
// tui-loop.test.ts). The seat arrives as bootLane's second argument — the same
// way runTuiCommand hands the real one to the real boot — and is forwarded to
// installSoloPolicy exactly like prod does.
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
    // would attach (tui-run.ts does this on the real path).
    const { installSoloPolicy } = await import(
      '../../../packages/host/src/approvals.js'
    );
    const installed = installSoloPolicy({
      workspace: '/fake',
      sessionDir: join(root, id),
      ...(answer === undefined ? {} : { answer }),
    });
    const solo = await bootSoloLane({
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
      loop: soloTuiLoop(solo),
      close: async () => {
        await solo.close(context);
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
