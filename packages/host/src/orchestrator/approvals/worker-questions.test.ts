// Worker questions through the mailbox (issue #154; §14.2): free-text ask,
// sealed answer, first answer wins, durable across a re-launch, and a named
// status instead of a hang when nobody answers.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApprovalSigner } from './seal.js';
import { createOrchestratorApprovalsRun } from './worker-asks.js';
import {
  answerWorkerQuestion,
  askWorkerQuestion,
  publishWorkerQuestion,
  QUESTION_UNANSWERED_CODE,
  readPendingWorkerQuestions,
} from './worker-questions.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function mailbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-154-'));
  dirs.push(dir);
  return dir;
}
const input = {
  question: 'which file?',
  callId: 'call-1',
  sessionId: 'sess-o1',
  agentId: 'alpha',
  role: 'implementer',
};

describe('worker questions (issue #154)', () => {
  it('the seat answers a.ts and the worker receives a.ts', async () => {
    const dir = mailbox();
    const signer = createApprovalSigner();
    const asking = askWorkerQuestion(dir, input, {
      maxPendingMs: 5000,
      verifyKey: signer.verifyKey,
      pollMs: 2,
    });
    // The manager's pump: the pending question, answered once.
    let pending = readPendingWorkerQuestions(dir, signer.verifyKey);
    for (let i = 0; i < 200 && pending.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      pending = readPendingWorkerQuestions(dir, signer.verifyKey);
    }
    expect(pending.map((q) => q.question)).toEqual(['which file?']);
    expect(
      answerWorkerQuestion(
        dir,
        pending[0] as never,
        { answered: true, text: 'a.ts' },
        signer,
      ),
    ).toBe(true);
    await expect(asking).resolves.toEqual({ answered: true, text: 'a.ts' });
    expect(readPendingWorkerQuestions(dir, signer.verifyKey)).toEqual([]);
  });

  it('a second answer for the same key is ignored', () => {
    const dir = mailbox();
    const signer = createApprovalSigner();
    const published = publishWorkerQuestion(dir, input);
    expect(
      answerWorkerQuestion(
        dir,
        published,
        { answered: true, text: 'a.ts' },
        signer,
      ),
    ).toBe(true);
    expect(
      answerWorkerQuestion(
        dir,
        published,
        { answered: true, text: 'b.ts' },
        signer,
      ),
    ).toBe(false);
  });

  it('a re-launched worker reads the answer back instead of asking again', async () => {
    const dir = mailbox();
    const signer = createApprovalSigner();
    const first = publishWorkerQuestion(dir, input);
    answerWorkerQuestion(dir, first, { answered: true, text: 'a.ts' }, signer);
    // Same call, same question: the same question (nonce kept), answered.
    const again = publishWorkerQuestion(dir, input);
    expect(again.nonce).toBe(first.nonce);
    expect(readPendingWorkerQuestions(dir, signer.verifyKey)).toEqual([]);
    await expect(
      askWorkerQuestion(dir, input, {
        maxPendingMs: 10,
        verifyKey: signer.verifyKey,
        pollMs: 1,
      }),
    ).resolves.toEqual({ answered: true, text: 'a.ts' });
  });

  it('with no seat the bound ends the wait with the named status, not a hang', async () => {
    const dir = mailbox();
    const signer = createApprovalSigner();
    const outcome = await askWorkerQuestion(dir, input, {
      maxPendingMs: 20,
      verifyKey: signer.verifyKey,
      pollMs: 2,
    });
    expect(outcome).toMatchObject({
      answered: false,
      code: QUESTION_UNANSWERED_CODE,
    });
    // The withdrawn question is no longer presented.
    expect(readPendingWorkerQuestions(dir, signer.verifyKey)).toEqual([]);
  });

  it('an answer not sealed by this run never settles the question', async () => {
    const dir = mailbox();
    const signer = createApprovalSigner();
    const forger = createApprovalSigner();
    const published = publishWorkerQuestion(dir, input);
    answerWorkerQuestion(
      dir,
      published,
      { answered: true, text: 'evil' },
      forger,
    );
    const outcome = await askWorkerQuestion(dir, input, {
      maxPendingMs: 20,
      verifyKey: signer.verifyKey,
      pollMs: 2,
    });
    expect(outcome.answered).toBe(false);
  });
});

// The manager's pump presents each pending question to the run's question
// seat ONCE and seals the seat's answer for the asking worker.
describe('question pumping on the approvals run (issue #154)', () => {
  it('presents a worker question once and the worker receives the seat answer', async () => {
    const repo = mailbox();
    const home = mailbox();
    const presented: string[] = [];
    const run = createOrchestratorApprovalsRun({
      dir: join(repo, '.kubic', 'orchestrator'),
      sessionId: 'orch-154',
      maxPendingMs: 5_000,
      pollMs: 5,
      home,
      questionSeat: async (question) => {
        presented.push(`${question.agentId}: ${question.question}`);
        return 'a.ts';
      },
    });
    const asking = askWorkerQuestion(
      run.mailboxDir(),
      { ...input, agentId: 'worker-1', sessionId: 'orch-154-w1' },
      { maxPendingMs: 5_000, verifyKey: run.verifyKey(), pollMs: 2 },
    );
    const scope = {
      sessionId: 'orch-154',
      agentId: 'worker-1',
      worktree: '/wt/w1',
    };
    for (let i = 0; i < 200 && presented.length === 0; i += 1) {
      await run.pump(scope);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await expect(asking).resolves.toEqual({ answered: true, text: 'a.ts' });
    await run.pump(scope);
    expect(presented).toEqual(['worker-1: which file?']);
  });
});
