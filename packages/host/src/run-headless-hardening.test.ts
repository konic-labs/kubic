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

describe('headless composition root (issue #68; mutation hardening)', () => {
  it('fails a refused admission explicitly instead of driving', async () => {
    vi.mocked(bootSoloLane).mockResolvedValue({
      lane: {
        accept: async () => ({ ok: false as const, error: { message: 'no' } }),
        findEntries: async () => [],
      },
    } as unknown as SoloLane);
    const result = await runHeadlessPrompt('do it', {}, deps());
    expect(result.terminus).toBe('failed');
    expect(result.summary).toMatch(/lane refused the prompt/);
    expect(result.error?.message).toMatch(/lane refused the prompt/);
    expect(vi.mocked(driveToSettled)).not.toHaveBeenCalled();
  });

  it('maps a deferred wait to approval_timed_out without a TTY', async () => {
    vi.mocked(driveToSettled).mockResolvedValue({
      kind: 'waiting-deferred',
      operationId: 'op-1',
      deferred: {},
    } as Awaited<ReturnType<typeof driveToSettled>>);
    const result = await runHeadlessPrompt('do it', {}, deps());
    expect(result.terminus).toBe('approval_timed_out');
    expect(result.summary).toMatch(/cannot arrive without a TTY/);
    expect(mapTerminusToExitCode(result.terminus)).toBe(4);
  });

  it('names a detail-free lane failure instead of printing undefined', async () => {
    vi.mocked(driveToSettled).mockResolvedValue({
      kind: 'settled' as const,
      outcome: { status: 'failed' },
    });
    const result = await runHeadlessPrompt('do it', {}, deps());
    expect(result.terminus).toBe('failed');
    expect(result.summary).toBe('lane failed without detail');
    expect(result.error).toEqual({
      kind: 'failed',
      message: 'lane failed without detail',
    });
  });

  function textEntry(
    id: string,
    seq: number,
    role: string,
    text: string,
  ): Record<string, unknown> {
    return {
      id,
      seq,
      type: 'message',
      message: {
        role,
        content: [{ type: 'text', text }],
      },
    };
  }

  it('summarizes the latest assistant text trimmed to 500 columns', async () => {
    const long = `  ${'y'.repeat(600)}  `;
    const longer = { type: 'text', text: `  ${'z'.repeat(600)}  ` };
    const numeric = { type: 'text', text: 42 };
    vi.mocked(bootSoloLane).mockResolvedValue({
      lane: {
        accept: fakeLane().accept,
        findEntries: async () => [
          textEntry('e-user', 5, 'user', 'ignore me'),
          textEntry('e-ws', 3, 'assistant', '   '),
          textEntry('e-long', 2, 'assistant', long),
          {
            id: 'e-long2',
            seq: 2,
            type: 'message',
            message: { role: 'assistant', content: [numeric, longer] },
          },
          {
            id: 'e-bad',
            seq: 4,
            type: 'message',
            message: { role: 'assistant', content: 'nope' },
          },
          {
            id: 'e-sys',
            seq: 6,
            type: 'system',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'q'.repeat(600) }],
            },
          },
        ],
      },
    } as unknown as SoloLane);
    const result = await runHeadlessPrompt('do it', {}, deps());
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('z'.repeat(500));
  });

  it('falls back to the prompt when only whitespace assistant text exists', async () => {
    vi.mocked(bootSoloLane).mockResolvedValue({
      lane: {
        accept: fakeLane().accept,
        findEntries: async () => [textEntry('e-ws', 0, 'assistant', '   ')],
      },
    } as unknown as SoloLane);
    const result = await runHeadlessPrompt('do it', {}, deps());
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('do it');
  });

  it('runs without an injected env by defaulting to the node env', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'hi env',
      {},
      { sessionsRoot: root, models: fauxModels(['env ok']) },
    );
    expect(result.terminus).toBe('completed');
    // The mocked lane yields no assistant text, so the prompt fallback
    // proves the run completed through the default-env branch.
    expect(result.summary).toBe('hi env');
  });

  it('maps a store-creation failure to unassigned refs', async () => {
    vi.mocked(createSession).mockRejectedValueOnce(new Error('store blew up'));
    const result = await runHeadlessPrompt('do it', {}, deps());
    expect(result.terminus).toBe('failed');
    expect(result.sessionId).toBe('unassigned');
    expect(result.journalRef).toBe('journal:unassigned');
    expect(result.usageRef).toBe('usage:unassigned');
    expect(result.trajectoryRef).toBe('trajectory:unassigned');
    expect(result.summary).toBe('store blew up');
    expect(result.error).toEqual({
      kind: 'failed',
      message: 'store blew up',
    });
  });

  it('stringifies a non-Error store failure', async () => {
    vi.mocked(createSession).mockRejectedValueOnce('string store boom');
    const result = await runHeadlessPrompt('do it', {}, deps());
    expect(result.terminus).toBe('failed');
    expect(result.sessionId).toBe('unassigned');
    expect(result.summary).toBe('string store boom');
  });
});
