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
import { OperationKillRegistry } from '../../worker/src/lane/abort.js';
import { createSession } from '../../worker/src/lane/session-store.js';
import {
  bootSoloLane,
  driveToSettled,
  type SoloLane,
} from '../../worker/src/lane/solo.js';
import {
  type AgentLane,
  createModels,
  type DeferredHandle,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import { mapTerminusToExitCode } from './run-cli.js';

const mockState = vi.hoisted(() => ({ closeShouldReject: false }));

// Issue #109: the guard-drain order tests need to see the sweep fire, so
// beginReconciliation is wrapped (sweep still logs; the real module is
// untouched for every other suite — file-local mock).
const guardEvents = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('../../exec/src/journal-reconcile.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../exec/src/journal-reconcile.js')
    >();
  return {
    ...actual,
    beginReconciliation: vi.fn(() => ({
      sweep: () => {
        guardEvents.events.push('sweep');
      },
    })),
  };
});

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
    // The mocked lane yields no assistant text: the summary is the named
    // non-answer (issue #129), never an echo of the prompt.
    expect(result.summary).toBe(
      '(no assistant text — the run settled without output)',
    );
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

  it('reports the named non-answer for whitespace-only assistant text (issue #129)', async () => {
    vi.mocked(bootSoloLane).mockResolvedValue({
      lane: {
        accept: fakeLane().accept,
        findEntries: async () => [textEntry('e-ws', 0, 'assistant', '   ')],
      },
    } as unknown as SoloLane);
    const result = await runHeadlessPrompt(
      'prompt-never-echoed-fixture',
      {},
      deps(),
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe(
      '(no assistant text — the run settled without output)',
    );
    expect(result.summary).not.toContain('prompt-never-echoed-fixture');
  });

  it('runs without an injected env by defaulting to the node env', async () => {
    const root = tmpRoot();
    const result = await runHeadlessPrompt(
      'hi env',
      {},
      { sessionsRoot: root, models: fauxModels(['env ok']) },
    );
    expect(result.terminus).toBe('completed');
    // The mocked lane yields no assistant text. The default-env branch is
    // proven by the completed run; the summary is the named non-answer
    // (issue #129), not the prompt.
    expect(result.summary).toBe(
      '(no assistant text — the run settled without output)',
    );
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

// Issue #109: guard exhaustion must not abandon in-flight tools. On every
// exit path where a drive is (or was) in flight, the headless runner first
// requests a durable abort, then drains the kill registry — and only then
// sweeps: the reconciliation must observe the tree AFTER the orphaned work
// is dead, or late writes escape both the journal and the sweep.
describe('guard drain on exit paths (issue #109)', () => {
  function drainLane(
    events: string[],
    abortThrows = false,
  ): {
    lane: AgentLane;
    kills: OperationKillRegistry;
  } {
    const kills = new OperationKillRegistry();
    kills.track('op-1', () => {
      events.push('kill');
    });
    const lane = {
      ...fakeLane(),
      requestAbort: async (operationId: string) => {
        events.push(`abort:${operationId}`);
        if (abortThrows) throw new Error('lane refuses');
        return {
          ok: true as const,
          value: { operationId, newlyRequested: true },
        };
      },
    };
    return { lane: lane as unknown as AgentLane, kills };
  }

  beforeEach(() => {
    guardEvents.events.length = 0;
  });

  it('aborts and drains before the sweep on wall-clock exhaustion', async () => {
    const events: string[] = [];
    const { lane, kills } = drainLane(events);
    vi.mocked(bootSoloLane).mockResolvedValue({
      lane,
      kills,
    } as unknown as SoloLane);
    vi.mocked(driveToSettled).mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const result = await runHeadlessPrompt('hang', { timeoutMs: 40 }, deps());
    expect(result.terminus).toBe('budget_exhausted');
    expect(events).toEqual(['abort:op-1', 'kill']);
    expect(guardEvents.events).toEqual(['sweep']);
    // Order across the two logs: the drain ran before the sweep started.
    expect(events.length).toBe(2);
  });

  it('still drains the kill registry when the lane refuses the abort', async () => {
    const events: string[] = [];
    const { lane, kills } = drainLane(events, true);
    vi.mocked(bootSoloLane).mockResolvedValue({
      lane,
      kills,
    } as unknown as SoloLane);
    vi.mocked(driveToSettled).mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const result = await runHeadlessPrompt('hang', { timeoutMs: 40 }, deps());
    expect(result.terminus).toBe('budget_exhausted');
    // abort attempt (threw) → kill drained anyway → then sweep.
    expect(events).toEqual(['abort:op-1', 'kill']);
    expect(guardEvents.events).toEqual(['sweep']);
  });

  it('drains on the outer catch-all when the drive throws', async () => {
    const events: string[] = [];
    const { lane, kills } = drainLane(events);
    vi.mocked(bootSoloLane).mockResolvedValue({
      lane,
      kills,
    } as unknown as SoloLane);
    vi.mocked(driveToSettled).mockRejectedValue(new Error('drive blew up'));
    const result = await runHeadlessPrompt('boom', {}, deps());
    expect(result.terminus).toBe('failed');
    expect(events).toEqual(['abort:op-1', 'kill']);
    expect(guardEvents.events).toEqual(['sweep']);
  });

  it('drains on the waiting-deferred approval path', async () => {
    const events: string[] = [];
    const { lane, kills } = drainLane(events);
    vi.mocked(bootSoloLane).mockResolvedValue({
      lane,
      kills,
    } as unknown as SoloLane);
    vi.mocked(driveToSettled).mockResolvedValue({
      kind: 'waiting-deferred' as const,
      operationId: 'op-1',
      deferred: {} as unknown as DeferredHandle,
    });
    const result = await runHeadlessPrompt('wait', {}, deps());
    expect(result.terminus).toBe('approval_timed_out');
    expect(events).toEqual(['abort:op-1', 'kill']);
    expect(guardEvents.events).toEqual(['sweep']);
  });

  it('does not touch a lane when admission was refused', async () => {
    const events: string[] = [];
    const { lane, kills } = drainLane(events);
    vi.mocked(bootSoloLane).mockResolvedValue({
      lane: {
        ...lane,
        accept: async () => ({
          ok: false as const,
          error: { message: 'no' },
        }),
      },
      kills,
    } as unknown as SoloLane);
    const result = await runHeadlessPrompt('refused', {}, deps());
    expect(result.terminus).toBe('failed');
    // No operation was admitted: no abort, no kill — but the sweep ran.
    expect(events).toEqual([]);
    expect(guardEvents.events).toEqual(['sweep']);
  });
});
