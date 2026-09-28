// Direct unit tests for the worker-ask primitives (issue #379): the
// interactive seat's answer parsing (a mistyped Enter or EOF can never
// grant a capability), the durable decision store's fail-closed load and
// atomic save, memoOnce across router restarts, the worker child's mailbox
// seat, the mailbox read/answer round-trip, per-spawn budget resolution,
// the standing-answer seat, the router audit trace and takeTermination.
// Real files in a temp dir (removed in afterEach), no network, no model.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorBudgetError } from './budgets.js';
import { buildOrchestratorRequest } from './request.js';
import type { OrchestratorVerdict } from './routing.js';
import {
  ASKS_DIR,
  answerWorkerAsk,
  budgetForSpawn,
  createInteractiveSeat,
  createOrchestratorApprovalsRun,
  createStandingAnswerSeat,
  createWorkerAskRouter,
  createWorkerMailboxSeat,
  DECISIONS_FILE,
  FileDecisionStore,
  publishWorkerAsk,
  RouterAuditTrace,
  readPendingWorkerAsks,
  readWorkerAskAnswer,
  TIMEOUT_REASON_MARKER,
  type WorkerAskInput,
} from './worker-asks.js';

const made: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-379-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function input(overrides: Partial<WorkerAskInput> = {}): WorkerAskInput {
  return {
    trigger: 'outside-write',
    toolName: 'bash',
    args: { command: 'echo x > /etc/y' },
    justification: 'configure the service',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    role: 'implementer',
    worktree: '/wt/agent-1',
    provenance: { parentSessionId: 'root-sess' },
    ...overrides,
  };
}

const request = buildOrchestratorRequest(input());

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

describe('createInteractiveSeat parsing (issue #379)', () => {
  it.each<[string, OrchestratorVerdict]>([
    ['y', { approved: true, by: 'user' }],
    ['Y', { approved: true, by: 'user' }],
    ['yes', { approved: true, by: 'user' }],
    ['YES', { approved: true, by: 'user' }],
    ['yes ', { approved: true, by: 'user' }],
    ['yes\n', { approved: true, by: 'user' }],
    ['  y  ', { approved: true, by: 'user' }],
    ['', { approved: false, reason: 'no answer — denied' }],
    ['  ', { approved: false, reason: 'no answer — denied' }],
    ['\n', { approved: false, reason: 'no answer — denied' }],
    ['n', { approved: false, reason: 'user declined' }],
    ['no', { approved: false, reason: 'user declined' }],
    ['yolo', { approved: false, reason: 'user declined' }],
    ['yess', { approved: false, reason: 'user declined' }],
    ['ye', { approved: false, reason: 'user declined' }],
    ['y es', { approved: false, reason: 'user declined' }],
    ['sure y', { approved: false, reason: 'user declined' }],
  ])('answer %j -> %j', async (answer, verdict) => {
    const seat = createInteractiveSeat({ prompt: async () => answer });
    await expect(seat(request)).resolves.toEqual(verdict);
  });

  it('asks the envelope-built question with a [y/N] suffix', async () => {
    const questions: string[] = [];
    const seat = createInteractiveSeat({
      prompt: async (question) => {
        questions.push(question);
        return 'n';
      },
    });
    await seat(request);
    expect(questions).toEqual([
      "worker 'agent-1' requests outside-write (bash): configure the service — approve? [y/N] ",
    ]);
  });

  it('denies when the prompt itself fails (EOF, closed stdin)', async () => {
    const seat = createInteractiveSeat({
      prompt: async () => {
        throw new Error('stdin closed');
      },
    });
    await expect(seat(request)).resolves.toEqual({
      approved: false,
      reason: 'approval prompt failed — denied',
    });
  });
});

describe('FileDecisionStore (issue #379)', () => {
  it('round-trips saved decisions', () => {
    const dir = tmpDir();
    const decisions: Record<string, OrchestratorVerdict> = {
      a: { approved: true, by: 'user' },
      b: { approved: false, reason: 'user declined' },
    };
    new FileDecisionStore(dir).save(decisions);
    expect(new FileDecisionStore(dir).load()).toEqual(decisions);
    expect(JSON.parse(readFileSync(join(dir, DECISIONS_FILE), 'utf8'))).toEqual(
      decisions,
    );
  });

  it('loads a missing file as no decisions', () => {
    expect(new FileDecisionStore(tmpDir()).load()).toEqual({});
  });

  it('loads a torn or invalid file as no decisions (fail closed toward re-asking)', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, DECISIONS_FILE), '{"a": {"approved": tr');
    expect(new FileDecisionStore(dir).load()).toEqual({});
    writeFileSync(join(dir, DECISIONS_FILE), 'not json at all');
    expect(new FileDecisionStore(dir).load()).toEqual({});
  });

  it('leaves no tmp file behind after a save', () => {
    const dir = tmpDir();
    new FileDecisionStore(dir).save({ a: { approved: true, by: 'user' } });
    expect(readdirSync(dir)).toEqual([DECISIONS_FILE]);
  });

  it('removes the tmp file and rethrows when the rename fails', () => {
    const dir = tmpDir();
    // A non-empty directory where the decisions file belongs: the rename
    // onto it fails, the way a read-only or busy target would.
    mkdirSync(join(dir, DECISIONS_FILE, 'occupied'), { recursive: true });
    expect(() =>
      new FileDecisionStore(dir).save({ a: { approved: true, by: 'user' } }),
    ).toThrow();
    expect(readdirSync(dir)).toEqual([DECISIONS_FILE]);
  });
});

