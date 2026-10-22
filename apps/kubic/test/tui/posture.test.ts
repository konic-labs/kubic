// The TUI mode indicator on the real boot:
// the posture installPolicy installed is the single source of truth, so
// a full-access session can never render 'approvals on' (the header's
// posture).
//
// Real code end to end: the prod bootTuiLane (re-rooted onto temp state), a
// recording fake Terminal under the real alt-screen, and the real policy.
// Faux provider only: zero network, zero paid tokens.
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '@kubic/agent/pi-boundary';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { enableFullAccess, FileApprovalStore } from '@kubic/host/approvals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { tempDir } from '../../../../test/temp-dir.js';
import { bootTuiLane } from '../../src/tui/boot.js';
import type { TuiRunDeps } from '../../src/tui/options.js';
import { runTuiCommand } from '../../src/tui/run.js';

const WARNING = 'approvals OFF (full-access)';

beforeEach(() => {
  vi.stubEnv('KUBIC_PROVIDER', undefined);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function recordingTerminal() {
  return terminalRig(120, 30);
}

function prodBoot(
  sessionsRoot: string,
  workspace: string,
): TuiRunDeps['bootLane'] {
  return (sessionId, answer) => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage('done')]);
    const models = createModels();
    models.setProvider(faux.provider);
    return bootTuiLane(sessionId, {
      sessionsRoot,
      models,
      env: new FakeExecutionEnv({}),
      skills: { homeDir: workspace, cwd: workspace, trusted: false },
      ...(answer === undefined ? {} : { answer }),
    });
  };
}

// The first frame the alt-screen writes (boot render happens before input).
async function firstFrame(
  sessionsRoot: string,
  workspace: string,
  session?: string,
): Promise<string> {
  const fake = recordingTerminal();
  const exit = runTuiCommand(session === undefined ? {} : { session }, {
    out: () => {},
    createTerminal: () => fake.terminal,
    colorLevel: 'none',
    bootLane: prodBoot(sessionsRoot, workspace),
  });
  for (let i = 0; i < 500 && fake.counts.started === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const frame = fake.writes.join('');
  fake.feed('\x04');
  expect((await exit).exitCode).toBe(0);
  return frame;
}

describe('the TUI indicator follows the installed posture', () => {
  it('a full-access session renders the OFF warning in its first frame', async () => {
    const sessionsRoot = tempDir('tui-posture-');
    const workspace = tempDir('tui-posture-');
    const created = await prodBoot(sessionsRoot, workspace)();
    await created.close?.();
    enableFullAccess(
      new FileApprovalStore(join(sessionsRoot, created.sessionId)),
      'test',
    );
    const frame = await firstFrame(sessionsRoot, workspace, created.sessionId);
    expect(frame).toContain(WARNING);
    expect(frame).not.toContain('approvals on');
  });

  it("a fresh session renders 'approvals on'", async () => {
    const frame = await firstFrame(
      tempDir('tui-posture-'),
      tempDir('tui-posture-'),
    );
    expect(frame).toContain('approvals on');
    expect(frame).not.toContain(WARNING);
  });

  it('the boot reports the same predicate the installed ask auto-approves on', async () => {
    const sessionsRoot = tempDir('tui-posture-');
    const workspace = tempDir('tui-posture-');
    const boot = await prodBoot(sessionsRoot, workspace)();
    expect(boot.approvalsSkipped?.()).toBe(false);
    enableFullAccess(
      new FileApprovalStore(join(sessionsRoot, boot.sessionId)),
      'test',
    );
    // The posture is decided at boot, so a mid-session write
    // never flips the indicator — the ask consults the same boot posture.
    expect(boot.approvalsSkipped?.()).toBe(false);
    await boot.close?.();
    // The close's settle restored the boot posture the mid-session write
    // replaced, so the next run boots enforced too.
    expect(
      new FileApprovalStore(join(sessionsRoot, boot.sessionId)).loadPosture()
        .fullAccess,
    ).toBe(false);
  });
});
