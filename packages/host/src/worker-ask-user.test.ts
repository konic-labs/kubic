// Issue #154 (§14.2): a worker lane's `ask_user` tool asks the USER through the
// run's mailbox. Faux provider and a real lane: the model calls
// ask_user('which file?'), the manager's seat answers 'a.ts', and the tool
// result the model sees is 'a.ts'. With nobody answering the call ends with
// the named status instead of hanging the turn.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bootFauxLane,
  fauxToolUse,
} from '../../worker/src/lane/test-harness.js';
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '../../worker/src/pi-boundary.js';
import { createApprovalSigner } from './orchestrator/approvals/seal.js';
import { createAskUserTool } from './orchestrator/approvals/worker-question-tool.js';
import {
  answerWorkerQuestion,
  readPendingWorkerQuestions,
} from './orchestrator/approvals/worker-questions.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function mailbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-154-lane-'));
  dirs.push(dir);
  return dir;
}

function resultTexts(results: ReadonlyArray<{ text: string }>): string[] {
  return results.map((result) => result.text);
}

describe('ask_user on a worker lane (issue #154)', () => {
  it('the seat answers a.ts and the tool result is a.ts', async () => {
    const dir = mailbox();
    const signer = createApprovalSigner();
    const lane = await bootFauxLane({
      responses: [
        fauxToolUse([fauxToolCall('ask_user', { question: 'which file?' })]),
        fauxAssistantMessage('done'),
      ],
      interactionTools: [
        createAskUserTool({
          dir,
          verifyKey: signer.verifyKey,
          maxPendingMs: 10_000,
          sessionId: 'sess-o1',
          agentId: 'alpha',
          role: 'implementer',
          pollMs: 2,
        }),
      ],
    });
    try {
      // The manager's seat: answers the first pending question once.
      let stop = false;
      const seat = (async () => {
        while (!stop) {
          const [question] = readPendingWorkerQuestions(dir, signer.verifyKey);
          if (question !== undefined) {
            expect(question.question).toBe('which file?');
            answerWorkerQuestion(
              dir,
              question,
              { answered: true, text: 'a.ts' },
              signer,
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })();
      await lane.run('pick a file');
      stop = true;
      await seat;
      expect(resultTexts(await lane.toolResults())).toContain('a.ts');
    } finally {
      await lane.cleanup();
    }
  });

  it('with no seat the call ends with question_unanswered, not a hang', async () => {
    const dir = mailbox();
    const signer = createApprovalSigner();
    const lane = await bootFauxLane({
      responses: [
        fauxToolUse([fauxToolCall('ask_user', { question: 'which file?' })]),
        fauxAssistantMessage('assumed a.ts'),
      ],
      interactionTools: [
        createAskUserTool({
          dir,
          verifyKey: signer.verifyKey,
          maxPendingMs: 30,
          sessionId: 'sess-o1',
          agentId: 'alpha',
          role: 'implementer',
          pollMs: 2,
        }),
      ],
    });
    try {
      await lane.run('pick a file');
      const texts = resultTexts(await lane.toolResults());
      expect(
        texts.some((text) => text.startsWith('error question_unanswered:')),
      ).toBe(true);
    } finally {
      await lane.cleanup();
    }
  });
});
