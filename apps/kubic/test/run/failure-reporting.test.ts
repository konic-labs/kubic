// Headless hardening (review; ported to the durable lane): defense-in-depth
// --session validation inside runHeadlessPrompt, the ref triple on store
// failures, honest summaries when the model left no text, and the guard drain
// running BEFORE the reconciliation sweep. Faux models only: zero network.
import { abortLane } from '@kubic/agent/lane/abort';
import { createSession } from '@kubic/agent/lane/session-store';
import {
  createModels,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { mapTerminusToExitCode } from '@kubic/host/run';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import { fauxModels } from '../fixtures/faux-models.js';

const mockState = vi.hoisted(() => ({ closeShouldReject: false }));

// The guard-drain order tests need to see the sweep fire, so
// beginReconciliation is wrapped (sweep still logs; the real module is
// untouched for every other suite — file-local mock).
const guardEvents = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('@kubic/exec/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kubic/exec/journal')>();
  return {
    ...actual,
    beginReconciliation: vi.fn(() => ({
      sweep: () => {
        guardEvents.events.push('sweep');
      },
    })),
  };
});

vi.mock('@kubic/agent/lane/abort', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kubic/agent/lane/abort')>();
  const wrapped = async (
    ...args: Parameters<typeof actual.abortLane>
  ): ReturnType<typeof actual.abortLane> => {
    guardEvents.events.push('abort');
    return actual.abortLane(...args);
  };
  return { ...actual, abortLane: vi.fn(wrapped) };
});

vi.mock('@kubic/agent/lane/session-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kubic/agent/lane/session-store')>();
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
      session.release = async () => {
        throw new Error('release blew up');
      };
    }
    return session;
  }
});

// A provider that never answers: the run's guard is the only way out.
function hangingModels(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([() => new Promise<never>(() => undefined)]);
  return models;
}

function deps(): Parameters<typeof runHeadlessPrompt>[2] {
  return {
    sessionsRoot: tempDir('run-headless-hardening-'),
    models: fauxModels(['unused']),
    env: new FakeExecutionEnv({}),
  };
}

beforeEach(() => {
  // The no-isolation notice is not under test here (approvals/no-isolation-notice.test.ts owns
  // it); the documented opt-out keeps it off the test runner's stderr.
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  mockState.closeShouldReject = false;
  guardEvents.events.length = 0;
  vi.mocked(abortLane).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('headless run failure reporting', () => {
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
  });

  it('keeps the mapped result when the session release rejects', async () => {
    mockState.closeShouldReject = true;
    const result = await runHeadlessPrompt(
      'do it',
      {},
      { ...deps(), models: fauxModels(['all done']) },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('all done');
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

describe('summary honesty on the durable lane', () => {
  it('reports the named non-answer when the model left no text', async () => {
    const result = await runHeadlessPrompt(
      'prompt-never-echoed-fixture',
      {},
      { ...deps(), models: fauxModels(['']) },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe(
      '(no assistant text — the run settled without output)',
    );
    expect(result.summary).not.toContain('prompt-never-echoed-fixture');
  });

  it('reports the named non-answer for whitespace-only assistant text', async () => {
    const result = await runHeadlessPrompt(
      'prompt-never-echoed-fixture',
      {},
      { ...deps(), models: fauxModels(['   ']) },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe(
      '(no assistant text — the run settled without output)',
    );
  });

  it('trims and truncates the assistant text to 500 columns', async () => {
    const result = await runHeadlessPrompt(
      'do it',
      {},
      { ...deps(), models: fauxModels([`  ${'z'.repeat(600)}  `]) },
    );
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('z'.repeat(500));
  });

  it('maps a failed turn to its -derived terminus and message', async () => {
    const result = await runHeadlessPrompt(
      'break it',
      {},
      { ...deps(), models: createModels() },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    expect(result.error?.message).toMatch(/no models?|provider/i);
  });
});

// Guard exhaustion must not abandon in-flight tools. On every
// exit path where a turn is (or was) in flight, the headless runner first
// states the durable abort and drains the kill registry — and only then
// sweeps: the reconciliation must observe the tree AFTER the orphaned work
// is dead, or late writes escape both the journal and the sweep.
describe('guard drain on exit paths', () => {
  it('aborts and drains before the sweep on wall-clock exhaustion', async () => {
    const result = await runHeadlessPrompt(
      'hang',
      { timeoutMs: 40 },
      { ...deps(), models: hangingModels() },
    );
    expect(result.terminus).toBe('timeout');
    expect(vi.mocked(abortLane)).toHaveBeenCalled();
    // The drain ran before the sweep started.
    expect(guardEvents.events).toEqual(['abort', 'sweep']);
  });

  it('does not abort a settled run: the sweep follows its own path', async () => {
    const result = await runHeadlessPrompt(
      'do it',
      {},
      { ...deps(), models: fauxModels(['all done']) },
    );
    expect(result.terminus).toBe('completed');
    expect(vi.mocked(abortLane)).not.toHaveBeenCalled();
    expect(guardEvents.events).toEqual(['sweep']);
  });
});
