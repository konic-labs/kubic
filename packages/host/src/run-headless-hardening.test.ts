// Headless hardening (issue #28, review cycle 2): defense-in-depth
// --session validation inside runHeadlessPrompt, close-guard in the
// finally, and explicit malformed-outcome mapping. The lane and session
// store are mocked at the seam (file-local: vitest isolates modules per
// test file); persistence still hits a real tmp sessions root. Faux
// models only: zero network.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import { createSession } from '../../worker/src/lane/session-store.js';
import {
  bootSoloLane,
  driveToSettled,
  type SoloLane,
} from '../../worker/src/lane/solo.js';
import {
  type AgentLane,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { mapTerminusToExitCode } from './run-cli.js';

const mockState = vi.hoisted(() => ({ closeShouldReject: false }));

vi.mock('../../worker/src/lane/session-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../worker/src/lane/session-store.js')
    >();
  return {
    ...actual,
    createSession: vi.fn((...args: Parameters<typeof actual.createSession>) =>
      actual.createSession(...args).then(wrapClose),
    ),
    attachSession: vi.fn((...args: Parameters<typeof actual.attachSession>) =>
      actual.attachSession(...args).then(wrapClose),
    ),
  };

  async function wrapClose(
    session: Awaited<ReturnType<typeof actual.createSession>>,
  ) {
    if (mockState.closeShouldReject) {
      session.close = async () => {
        throw new Error('close blew up');
      };
    }
    return session;
  }
});

vi.mock('../../worker/src/lane/solo.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../worker/src/lane/solo.js')>();
  return {
    ...actual,
    bootSoloLane: vi.fn(),
    driveToSettled: vi.fn(),
  };
});

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'run-headless-hardening-'));
}

function fauxModels(texts: string[]): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  return models;
}

function fakeLane(): AgentLane {
  return {
    accept: async () => ({
      ok: true as const,
      value: { operationId: 'op-1', kind: 'run' as const, startedAt: 0 },
    }),
    findEntries: async () => [],
  } as unknown as AgentLane;
}

function deps() {
  return {
    sessionsRoot: tmpRoot(),
    models: fauxModels(['unused']),
    env: new FakeExecutionEnv({}),
  };
}

beforeEach(() => {
  mockState.closeShouldReject = false;
  vi.mocked(bootSoloLane).mockResolvedValue({
    lane: fakeLane(),
  } as unknown as SoloLane);
  vi.mocked(driveToSettled).mockResolvedValue({
    kind: 'settled' as const,
    outcome: { status: 'completed' },
  });
});

describe('headless hardening (issue #28, review cycle 2)', () => {
  it('rejects a hostile session id inside runHeadlessPrompt with exit 2', async () => {
    const result = await runHeadlessPrompt(
      'hello',
      { sessionId: '../evil' },
      deps(),
    );
    expect(result.terminus).toBe('usage');
    expect(mapTerminusToExitCode(result.terminus)).toBe(2);
    expect(result.sessionId).toBe('unassigned');
    expect(vi.mocked(createSession)).not.toHaveBeenCalled();
    expect(vi.mocked(bootSoloLane)).not.toHaveBeenCalled();
    expect(vi.mocked(driveToSettled)).not.toHaveBeenCalled();
  });

  it('keeps the mapped result when session close rejects', async () => {
    mockState.closeShouldReject = true;
    const result = await runHeadlessPrompt('do it', {}, deps());
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('do it');
  });

  it('maps malformed lane outcomes to failed explicitly instead of throwing', async () => {
    const malformed: unknown[] = [
      null,
      { status: 'bogus' },
      { status: 'failed', error: { code: 42, message: 'x' } },
    ];
    for (const outcome of malformed) {
      vi.mocked(driveToSettled).mockResolvedValue({
        kind: 'settled' as const,
        outcome,
      });
      const result = await runHeadlessPrompt('do it', {}, deps());
      expect(result.terminus).toBe('failed');
      expect(result.error?.message).toMatch(/malformed outcome/);
    }
  });

  it('still maps a well-formed lane failure without the malformed message', async () => {
    vi.mocked(driveToSettled).mockResolvedValue({
      kind: 'settled' as const,
      outcome: {
        status: 'failed',
        error: { code: 'tool_failed', message: 'exit 1' },
      },
    });
    const result = await runHeadlessPrompt('do it', {}, deps());
    expect(result.terminus).toBe('failed');
    expect(result.error?.message).not.toMatch(/malformed outcome/);
  });
});
