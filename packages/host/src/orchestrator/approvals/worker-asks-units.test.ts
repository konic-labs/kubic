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
import {
  approvalCommandText,
  summarizeCommand,
} from '../../approval-display.js';
import { summarizeRequest } from '../../approvals.js';
import { OrchestratorBudgetError } from './budgets.js';
import { buildOrchestratorRequest } from './request.js';
import type { OrchestratorVerdict } from './routing.js';
import { createApprovalSigner } from './seal.js';
import {
  ASKS_DIR,
  answerWorkerAsk,
  approvalsSessionDir,
  budgetForSpawn,
  createInteractiveSeat,
  createOrchestratorApprovalsRun,
  createWorkerAskRouter,
  createWorkerMailboxSeat,
  DECISIONS_FILE,
  FileDecisionStore,
  publishWorkerAsk,
  RouterAuditTrace,
  readPendingWorkerAsks,
  readWorkerAskAnswer,
  SKIP_RECORDS_FILE,
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
      "worker 'agent-1' requests outside-write (bash): configure the service\n  command: echo x > /etc/y\napprove? [y/N] ",
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
    const signer = createApprovalSigner();
    const decisions: Record<string, OrchestratorVerdict> = {
      a: { approved: true, by: 'user' },
      b: { approved: false, reason: 'user declined' },
    };
    new FileDecisionStore(dir, signer).save(decisions);
    expect(new FileDecisionStore(dir, signer).load().decisions).toEqual(
      decisions,
    );
    // The file on disk holds SEALED records, never the bare verdict: an
    // entry a worker plants has no MAC and loads as a drop (issue #149).
    const onDisk = JSON.parse(
      readFileSync(join(dir, DECISIONS_FILE), 'utf8'),
    ) as Record<string, { payload: unknown; mac: string }>;
    expect(Object.keys(onDisk)).toEqual(['a', 'b']);
    expect(onDisk.a?.payload).toEqual(decisions.a);
    expect(typeof onDisk.a?.mac).toBe('string');
  });

  it('loads a missing file as no decisions', () => {
    expect(
      new FileDecisionStore(tmpDir(), createApprovalSigner()).load(),
    ).toEqual({ decisions: {}, dropped: [] });
  });

  it('loads a torn or invalid file as no decisions (fail closed toward re-asking)', () => {
    const dir = tmpDir();
    const signer = createApprovalSigner();
    writeFileSync(join(dir, DECISIONS_FILE), '{"a": {"approved": tr');
    expect(new FileDecisionStore(dir, signer).load().decisions).toEqual({});
    writeFileSync(join(dir, DECISIONS_FILE), 'not json at all');
    expect(new FileDecisionStore(dir, signer).load().decisions).toEqual({});
  });

  it('leaves no tmp file behind after a save', () => {
    const dir = tmpDir();
    new FileDecisionStore(dir, createApprovalSigner()).save({
      a: { approved: true, by: 'user' },
    });
    expect(readdirSync(dir)).toEqual([DECISIONS_FILE]);
  });

  it('removes the tmp file and rethrows when the rename fails', () => {
    const dir = tmpDir();
    // A non-empty directory where the decisions file belongs: the rename
    // onto it fails, the way a read-only or busy target would.
    mkdirSync(join(dir, DECISIONS_FILE, 'occupied'), { recursive: true });
    expect(() =>
      new FileDecisionStore(dir, createApprovalSigner()).save({
        a: { approved: true, by: 'user' },
      }),
    ).toThrow();
    expect(readdirSync(dir)).toEqual([DECISIONS_FILE]);
  });
});

