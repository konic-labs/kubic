// The approval card on the real `kubic tui` composition path. Before `kubic
// tui` installed the approval policy but attached no answer seat, so a
// challenged call was refused with NO_ANSWER_SURFACE_REASON and the operator
// could never approve anything.
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
import { terminalRig } from '../../../test/fake-terminal.js';
import { tuiLoop } from './tui/lane-loop.js';
import type { TuiRunDeps } from './tui/options.js';
import { runTuiCommand } from './tui/run.js';
import type { TuiApprovalSeat } from './tui/types.js';

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
// tui-loop.test.ts). The seat arrives as bootLane's second argument — the same
// way runTuiCommand hands the real one to the real boot — and is forwarded to
// installPolicy exactly like prod does.
function fauxLaneBoot(
  root: string,
  models: MutableModels,
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

describe('allow once is not a session approval', () => {
  it("two identical destructive calls answered with 'a' produce two asks", async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf build/' }),
      ]),
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf build/' }),
      ]),
      fauxAssistantMessage('both calls done'),
    ]);
    let asks = 0;
    const boot = fauxLaneBoot(root, models);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        // 's arming delay is pinned off for the latch test.
        approvalArmingMs: 0,
        bootLane: (sessionId, answer, flags) =>
          boot(
            sessionId,
            answer === undefined
              ? undefined
              : (request) => {
                  asks += 1;
                  return answer(request);
                },
            flags,
          ),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => asks === 1);
    await waitFor(() => fake.frame.includes('APPROVAL'));
    fake.feed('a');
    // The second identical call must ask again: 'a' approved ONE call.
    await waitFor(() => asks === 2);
    fake.feed('a');
    await waitFor(() => fake.frame.includes('both calls done'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(asks).toBe(2);
  });
});

