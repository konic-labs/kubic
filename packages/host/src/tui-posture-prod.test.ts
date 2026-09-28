// The TUI mode indicator on the real boot (issue #307; §17, §18, §41.4):
// the posture installSoloPolicy installed is the single source of truth, so
// a full-access session can never render 'approvals:on'.
//
// Real code end to end: the prod bootTuiLane (re-rooted onto temp state), a
// recording fake Terminal under the real alt-screen, and the real policy.
// Faux provider only: zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../worker/src/pi-boundary.js';
import { enableFullAccess, FileApprovalStore } from './approvals.js';

const WARNING = '! warning: approvals OFF (full-access)';
const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-posture-'));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_PROVIDER', undefined);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function recordingTerminal() {
  const writes: string[] = [];
  const counts = { started: 0 };
  let handler: ((data: string) => void) | undefined;
  return {
    writes,
    counts,
    feed: (data: string) => handler?.(data),
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        handler = input;
      },
      stop: () => {},
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return 120;
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
    bootLane: prodBoot(sessionsRoot, workspace),
  });
  for (let i = 0; i < 500 && fake.counts.started === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const frame = fake.writes.join('');
  fake.feed('\x1b');
  expect(await exit).toBe(0);
  return frame;
}

describe('the TUI indicator follows the installed posture (issue #307)', () => {
  it('a full-access session renders the OFF warning in its first frame', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot();
    const created = await prodBoot(sessionsRoot, workspace)();
    await created.close?.();
    enableFullAccess(
      new FileApprovalStore(join(sessionsRoot, created.sessionId)),
      'test',
    );
    const frame = await firstFrame(sessionsRoot, workspace, created.sessionId);
    expect(frame).toContain(WARNING);
    expect(frame).not.toContain('approvals:on');
  });

  it("a fresh session renders 'approvals:on'", async () => {
    const frame = await firstFrame(tmpRoot(), tmpRoot());
    expect(frame).toContain('approvals:on');
    expect(frame).not.toContain(WARNING);
  });

  it('the boot reports the same predicate the installed ask auto-approves on', async () => {
    const sessionsRoot = tmpRoot();
    const workspace = tmpRoot();
    const boot = await prodBoot(sessionsRoot, workspace)();
    expect(boot.approvalsSkipped?.()).toBe(false);
    enableFullAccess(
      new FileApprovalStore(join(sessionsRoot, boot.sessionId)),
      'test',
    );
    // Same store the policy's ask reads per call: no drift after a change.
    expect(boot.approvalsSkipped?.()).toBe(true);
    await boot.close?.();
  });
});