describe('createWorkerAskRouter memoOnce (issue #379, #149)', () => {
  it('reuses a decision the SAME manager persisted, in a fresh router, without asking', async () => {
    const dir = tmpDir();
    // One authority across the two routers: this is what makes a decision
    // this manager wrote readable again — a fresh PROCESS mints a fresh key
    // and re-asks instead (issue #149).
    const signer = createApprovalSigner();
    const seatA = vi.fn(async () => ({ approved: true, by: 'user' }) as const);
    const routerA = createWorkerAskRouter({
      dir,
      maxPendingMs: 1_000,
      seat: seatA,
      signer,
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
      signer,
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
    const signer = createApprovalSigner();
    expect(readPendingWorkerAsks(dir, { verifyKey: signer.verifyKey })).toEqual(
      [],
    );
    const published = publishWorkerAsk(dir, input());
    expect(published.request.key).toBe(request.key);
    expect(published.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(readPendingWorkerAsks(dir, { verifyKey: signer.verifyKey })).toEqual(
      [
        {
          request: published.request,
          args: input().args,
          nonce: published.nonce,
        },
      ],
    );
    expect(
      readPendingWorkerAsks(dir, {
        verifyKey: signer.verifyKey,
        agentId: 'agent-1',
      }),
    ).toHaveLength(1);
    expect(
      readPendingWorkerAsks(dir, {
        verifyKey: signer.verifyKey,
        agentId: 'someone-else',
      }),
    ).toEqual([]);
    expect(
      readWorkerAskAnswer(dir, request.key, {
        verifyKey: signer.verifyKey,
        nonce: published.nonce,
      }),
    ).toEqual({ state: 'missing' });

    answerWorkerAsk(dir, published, { approved: true, by: 'user' }, signer);
    expect(
      readWorkerAskAnswer(dir, request.key, {
        verifyKey: signer.verifyKey,
        nonce: published.nonce,
      }),
    ).toEqual({ state: 'verified', verdict: { approved: true, by: 'user' } });
    // A settled ask stays on disk as evidence but is no longer pending.
    expect(readPendingWorkerAsks(dir, { verifyKey: signer.verifyKey })).toEqual(
      [],
    );
    expect(existsSync(join(dir, ASKS_DIR, `${request.key}.json`))).toBe(true);
  });

  it('skips a torn ask and reads a torn answer as a refusal', () => {
    const dir = tmpDir();
    const signer = createApprovalSigner();
    mkdirSync(join(dir, ASKS_DIR), { recursive: true });
    writeFileSync(join(dir, ASKS_DIR, 'torn.json'), '{"request": {"ke');
    writeFileSync(join(dir, ASKS_DIR, 'k.answer.json'), '{"approved": tr');
    expect(readPendingWorkerAsks(dir, { verifyKey: signer.verifyKey })).toEqual(
      [],
    );
    expect(
      readWorkerAskAnswer(dir, 'k', {
        verifyKey: signer.verifyKey,
        nonce: 'n',
      }).state,
    ).toBe('refused');
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
    const signer = createApprovalSigner();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 2_000,
      pollMs: 5,
      verifyKey: signer.verifyKey,
    });
    const verdict = seat(lane);
    const [pending] = await until(() => {
      const asks = readPendingWorkerAsks(dir, { verifyKey: signer.verifyKey });
      return asks.length > 0 ? asks : undefined;
    });
    if (pending === undefined) throw new Error('no ask published');
    expect(pending.request.agentId).toBe('agent-7');
    expect(pending.request.trigger).toBe('outside-write');
    expect(pending.request.provenance.parentSessionId).toBe('orch-1');
    // The seat forwards the lane's summary, never raw args.
    expect(pending.args).toEqual({ summary: lane.summary });
    // The justification defaults when the lane gave none.
    expect(pending.request.justification).toBe(
      'worker child needs outside-write to complete its plan step',
    );
    answerWorkerAsk(dir, pending, { approved: true, by: 'user' }, signer);
    await expect(verdict).resolves.toEqual({ approved: true, by: 'user' });
  });

  it('carries a given justification and a manager refusal through', async () => {
    const dir = tmpDir();
    const signer = createApprovalSigner();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 2_000,
      pollMs: 5,
      verifyKey: signer.verifyKey,
    });
    const verdict = seat({ ...lane, justification: 'write the unit file' });
    const [pending] = await until(() => {
      const asks = readPendingWorkerAsks(dir, { verifyKey: signer.verifyKey });
      return asks.length > 0 ? asks : undefined;
    });
    if (pending === undefined) throw new Error('no ask published');
    expect(pending.request.justification).toBe('write the unit file');
    answerWorkerAsk(
      dir,
      pending,
      { approved: false, reason: 'user declined' },
      signer,
    );
    await expect(verdict).resolves.toEqual({
      approved: false,
      reason: 'user declined',
    });
  });

  it('denies with the timeout marker when no answer arrives within maxPendingMs', async () => {
    const dir = tmpDir();
    const signer = createApprovalSigner();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 30,
      pollMs: 5,
      verifyKey: signer.verifyKey,
    });
    const verdict = await seat(lane);
    expect(verdict?.approved).toBe(false);
    const reason = verdict?.approved === false ? verdict.reason : '';
    expect(reason).toContain(TIMEOUT_REASON_MARKER);
    expect(reason).toContain('after 30ms');
  });

  it('writes no credential material into the ask JSON (issue #192)', async () => {
    const dir = tmpDir();
    const signer = createApprovalSigner();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 30,
      pollMs: 5,
      verifyKey: signer.verifyKey,
    });
    // A non-command call: the seat forwards the lane's SUMMARY (the broad
    // redactor path) as the ask's args, so a secret-shaped path lands in
    // the mailbox JSON under <repo>/.kubic unless the redactor knows the
    // shape. The command path is separately pinned below.
    const verdict = seat({
      key: 'lane-key',
      capability: 'outside-write',
      toolName: 'write',
      summary: summarizeRequest('write', 'outside-write', {
        path: '/tmp/ghp_abcdef123456',
      }),
    });
    // The seat publishes synchronously before it waits for an answer.
    const [pending] = readPendingWorkerAsks(dir, {
      verifyKey: signer.verifyKey,
    });
    expect(pending).toBeDefined();
    const raw = readFileSync(
      join(dir, ASKS_DIR, `${pending?.request.key ?? ''}.json`),
      'utf8',
    );
    expect(raw).not.toContain('ghp_abcdef123456');
    expect(pending?.request.summary).not.toContain('ghp_abcdef123456');
    await expect(verdict).resolves.toMatchObject({ approved: false });

    // A command-bearing ask forwards the display-redacted command; the
    // summary is derived from it, so no token reaches the file either. Each
    // shape is one the DISPLAY redactor owns (issue #192 review): the
    // authorization header, a `-u` operand and URL userinfo.
    const commands: ReadonlyArray<readonly [string, string]> = [
      ['curl -H "Authorization: Bearer sk-live-123" https://x', 'sk-live-123'],
      ['curl -u admin:hunter2 https://x', 'hunter2'],
      ['git clone https://user:pw123456@host/x', 'pw123456'],
    ];
    for (const [index, [command, secret]] of commands.entries()) {
      const seat = createWorkerMailboxSeat({
        dir,
        maxPendingMs: 30,
        pollMs: 5,
        verifyKey: signer.verifyKey,
      });
      const pendingCommand = seat({
        key: `lane-key-cmd-${index}`,
        capability: 'network',
        toolName: 'bash',
        summary: summarizeCommand('network', command),
        command: approvalCommandText(command),
      });
      const asks = readPendingWorkerAsks(dir, { verifyKey: signer.verifyKey });
      const commandAsk = asks.find(
        (entry) => entry.request.key !== pending?.request.key,
      );
      expect(commandAsk, command).toBeDefined();
      const rawCommand = readFileSync(
        join(dir, ASKS_DIR, `${commandAsk?.request.key ?? ''}.json`),
        'utf8',
      );
      expect(rawCommand, command).not.toContain(secret);
      await expect(pendingCommand).resolves.toMatchObject({ approved: false });
    }
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