describe('approval card on the kubic tui path', () => {
  it('shows the card for a gated call and runs it when approved', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf /tmp/x' }),
      ]),
      fauxAssistantMessage('approved turn done'),
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        approvalArmingMs: 0,
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    // The card is up: it names the capability and the command.
    await waitFor(() => fake.frame.includes('APPROVAL'));
    expect(fake.frame).toContain('▲ destructive');
    expect(fake.frame).toContain('rm -rf /tmp/x');
    expect(fake.frame).toContain('allow once');
    // 'a' is the shipped allow-once binding: the call runs, the turn settles.
    fake.feed('a');
    // (The main-screen `lines` document is only printed at quit, so the
    // live frame is the only place the settled turn can show up yet.)
    await waitFor(() => fake.frame.includes('approved turn done'));
    // The tree row opens on Ctrl-T.
    fake.feed('\x14');
    // Quit cleanly: restore + exit 0.
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.frame).toContain('?1049l');
    // The refusal reason never appeared: the call was really approved, and
    // the tree shows the bash call succeeded.
    expect(fake.frame).not.toContain('no approval surface is installed');
    expect(lines.join('\n')).toMatch(/✓ bash rm -rf \/tmp\/x \d+ms/);
  });

  it('denies the gated call on Esc without quitting the session', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf /tmp/x' }),
      ]),
      fauxAssistantMessage('after the denial'),
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        approvalArmingMs: 0,
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('APPROVAL'));
    // Esc answers the request (deny). It must NOT also quit: the process is
    // still alive and the turn continues to its next assistant message.
    fake.feed('\u001b');
    await waitFor(() => fake.frame.includes('after the denial'));
    // Still in the alt-screen: nothing was stopped or printed to the main
    // screen (that document is only written at quit).
    expect(fake.counts.stopped).toBe(0);
    expect(lines).toEqual([]);
    // Now a clean quit.
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.frame).toContain('?1049l');
    // The restored main screen carries the continued turn and no card
    // left behind for a request that already settled; the denied call
    // never ran successfully.
    const doc = lines.join('\n');
    expect(doc).toContain('after the denial');
    expect(doc).not.toContain('APPROVAL');
    expect(doc).not.toMatch(/✓ bash /);
  });

  it('quits cleanly with no approval ever asked', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const { models } = fauxModels([fauxAssistantMessage('hello there')]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        approvalArmingMs: 0,
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
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
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf /tmp/x' }),
      ]),
      fauxAssistantMessage('unreachable'),
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        approvalArmingMs: 0,
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('APPROVAL'));
    // Ctrl-C once cancels the RUNNING turn (documented in
    // docs/cli/commands.md) and the shutdown path settles the pending
    // approval as a deny — so the turn ends without waiting for the lane's
    // own timeout and no frame is left showing a request nobody can answer.
    fake.feed('\x03');
    await waitFor(() => fake.frame.includes('cancelled'));
    // Idle again: a double press is the quit. Screen restores
    // and the process exits 0.
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.frame).toContain('?1049l');
  });

  it('shows the card on a narrow terminal and stays answerable', async () => {
    const root = tmpRoot();
    const lines: string[] = [];
    const fake = fakeTerminal(70);
    const { models } = fauxModels([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf /tmp/x' }),
      ]),
      fauxAssistantMessage('narrow done'),
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: (line: string) => lines.push(line),
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        approvalArmingMs: 0,
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('APPROVAL'));
    // The card lives in the editor's slot, so a narrow terminal shows
    // it too (no overlay width gate), and the request is answerable.
    expect(fake.frame).toContain('▲ destructive');
    fake.feed('a');
    await waitFor(() => fake.frame.includes('narrow done'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(fake.counts.stopped).toBe(1);
  });

  // Type-ahead cannot approve. With the shipped arming delay on
  // an injected clock, an `a` typed 50 ms after the card appeared neither
  // answers the ask nor reaches the draft; the same key once armed does.
  it('ignores a decision key typed inside the arming window', async () => {
    const root = tmpRoot();
    const fake = fakeTerminal(100);
    let now = 0;
    const { models } = fauxModels([
      fauxAssistantMessage([
        fauxToolCall('bash', { command: 'rm -rf /tmp/x' }),
      ]),
      fauxAssistantMessage('armed turn done'),
    ]);
    const pending = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        approvalClock: () => now,
        bootLane: fauxLaneBoot(root, models),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'clean up') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('APPROVAL'));
    expect(fake.frame).toContain('keys unlock in a moment');
    now += 50;
    fake.feed('a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.frame).not.toContain('armed turn done');
    // The dropped `a` restarted the window for the longer quiet period
    // (APPROVAL_QUIET_MS = 1500): the 400 ms arming delay is not enough now,
    // and neither is the same key inside the repeat window (700 ms).
    now += 400;
    fake.feed('a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.frame).not.toContain('armed turn done');
    now += 1500;
    fake.feed('a');
    await waitFor(() => fake.frame.includes('armed turn done'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
  });

  // A padded 400-char command reaches the card whole — the
  // seat receives the full command derived from the same args the key
  // hashes, and the card shows it wrapped instead of a 120-char slice.
  it('delivers the full padded command to the card', async () => {
    const root = tmpRoot();
    const fake = fakeTerminal(100);
    const padded = `echo 'running formatter' ${'x'.repeat(360)}; rm -rf /tmp/x`;
    const { models } = fauxModels([
      fauxAssistantMessage([fauxToolCall('bash', { command: padded })]),
      fauxAssistantMessage('padded turn done'),
    ]);
    const seen: Array<{ command?: string; summary: string }> = [];
    const boot = fauxLaneBoot(root, models);
    const pending = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        approvalArmingMs: 0,
        bootLane: (sessionId, answer, flags) =>
          boot(
            sessionId,
            answer === undefined
              ? undefined
              : (request) => {
                  seen.push(request);
                  return answer(request);
                },
            flags,
          ),
      },
    );
    await waitFor(() => fake.counts.started === 1);
    for (const ch of 'pad') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.frame.includes('APPROVAL'));
    expect(seen[0]?.command).toBe(padded);
    expect(seen[0]?.summary).toMatch(/… \(\+\d+ chars\)$/);
    // The card pages the whole command (its tail past the summary's cut is
    // on screen), never the truncated summary.
    expect(fake.frame).toContain("$ echo 'running formatter'");
    expect(fake.frame).toContain('/tmp/x');
    expect(fake.frame).not.toMatch(/\(\+\d+ chars\)/);
    fake.feed('d');
    await waitFor(() => fake.frame.includes('padded turn done'));
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await pending).exitCode).toBe(0);
  });
});