describe('createWorkerAskRouter memoOnce across restarts (issue #379)', () => {
  it('reuses a decision persisted by router A in a fresh router B without asking', async () => {
    const dir = tmpDir();
    const seatA = vi.fn(async () => ({ approved: true, by: 'user' }) as const);
    const routerA = createWorkerAskRouter({
      dir,
      maxPendingMs: 1_000,
      seat: seatA,
    });
    await expect(routerA.ask(input())).resolves.toMatchObject({
      approved: true,
    });
    expect(seatA).toHaveBeenCalledTimes(1);

    const seatB = vi.fn(
      async () => ({ approved: false, reason: 'must not be asked' }) as const,
    );
    const routerB = createWorkerAskRouter({
      dir,
      maxPendingMs: 1_000,
      seat: seatB,
    });
    await expect(routerB.ask(input())).resolves.toEqual({
      approved: true,
      key: request.key,
    });
    expect(seatB).not.toHaveBeenCalled();
    expect(routerB.decided(request.key)).toEqual({
      approved: true,
      by: 'user',
    });
  });
});

describe('mailbox round-trip (issue #379)', () => {
  it('publishes an ask, lists it pending until answered, then reads the answer', () => {
    const dir = tmpDir();
    expect(readPendingWorkerAsks(dir)).toEqual([]);
    const published = publishWorkerAsk(dir, input());
    expect(published.request.key).toBe(request.key);
    expect(readPendingWorkerAsks(dir)).toEqual([
      { request: published.request, args: input().args },
    ]);
    expect(readPendingWorkerAsks(dir, 'agent-1')).toHaveLength(1);
    expect(readPendingWorkerAsks(dir, 'someone-else')).toEqual([]);
    expect(readWorkerAskAnswer(dir, request.key)).toBeUndefined();

    answerWorkerAsk(dir, request.key, { approved: true, by: 'user' });
    expect(readWorkerAskAnswer(dir, request.key)).toEqual({
      approved: true,
      by: 'user',
    });
    // A settled ask stays on disk as evidence but is no longer pending.
    expect(readPendingWorkerAsks(dir)).toEqual([]);
    expect(existsSync(join(dir, ASKS_DIR, `${request.key}.json`))).toBe(true);
  });

  it('skips a torn ask and reads a torn answer as none', () => {
    const dir = tmpDir();
    mkdirSync(join(dir, ASKS_DIR), { recursive: true });
    writeFileSync(join(dir, ASKS_DIR, 'torn.json'), '{"request": {"ke');
    writeFileSync(join(dir, ASKS_DIR, 'k.answer.json'), '{"approved": tr');
    expect(readPendingWorkerAsks(dir)).toEqual([]);
    expect(readWorkerAskAnswer(dir, 'k')).toBeUndefined();
  });
});

describe('createWorkerMailboxSeat (issue #379)', () => {
  const lane = {
    key: 'lane-key',
    capability: 'outside-write',
    toolName: 'bash',
    summary: 'bash: echo x > /etc/y',
  };

  it('publishes the ask and returns the manager answer as the verdict', async () => {
    vi.stubEnv('KUBIC_WORKER_ID', 'agent-7');
    vi.stubEnv('KUBIC_ORCHESTRATOR_SESSION', 'orch-1');
    const dir = tmpDir();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 2_000,
      pollMs: 5,
    });
    const verdict = seat(lane);
    const [pending] = await until(() => {
      const asks = readPendingWorkerAsks(dir);
      return asks.length > 0 ? asks : undefined;
    });
    expect(pending?.request.agentId).toBe('agent-7');
    expect(pending?.request.trigger).toBe('outside-write');
    expect(pending?.request.provenance.parentSessionId).toBe('orch-1');
    // The seat forwards the lane's summary, never raw args.
    expect(pending?.args).toEqual({ summary: lane.summary });
    // The justification defaults when the lane gave none.
    expect(pending?.request.justification).toBe(
      'worker child needs outside-write to complete its plan step',
    );
    answerWorkerAsk(dir, pending?.request.key ?? '', {
      approved: true,
      by: 'user',
    });
    await expect(verdict).resolves.toEqual({ approved: true, by: 'user' });
  });

  it('carries a given justification and a manager refusal through', async () => {
    const dir = tmpDir();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 2_000,
      pollMs: 5,
    });
    const verdict = seat({ ...lane, justification: 'write the unit file' });
    const [pending] = await until(() => {
      const asks = readPendingWorkerAsks(dir);
      return asks.length > 0 ? asks : undefined;
    });
    expect(pending?.request.justification).toBe('write the unit file');
    answerWorkerAsk(dir, pending?.request.key ?? '', {
      approved: false,
      reason: 'user declined',
    });
    await expect(verdict).resolves.toEqual({
      approved: false,
      reason: 'user declined',
    });
  });

  it('denies with the timeout marker when no answer arrives within maxPendingMs', async () => {
    const dir = tmpDir();
    const seat = createWorkerMailboxSeat({ dir, maxPendingMs: 30, pollMs: 5 });
    const verdict = await seat(lane);
    expect(verdict?.approved).toBe(false);
    const reason = verdict?.approved === false ? verdict.reason : '';
    expect(reason).toContain(TIMEOUT_REASON_MARKER);
    expect(reason).toContain('after 30ms');
  });
});