describe('seat approvals and router audit trace (issue #379)', () => {
  // Issue #323 superseded the standing `--yes` answer for worker asks: the
  // run's session-scoped full access is the only auto-approval, and it is
  // recorded as the user's. Ported from the removed createStandingAnswerSeat.
  it('session full access approves a worker ask as the user', async () => {
    const run = createOrchestratorApprovalsRun({
      dir: tmpDir(),
      sessionId: 'sess-1',
      maxPendingMs: 1_000,
      pollMs: 5,
      fullAccess: true,
    });
    const scope = {
      sessionId: 'sess-1',
      agentId: 'agent-1',
      worktree: '/wt/agent-1',
    };
    const published = publishWorkerAsk(run.mailboxDir(), input());
    run.beginWorker(scope);
    try {
      await expect(
        until(() => {
          const read = readWorkerAskAnswer(
            run.mailboxDir(),
            published.request.key,
            { verifyKey: run.verifyKey(), nonce: published.nonce },
          );
          return read.state === 'verified' ? read : undefined;
        }),
      ).resolves.toEqual({
        state: 'verified',
        verdict: { approved: true, by: 'user' },
      });
    } finally {
      run.endWorker('agent-1');
    }
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

  it('the router audit records the raised ask for an approving seat', async () => {
    const router = createWorkerAskRouter({
      dir: tmpDir(),
      maxPendingMs: 1_000,
      seat: createInteractiveSeat({ prompt: async () => 'y' }),
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
      await until(() => {
        const read = readWorkerAskAnswer(
          run.mailboxDir(),
          published.request.key,
          { verifyKey: run.verifyKey(), nonce: published.nonce },
        );
        return read.state === 'verified' ? read : undefined;
      });
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

// Two orchestrate runs share one repo runtime root (`.kubic/orchestrator`):
// two runs in one checkout, or in different linked worktrees of one repo
// (issue #279). Their default worker ids collide (`worker-1`), and a worker
// ask is matched by agent id — so a run that pumps a shared mailbox would
// answer ANOTHER run's ask (a `--full-access` run would approve it). Each run
// owns its mailbox and decision store; only the §60 ledger is shared.
describe('an approvals run answers only its own workers (issue #279)', () => {
  const scopeOf = (sessionId: string) => ({
    sessionId,
    agentId: 'worker-1',
    worktree: `/wt/${sessionId}/worker-1`,
  });
  const askFor = (sessionId: string) =>
    input({
      sessionId: 'worker-1',
      agentId: 'worker-1',
      worktree: `/wt/${sessionId}/worker-1`,
      provenance: { parentSessionId: `${sessionId}-worker-1` },
    });

  it('a full-access run never answers a sibling run\u2019s ask, though both use worker-1', async () => {
    const shared = tmpDir();
    const runA = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-a',
      maxPendingMs: 1_000,
      pollMs: 5,
    });
    const runB = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-b',
      maxPendingMs: 1_000,
      pollMs: 5,
      fullAccess: true,
    });
    // The child of run A publishes where run A told it to.
    const published = publishWorkerAsk(runA.mailboxDir(), askFor('sess-a'));
    // Run B's pump for ITS worker-1 must not see it, let alone approve it.
    const termination = await runB.pump(scopeOf('sess-b'));
    expect(termination).toBeUndefined();
    const answerOf = (run: typeof runA) =>
      readWorkerAskAnswer(run.mailboxDir(), published.request.key, {
        verifyKey: run.verifyKey(),
        nonce: published.nonce,
      });
    expect(answerOf(runA)).toEqual({ state: 'missing' });
    expect(answerOf(runB)).toEqual({ state: 'missing' });
    // Run A's own pump still finds and settles it: unanswered (no seat), it is
    // routed by A alone — pending asks are per run.
    expect(
      readPendingWorkerAsks(runA.mailboxDir(), { verifyKey: runA.verifyKey() }),
    ).toHaveLength(1);
    expect(
      readPendingWorkerAsks(runB.mailboxDir(), { verifyKey: runB.verifyKey() }),
    ).toEqual([]);
  });

  it('each run\u2019s mailbox is its own directory under the shared approvals dir, and a run answers its own worker', async () => {
    const shared = tmpDir();
    const runA = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-a',
      maxPendingMs: 1_000,
      pollMs: 5,
    });
    const runB = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-b',
      maxPendingMs: 1_000,
      pollMs: 5,
      fullAccess: true,
    });
    expect(runA.mailboxDir()).not.toBe(runB.mailboxDir());
    // One directory per session, keyed by the repo runtime root (issue #149):
    // never `<shared>/approvals`, and never under the repo at all when a
    // production run passes its own repo root.
    expect(runA.mailboxDir()).toContain('sess-a');
    expect(runB.mailboxDir()).toContain('sess-b');
    const own = publishWorkerAsk(runB.mailboxDir(), askFor('sess-b'));
    expect(await runB.pump(scopeOf('sess-b'))).toBeUndefined();
    expect(
      readWorkerAskAnswer(runB.mailboxDir(), own.request.key, {
        verifyKey: runB.verifyKey(),
        nonce: own.nonce,
      }),
    ).toEqual({ state: 'verified', verdict: { approved: true, by: 'user' } });
  });

  it('the §60 ledger stays at the shared approvals dir: one trail for every run', async () => {
    const shared = tmpDir();
    const seat = async () => ({ approved: true as const, by: 'user' as const });
    const runA = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-a',
      maxPendingMs: 1_000,
      pollMs: 5,
      seat,
    });
    const published = publishWorkerAsk(runA.mailboxDir(), askFor('sess-a'));
    expect(await runA.pump(scopeOf('sess-a'))).toBeUndefined();
    expect(
      readWorkerAskAnswer(runA.mailboxDir(), published.request.key, {
        verifyKey: runA.verifyKey(),
        nonce: published.nonce,
      }),
    ).toEqual({ state: 'verified', verdict: { approved: true, by: 'user' } });
    // `kubic audit` reads `<repo>/.kubic/orchestrator/approvals/audit.jsonl`.
    const ledger = readFileSync(
      join(shared, 'approvals', 'audit.jsonl'),
      'utf8',
    );
    expect(ledger.trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(runA.mailboxDir(), 'audit.jsonl'))).toBe(false);
  });
});

