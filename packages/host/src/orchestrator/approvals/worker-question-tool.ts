// The worker-side `ask_user` tool (issue #154; §14.2): an orchestrator worker
// child asks the USER a free-text question through the run's mailbox and the
// tool result is the answer. Registered only when the child has a mailbox
// (KUBIC_APPROVALS_DIR + the manager's verify key): a solo `kubic run` has
// nobody to ask. Unanswered — no seat, a declined question or the bound —
// the result is a named `question_unanswered` error the model can act on,
// never a hang.
import {
  defineTool,
  type JsonValue,
  type ToolRegistration,
  Type,
} from '../../../../worker/src/pi-boundary.js';
import {
  askWorkerQuestion,
  QUESTION_UNANSWERED_CODE,
} from './worker-questions.js';

export const ASK_USER_TOOL = 'ask_user';

export interface AskUserToolOptions {
  dir: string;
  verifyKey: string;
  maxPendingMs: number;
  sessionId: string;
  agentId: string;
  role: string;
  pollMs?: number;
}

export function createAskUserTool(
  options: AskUserToolOptions,
): ToolRegistration {
  return defineTool({
    name: ASK_USER_TOOL,
    description:
      'Ask the user one short free-text question when you cannot proceed without their answer (which file, which option). Returns their answer, or an error when nobody answers in time — then continue with your best assumption and say so.',
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    // Asking twice is not harmful, but the answer is a human's: a replayed
    // call re-reads the same answer by its memo key instead of asking again.
    replay: 'safe',
    execute: async (args, api, callContext) => {
      const outcome = await askWorkerQuestion(
        options.dir,
        {
          question: args.question,
          callId: String(api.callId),
          sessionId: options.sessionId,
          agentId: options.agentId,
          role: options.role,
        },
        {
          maxPendingMs: options.maxPendingMs,
          verifyKey: options.verifyKey,
          ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
          ...(callContext.abortSignal === undefined
            ? {}
            : { signal: callContext.abortSignal }),
        },
      );
      const text = outcome.answered
        ? outcome.text
        : `error ${QUESTION_UNANSWERED_CODE}: ${outcome.reason}`;
      const details: JsonValue = outcome.answered
        ? { ok: true }
        : { ok: false, code: QUESTION_UNANSWERED_CODE };
      return { content: [{ type: 'text' as const, text }], details };
    },
  });
}