describe('budgetForSpawn (issue #379)', () => {
  it.each([undefined, null])('%s is unbudgeted, opt-in only', (configured) => {
    const plan = budgetForSpawn(configured);
    expect(plan.budget).toBeUndefined();
    expect(plan.describe()).toBe(
      'no budget configured for this spawn (opt-in only)',
    );
  });

  it('an empty spec enforces nothing and says so', () => {
    const plan = budgetForSpawn({});
    expect(plan.budget).toEqual({});
    expect(plan.describe()).toBe(
      'budget for this spawn: empty (enforces nothing)',
    );
  });

  it('names the configured dimensions', () => {
    const plan = budgetForSpawn({ maxToolCalls: 3, maxTokens: 100 });
    expect(plan.budget).toEqual({ maxToolCalls: 3, maxTokens: 100 });
    expect(plan.describe()).toBe(
      'budget for this spawn: maxTokens, maxToolCalls',
    );
  });

  it('throws the budgets validation error on an invalid spec', () => {
    expect(() => budgetForSpawn({ maxToolCalls: -1 })).toThrow(
      OrchestratorBudgetError,
    );
    expect(() => budgetForSpawn({ maxToolCalls: -1 })).toThrow(
      'maxToolCalls must be a positive number',
    );
    expect(() => budgetForSpawn('lots')).toThrow(
      'orchestrator budget must be an object',
    );
  });
});

describe('standing answer seat and router audit trace (issue #379)', () => {
  it('createStandingAnswerSeat approves as the user', async () => {
    await expect(createStandingAnswerSeat()(request)).resolves.toEqual({
      approved: true,
      by: 'user',
    });
  });

  it('RouterAuditTrace records events in order and hands out a copy', () => {
    const trace = new RouterAuditTrace();
    trace.append({ type: 'orchestrator-ask-raised', detail: 'one' });
    trace.append({ type: 'budget-self-raise-refused', detail: 'two' });
    const events = trace.events();
    expect(events).toEqual([
      { type: 'orchestrator-ask-raised', detail: 'one' },
      { type: 'budget-self-raise-refused', detail: 'two' },
    ]);
    (events as unknown as unknown[]).push('tamper');
    expect(trace.events()).toHaveLength(2);
  });

  it('the router audit records the raised ask for a standing-answer approval', async () => {
    const router = createWorkerAskRouter({
      dir: tmpDir(),
      maxPendingMs: 1_000,
      seat: createStandingAnswerSeat(),
    });
    await expect(router.ask(input())).resolves.toEqual({
      approved: true,
      key: request.key,
    });
    expect(router.audit()[0]).toEqual({
      type: 'orchestrator-ask-raised',
      detail: `${request.key} outside-write from agent agent-1: ${request.summary}`,
    });
  });
});

describe('takeTermination (issue #379)', () => {
  it('returns the recorded terminal outcome once, then undefined', async () => {
    const run = createOrchestratorApprovalsRun({
      dir: tmpDir(),
      sessionId: 'sess-1',
      maxPendingMs: 1_000,
      pollMs: 5,
    });
    const scope = {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      worktree: '/wt/agent-1',
    };
    expect(run.takeTermination('agent-1')).toBeUndefined();
    // A self-raise is refused immediately — a deterministic terminal outcome.
    const published = publishWorkerAsk(
      run.mailboxDir(),
      input({ args: { budgetRaise: { maxToolCalls: 99 } } }),
    );
    run.beginWorker(scope);
    try {
      await until(() =>
        readWorkerAskAnswer(run.mailboxDir(), published.request.key),
      );
      const termination = await until(() => run.takeTermination('agent-1'));
      expect(termination).toMatchObject({
        agentId: 'agent-1',
        key: published.request.key,
        code: 'approval_denied',
        exitCode: 4,
      });
      expect(termination.message).toMatch(
        /^budget raise refused for worker 'agent-1': /,
      );
      expect(run.takeTermination('agent-1')).toBeUndefined();
    } finally {
      run.endWorker('agent-1');
    }
  });
});