// A reused `--session` id must not inherit an earlier run's approvals state: a
// FRESH run discards it outright, and a run this process did not seal cannot
// authenticate any of it (issue #149), so neither a fresh run nor a later
// process can auto-approve a destructive ask off a leftover record.
describe('a fresh run starts with an empty approvals state for a reused session id', () => {
  const scope = {
    sessionId: 'reused',
    agentId: 'worker-1',
    worktree: '/wt/reused/worker-1',
  };
  const ask = () =>
    input({
      sessionId: 'worker-1',
      agentId: 'worker-1',
      worktree: scope.worktree,
      provenance: { parentSessionId: 'reused-worker-1' },
    });
  const open = (dir: string, extra: { fresh?: boolean } = {}) =>
    createOrchestratorApprovalsRun({
      dir,
      sessionId: 'reused',
      maxPendingMs: 30,
      pollMs: 5,
      ...extra,
    });

  it('does not inherit an old full-access grant, and a later process cannot honour one either', async () => {
    const shared = tmpDir();
    // An earlier run of this id opted into full access.
    const earlier = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'reused',
      maxPendingMs: 30,
      pollMs: 5,
      fullAccess: true,
    });
    expect(earlier.fullAccessGrant()).toBeDefined();
    const recordFile = join(
      approvalsSessionDir(shared, 'reused'),
      SKIP_RECORDS_FILE,
    );
    expect(existsSync(recordFile)).toBe(true);

    // A later run (its own signing authority, a resume or not) drops the
    // record: the grant was the user's, but only the manager that recorded it
    // can vouch for the file. Enforcement holds.
    const resumed = open(shared);
    expect(resumed.fullAccessGrant()).toBeUndefined();
    expect(
      resumed
        .audit()
        .some((event) => event.type === 'session-skip-record-dropped'),
    ).toBe(true);
    const resumedAsk = publishWorkerAsk(resumed.mailboxDir(), ask());
    await resumed.pump(scope);
    expect(
      readWorkerAskAnswer(resumed.mailboxDir(), resumedAsk.request.key, {
        verifyKey: resumed.verifyKey(),
        nonce: resumedAsk.nonce,
      }),
    ).not.toEqual({ state: 'verified' });

    // A fresh run of the same id starts empty: the record is gone from disk
    // and nothing of the earlier run survives.
    const fresh = open(shared, { fresh: true });
    expect(fresh.fullAccessGrant()).toBeUndefined();
    expect(existsSync(recordFile)).toBe(false);
    expect(
      new FileDecisionStore(
        approvalsSessionDir(shared, 'reused'),
        createApprovalSigner(),
      ).load(),
    ).toEqual({ decisions: {}, dropped: [] });
    expect(
      readPendingWorkerAsks(fresh.mailboxDir(), {
        verifyKey: fresh.verifyKey(),
      }),
    ).toEqual([]);
    const freshAsk = publishWorkerAsk(fresh.mailboxDir(), ask());
    await fresh.pump(scope);
    expect(
      readWorkerAskAnswer(fresh.mailboxDir(), freshAsk.request.key, {
        verifyKey: fresh.verifyKey(),
        nonce: freshAsk.nonce,
      }),
    ).not.toEqual({ state: 'verified' });
  });

  it('keeps the repo-wide ledger and other sessions\u2019 state', () => {
    const shared = tmpDir();
    const ledger = join(shared, 'approvals', 'audit.jsonl');
    const other = approvalsSessionDir(shared, 'other');
    mkdirSync(join(shared, 'approvals'), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(ledger, '{"row":1}\n');
    writeFileSync(join(other, DECISIONS_FILE), '{}');
    open(shared, { fresh: true });
    expect(readFileSync(ledger, 'utf8')).toBe('{"row":1}\n');
    expect(existsSync(join(other, DECISIONS_FILE))).toBe(true);
  });
});
