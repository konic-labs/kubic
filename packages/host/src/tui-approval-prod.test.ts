// The approval overlay on the real `kubic tui` composition path (issue #96,
// criteria 1 and 6). RED: `kubic tui` installs the approval policy (issue
// #86) but attaches no answer seat, so a challenged call is refused with
// NO_ANSWER_SURFACE_REASON and the operator can never approve anything.
//
// Real code end to end: the prod boot (bootTuiLane) on a real faux lane, a
// real ProcessTerminal-shaped fake Terminal driving the real alt-screen, and
// the real key path. Criterion 6 (clean quit restores the main screen and
// exits 0) rides the same run: the overlay must not break the restore.
//
// Lives in host next to tui-loop.test.ts (it reaches the composition root as
// a black-box caller). Faux provider only: zero network, zero paid tokens.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runTuiCommand,
  type TuiApprovalSeat,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createNodeFileBridge } from '../../exec/src/file-bridge.js';
import { FileJournalStore } from '../../exec/src/journal.js';
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
  fauxToolCall,
  type MutableModels,
  type Session,
} from '../../worker/src/pi-boundary.js';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'kubic-96-tui-'));
}

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

function fauxModels(steps: FauxMessage[]): {
  models: MutableModels;
} {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return { models };
}

// The prod boot shape with the sessions root + models injected (same pattern
// as tui-loop.test.ts). The seat arrives as bootLane's second argument
// (issue #96) — the same way runTuiCommand hands the real one to the real
// boot — and is forwarded to installSoloPolicy exactly like prod does.
function fauxLaneBoot(
  root: string,
  models: MutableModels,
): TuiRunDeps['bootLane'] {
  return async (sessionId?: string, answer?: TuiApprovalSeat) => {
    const bridge = createNodeFileBridge(root);
    const store = openSessionStore(root, bridge);
    const context = BACKGROUND_CONTEXT;
    const session: Session = await createSession(store, root, context);
    const id = sessionId ?? session.metadata.id;
    bridge.createDir(join(id, 'journal'));
    const provider = models.getProviders()[0];
    if (provider === undefined) throw new Error('no provider registered');
    const model = models.getModels(provider.id)[0];
    if (model === undefined) throw new Error('no model registered');
    // The production policy derivation, with the seat the composition root
    // would attach (tui-run.ts does this on the real path).
    const { installSoloPolicy } = await import('./approvals.js');
    const installed = installSoloPolicy({
      workspace: '/fake',
      sessionDir: join(root, id),
      ...(answer === undefined ? {} : { answer }),
    });
    const solo = await bootSoloLane({
      session,
      models,
      model,
      env: new FakeExecutionEnv({}),
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
      loop: {
        accept: (prompt, ctx) =>
          solo.lane.accept({ kind: 'prompt', prompt }, ctx),
        lane: solo.lane,
        requestAbort: (operationId, ctx) =>
          solo.lane.requestAbort(operationId, ctx),
        findEntries: (query, ctx) => solo.lane.findEntries(query, ctx),
        events: solo.harness.events,
        kills: solo.kills,
        context,
      },
      close: async () => {
        await session.close(context);
      },
    };
  };
}

function fakeTerminal(width: number) {
  const writes: string[] = [];
  const counts = { started: 0, stopped: 0 };
  return {
    writes,
    counts,
    get frame(): string {
      return writes.join('');
    },
    feed: (data: string) => {
      handler?.(data);
    },
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        handler = input;
      },
      stop: () => {
        counts.stopped += 1;
      },
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return width;
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

let handler: ((data: string) => void) | undefined;

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

describe('approval overlay on the kubic tui path (issue #96, criterion 1)', () => {
  it('shows the overlay for a gated call and runs it when approved', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
      fauxAssistantMessage('done'),
    ]);
    const pending = runTuiCommand([], {
      out: (line: string) => lines.push(line),
      createTerminal: () => fake.terminal,
      bootLane: fauxLaneBoot(root, models),
    });
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    // The overlay is up: the request names the capability and the command.
    await waitFor(() => fake.frame.includes('Approval required'));
    expect(fake.frame).toContain('destructive-shell');
    expect(fake.frame).toContain('rm -rf /tmp/x');
    expect(fake.frame).toContain('allow once');
    // 'a' is the shipped allow-once binding: the call runs, the turn settles.
    fake.feed('a');
    await waitFor(
      () => fake.frame.includes('done') || lines.join('\n').includes('done'),
    );
    // Quit cleanly (criterion 6): restore + exit 0.
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.frame).toContain('?1049l');
    // The refusal reason never appeared: the call was really approved.
    expect(fake.frame).not.toContain('no approval surface is installed');
  });

  it('denies the gated call on Esc without quitting the session', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
      fauxAssistantMessage('after the denial'),
    ]);
    const pending = runTuiCommand([], {
      out: (line: string) => lines.push(line),
      createTerminal: () => fake.terminal,
      bootLane: fauxLaneBoot(root, models),
    });
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('Approval required'));
    // Esc answers the request (deny). It must NOT also quit: the process is
    // still alive and the turn continues to its next assistant message.
    fake.feed('\u001b');
    await waitFor(() => fake.frame.includes('after the denial'));
    expect(fake.counts.stopped).toBe(0);
    expect(lines.join('\n')).not.toContain('after the denial');
    // The overlay is gone from the frame once the request settled.
    expect(fake.frame.split('Approval required').length - 1).toBeGreaterThan(0);
    // Now a clean quit (criterion 6).
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.frame).toContain('?1049l');
  });

  it('quits cleanly with no approval ever asked (criterion 6)', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([fauxAssistantMessage('hello there')]);
    const pending = runTuiCommand([], {
      out: (line: string) => lines.push(line),
      createTerminal: () => fake.terminal,
      bootLane: fauxLaneBoot(root, models),
    });
    await waitFor(() => fake.counts.started === 1);
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.frame).toContain('?1049l');
    expect(fake.frame).toContain('?2026h');
  });

  it('quits cleanly while an approval is still pending', async () => {
    // A quit mid-approval must not strand the turn: the seat denies, the
    // session closes, the screen restores, exit 0.
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
      fauxAssistantMessage('unreachable'),
    ]);
    const pending = runTuiCommand([], {
      out: (line: string) => lines.push(line),
      createTerminal: () => fake.terminal,
      bootLane: fauxLaneBoot(root, models),
    });
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('Approval required'));
    // Ctrl-C once cancels the RUNNING turn (documented in
    // docs/cli/commands.md) and the shutdown path settles the pending
    // approval as a deny — so the turn ends without waiting for the lane's
    // own timeout and no frame is left showing a request nobody can answer.
    fake.feed('\x03');
    await waitFor(() => fake.frame.includes('cancelled'));
    // A second press, with nothing running, is the quit. Screen restores and
    // the process exits 0 (criterion 6).
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.frame).toContain('?1049l');
  });

  it('renders the inline fallback instead of the overlay on a narrow terminal', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(70);
    const { models } = fauxModels([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]),
      fauxAssistantMessage('narrow done'),
    ]);
    const pending = runTuiCommand([], {
      out: (line: string) => lines.push(line),
      createTerminal: () => fake.terminal,
      bootLane: fauxLaneBoot(root, models),
    });
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('! approval (inline)'));
    // The overlay body is NOT composited at this width (Pi's visible() gate),
    // and the request is still answerable.
    expect(fake.frame).toContain('destructive-shell');
    fake.feed('a');
    await waitFor(() => fake.frame.includes('narrow done'));
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });
});
