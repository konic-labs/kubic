// Mailbox lifecycle (issue #152; §41.1, §41.2).
//
// The reported failure: a killed session A leaves an unanswered ask in a
// mailbox every run shares, so a later session B pumps A's ask for ITS
// `worker-1`, presents a dead session's request (or times out on it) and fails
// with `exit 4 approval_timeout` — a run ended by an ask its own worker never
// made. And nothing ever removed an ask or answer file.
//
// Issue #149 already made the mailbox per session (state lives under
// `~/.kubic/orchestrator/<repo-key>/<session>/`, never in the repo), which is
// what makes A and B unreachable to each other; the tests here PIN that
// property from the lifecycle angle, and add the missing half: a worker that
// settles leaves no ask files behind.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASKS_DIR,
  answerFilePath,
  askFilePath,
  createOrchestratorApprovalsRun,
  publishWorkerAsk,
  readPendingWorkerAsks,
  type WorkerApprovalScope,
  type WorkerAskInput,
} from './worker-asks.js';

const made: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-152-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function ask(agentId: string, sessionId = 'sess-a'): WorkerAskInput {
  return {
    trigger: 'outside-write',
    toolName: 'bash',
    args: { command: `echo ${agentId} > /etc/y` },
    justification: `configure the service for worker ${agentId}`,
    sessionId,
    agentId,
    role: 'worker',
    worktree: `/wt/${agentId}`,
    provenance: { parentSessionId: sessionId },
  };
}

function scope(sessionId: string, agentId: string): WorkerApprovalScope {
  return { sessionId, agentId, worktree: `/wt/${agentId}` };
}

describe('a killed session cannot fail the next one (issue #152)', () => {
  it("session B's worker-1 pump never sees session A's unanswered ask", async () => {
    const shared = tmpDir();
    const runA = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-a',
      maxPendingMs: 30,
      pollMs: 5,
    });
    const runB = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-b',
      maxPendingMs: 30,
      pollMs: 5,
    });
    // A's worker-1 asked and A was killed before answering.
    const stale = publishWorkerAsk(runA.mailboxDir(), ask('worker-1'));

    // B pumps ITS worker-1: no prompt, no timeout, no termination — the run is
    // not ended by an ask its own worker never made.
    expect(await runB.pump(scope('sess-b', 'worker-1'))).toBeUndefined();
    expect(runB.takeTermination('worker-1')).toBeUndefined();
    // A's ask is untouched, and still A's own.
    expect(
      readPendingWorkerAsks(runA.mailboxDir(), {
        verifyKey: runA.verifyKey(),
      }).map((entry) => entry.request.key),
    ).toEqual([stale.request.key]);
  });

  it("blockedIndicators() for B excludes A's stale ask", async () => {
    const shared = tmpDir();
    const runA = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-a',
      maxPendingMs: 30,
      pollMs: 5,
    });
    const runB = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-b',
      maxPendingMs: 30,
      pollMs: 5,
    });
    publishWorkerAsk(runA.mailboxDir(), ask('worker-1'));
    // B's manager view is B's own asks only: the indicator names the decider,
    // and a dead session's request is not this run's to present.
    expect(runB.blockedIndicators()).toEqual([]);
    // A sees its own ask pending until it is answered or its bound denies.
    expect(runA.blockedIndicators().map((entry) => entry.key)).toHaveLength(1);
  });
});

describe('a settled worker leaves no ask files behind (issue #152)', () => {
  it("endWorker removes that worker's ask and answer files, and no sibling's", async () => {
    const shared = tmpDir();
    const run = createOrchestratorApprovalsRun({
      dir: shared,
      sessionId: 'sess-a',
      maxPendingMs: 1_000,
      pollMs: 5,
      seat: async () => ({ approved: true, by: 'user' }),
    });
    const one = publishWorkerAsk(run.mailboxDir(), ask('worker-1'));
    const two = publishWorkerAsk(run.mailboxDir(), ask('worker-2'));
    // worker-1's ask is answered, then the worker settles.
    await run.pump(scope('sess-a', 'worker-1'));
    expect(
      existsSync(join(run.mailboxDir(), askFilePath(one.request.key))),
    ).toBe(true);
    expect(
      existsSync(join(run.mailboxDir(), answerFilePath(one.request.key))),
    ).toBe(true);

    run.endWorker('worker-1');
    expect(
      existsSync(join(run.mailboxDir(), askFilePath(one.request.key))),
    ).toBe(false);
    expect(
      existsSync(join(run.mailboxDir(), answerFilePath(one.request.key))),
    ).toBe(false);
    // The sibling has not settled: its ask (and its future answer) stay.
    expect(
      readPendingWorkerAsks(run.mailboxDir(), { verifyKey: run.verifyKey() }),
    ).toHaveLength(1);
    expect(
      existsSync(join(run.mailboxDir(), askFilePath(two.request.key))),
    ).toBe(true);
  });

  it('a worker that never asked leaves nothing, and the sweep is idempotent', () => {
    const run = createOrchestratorApprovalsRun({
      dir: tmpDir(),
      sessionId: 'sess-a',
      maxPendingMs: 1_000,
      pollMs: 5,
    });
    expect(() => run.endWorker('worker-1')).not.toThrow();
    expect(() => run.endWorker('worker-1')).not.toThrow();
    expect(readdirSync(join(run.mailboxDir(), ASKS_DIR))).toEqual([]);
  });
});
