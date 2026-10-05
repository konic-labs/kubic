// Live-input contracts of the `kubic tui` loop on the real alt-screen.
//
// Issue #274: Kubic's input listener consumes every key, and pi-tui skips its
// own post-input render for a consumed key — so while idle nothing repainted
// and typing, Ctrl-O/R/T/X and an approval decision stayed invisible.
// Issue #306: Kitty-class terminals send key-release events; the listener
// must see presses only, so a toggle does not cancel itself on key-up and a
// Ctrl-C cancel / an Esc deny never becomes a quit.
//
// One shared harness: a recording fake Terminal under the real bootScreen,
// with the real tui-run listener attached by runTuiCommand. Faux provider /
// fake execution env only: zero network, zero paid tokens.
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
  fauxText,
  fauxToolCall,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import {
  runTuiCommand,
  soloTuiLoop,
  type TuiApprovalSeat,
  type TuiRunDeps,
} from './tui-run.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-live-input-'));
  made.push(dir);
  return dir;
}

// The recording fake Terminal: every byte the alt-screen writes is kept, so
// a test can mark a point and read only the frames written after it.
function recordingTerminal(width = 100) {
  return terminalRig(width, 30);
}

// Bounded wait: a real timer tick per step (the alt-screen throttles frames
// to one per ~16 ms), `ticks` steps of 2 ms at most.
async function waitFor(condition: () => boolean, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

// "Within one render tick": the frame must land inside a few throttle
// intervals, never only after some unrelated later render.
const RENDER_TICK_STEPS = 25;

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;
type FauxStep =
  | Parameters<typeof fauxAssistantMessage>[0]
  | (() => Promise<FauxMessage>);

function fauxLaneBoot(
  root: string,
  steps: FauxStep[],
  env = new FakeExecutionEnv({}),
): TuiRunDeps['bootLane'] {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    steps.map((step) => {
      if (typeof step === 'function') return step;
      // A message carrying a tool call must say so (pi-durable dispatches
      // the calls of a `toolUse` turn; 0.87 inferred them from the parts).
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
  return async () => {
    const bridge = createNodeFileBridge(root);
    const store = openSessionStore(root, bridge);
    const context = BACKGROUND_CONTEXT;
    const session = await createSession(store, { cwd: root }, context);
    const id = session.id;
    bridge.createDir(join(id, 'journal'));
    const provider = models.getProviders()[0];
    if (provider === undefined) throw new Error('no provider registered');
    const model = models.getModels(provider.id)[0];
    if (model === undefined) throw new Error('no model registered');
    const solo = await bootSoloLane({
      session,
      models,
      model,
      env,
      sessionId: id,
      agentId: 'root',
      journal: new FileJournalStore(join(root, id, 'journal')),
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

// The viewer shell (no lane loop): nothing is ever busy, so no spinner or
// turn refresh can paint a frame on the key's behalf.
function viewerBoot(capture?: (seat: TuiApprovalSeat) => void) {
  const bootLane: TuiRunDeps['bootLane'] = async (_id, answer) => {
    if (answer !== undefined) capture?.(answer);
    return { sessionId: 'live-input', model: 'faux/viewer' };
  };
  return bootLane;
}

async function startTui(bootLane: TuiRunDeps['bootLane']) {
  const fake = recordingTerminal();
  const lines: string[] = [];
  const exit = runTuiCommand(
    {},
    {
      out: (line: string) => lines.push(line),
      createTerminal: () => fake.terminal,
      colorLevel: 'none',
      approvalArmingMs: 0,
      bootLane,
    },
  );
  await waitFor(() => fake.counts.started === 1);
  // Let the boot frame settle so a mark is taken after it.
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { fake, lines, exit };
}

describe('idle input repaints (issue #274)', () => {
  it('a typed key while idle is on screen within one render tick', async () => {
    const { fake, exit } = await startTui(viewerBoot());
    const mark = fake.mark();
    fake.feed('a');
    await waitFor(() => fake.since(mark).includes('a'), RENDER_TICK_STEPS);
    // Issue #302: the draft is on screen, so the first Ctrl-C only clears
    // it; the second press quits.
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });

  it("Ctrl-O while idle paints the diff panel's 'no changes' row", async () => {
    const { fake, exit } = await startTui(viewerBoot());
    const mark = fake.mark();
    fake.feed('\x0f');
    await waitFor(
      () => fake.since(mark).includes('no changes'),
      RENDER_TICK_STEPS,
    );
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  it('Ctrl-R while idle paints the journal panel', async () => {
    const { fake, exit } = await startTui(viewerBoot());
    const mark = fake.mark();
    fake.feed('\x12');
    await waitFor(
      () => fake.since(mark).includes('no changes'),
      RENDER_TICK_STEPS,
    );
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  it('Ctrl-T repaints the tree collapsed and Ctrl-X repaints the expanded output', async () => {
    const root = tmpRoot();
    const out = Array.from({ length: 9 }, (_, i) => `row-${i + 1}`).join('\n');
    const script = { exitCode: 0, stdout: `${out}\n`, stderr: '' };
    const env = new FakeExecutionEnv({
      'bash -c rows': script,
      'sh -c rows': script,
    });
    const { fake, exit } = await startTui(
      fauxLaneBoot(
        root,
        [
          [fauxText('listing'), fauxToolCall('bash', { command: 'rows' })],
          'listed',
        ],
        env,
      ),
    );
    for (const ch of 'go') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.since(0).includes('listed'));
    // The turn settled: the spinner is gone, so only the key can paint.
    await new Promise((resolve) => setTimeout(resolve, 150));
    let mark = fake.mark();
    fake.feed('\x14');
    await waitFor(
      () => fake.since(mark).includes('…1 call'),
      RENDER_TICK_STEPS,
    );
    mark = fake.mark();
    fake.feed('\x18');
    await waitFor(() => fake.since(mark).includes('row-9'), RENDER_TICK_STEPS);
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });

  it('an approval decision key while idle repaints with the overlay gone', async () => {
    let seat: TuiApprovalSeat | undefined;
    const { fake, exit } = await startTui(
      viewerBoot((captured) => {
        seat = captured;
      }),
    );
    if (seat === undefined) throw new Error('the seat was never handed over');
    const verdict = seat({
      key: 'bash:rm -rf /tmp/x',
      capability: 'destructive-shell',
      toolName: 'bash',
      summary: 'rm -rf /tmp/x',
    });
    await waitFor(() => fake.since(0).includes('Approval required'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const mark = fake.mark();
    fake.feed('a');
    await waitFor(() => fake.since(mark).length > 0, RENDER_TICK_STEPS);
    expect(fake.since(mark)).not.toContain('Approval required');
    expect(await verdict).toMatchObject({ approved: true });
    fake.feed('\x1b');
    expect(await exit).toBe(0);
  });
});

describe('Kitty key releases on the live loop (issue #306)', () => {
  it('a Ctrl-C release after a cancel press never quits the session', async () => {
    const root = tmpRoot();
    let release: () => void = () => {};
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fake, exit } = await startTui(
      fauxLaneBoot(root, [
        async () => {
          await gated;
          return fauxAssistantMessage('never delivered');
        },
      ]),
    );
    for (const ch of 'slow') fake.feed(ch);
    fake.feed('\r');
    fake.feed('\x1b[99;5u'); // press: cancel the turn
    fake.feed('\x1b[99;5:3u'); // release: must not count as the second Ctrl-C
    await waitFor(() => fake.since(0).includes('cancelling'));
    expect(fake.counts.stopped).toBe(0);
    release();
    await waitFor(() => fake.since(0).includes('cancelled'));
    expect(fake.counts.stopped).toBe(0);
    fake.feed('\x1b[27u');
    fake.feed('\x1b[27;1:3u');
    expect(await exit).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });
});
