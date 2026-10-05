// Worker questions (issue #154; §14.2 deferred interactions): a worker
// child that needs clarification asks the USER a free-text question through
// the same mailbox, with the same rules as an approval ask (worker-asks.ts) —
// published atomically by the child, presented by the manager's seat, answered
// with a SEALED, nonce-bound answer only this run's manager can produce, and a
// bounded wait that ends with a named status instead of a hang.
//
//   key        hash of (session, agent, tool call, question) — the memo key:
//              the same call asking the same question is ONE question, so a
//              worker re-launched after the answer reads it back instead of
//              asking again (durable across restart).
//   first wins the manager writes an answer only when none exists yet; a
//              second answer for the same key is ignored.
//   headless   no seat → nobody answers → the child's own bound elapses and
//              the tool reports QUESTION_UNANSWERED_CODE; never a hang.
import { createHash, randomBytes } from 'node:crypto';
import { createNodeFileBridge } from '../../../../exec/src/file-bridge.js';
import { type ApprovalSigner, verifySealed } from './seal.js';

export const QUESTION_UNANSWERED_CODE = 'question_unanswered';

export interface WorkerQuestionInput {
  question: string;
  /** The pi-durable tool call id: part of the memo key. */
  callId: string;
  sessionId: string;
  agentId: string;
  role: string;
}

export interface PublishedWorkerQuestion {
  kind: 'question';
  key: string;
  question: string;
  sessionId: string;
  agentId: string;
  role: string;
  /** Minted by the asker; the sealed answer must echo it. */
  nonce: string;
}

export type WorkerQuestionAnswer =
  | { answered: true; text: string }
  | { answered: false; reason: string };

export type WorkerQuestionOutcome =
  | { answered: true; text: string }
  | { answered: false; code: typeof QUESTION_UNANSWERED_CODE; reason: string };

interface WorkerQuestionAnswerPayload {
  key: string;
  nonce: string;
  answer: WorkerQuestionAnswer;
}

export function workerQuestionKey(
  input: Pick<
    WorkerQuestionInput,
    'question' | 'callId' | 'sessionId' | 'agentId'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.sessionId,
        input.agentId,
        input.callId,
        input.question,
      ]),
    )
    .digest('hex')
    .slice(0, 40);
}

/** The mailbox subdirectory questions live in (retired per run, like asks). */
export const QUESTIONS_DIR = 'questions';

export function questionFilePath(key: string): string {
  return `${QUESTIONS_DIR}/question-${key}.json`;
}

export function questionAnswerFilePath(key: string): string {
  return `${QUESTIONS_DIR}/question-${key}.answer.json`;
}

function isQuestion(value: unknown): value is PublishedWorkerQuestion {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Record<string, unknown>;
  return (
    q.kind === 'question' &&
    typeof q.key === 'string' &&
    typeof q.question === 'string' &&
    typeof q.sessionId === 'string' &&
    typeof q.agentId === 'string' &&
    typeof q.role === 'string' &&
    typeof q.nonce === 'string'
  );
}

function isAnswer(value: unknown): value is WorkerQuestionAnswer {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  if (a.answered === true) return typeof a.text === 'string';
  if (a.answered === false) return typeof a.reason === 'string';
  return false;
}

// The child's side: publish the question — or, when this very call already
// asked it (a re-launched worker), keep the published one so its sealed
// answer still verifies.
export function publishWorkerQuestion(
  dir: string,
  input: WorkerQuestionInput,
): PublishedWorkerQuestion {
  const bridge = createNodeFileBridge(dir);
  const key = workerQuestionKey(input);
  const target = questionFilePath(key);
  if (bridge.exists(target)) {
    try {
      const existing: unknown = JSON.parse(bridge.readTextFile(target));
      if (isQuestion(existing) && existing.key === key) return existing;
    } catch {
      // A torn file is replaced below.
    }
  }
  const published: PublishedWorkerQuestion = {
    kind: 'question',
    key,
    question: input.question,
    sessionId: input.sessionId,
    agentId: input.agentId,
    role: input.role,
    nonce: randomBytes(16).toString('hex'),
  };
  bridge.createDir(QUESTIONS_DIR, true);
  const tmp = `${target}.${process.pid}.tmp`;
  bridge.writeFile(tmp, JSON.stringify(published), { mode: 0o600 });
  bridge.renameFile(tmp, target);
  return published;
}

export type WorkerQuestionAnswerRead =
  | { state: 'missing' }
  | { state: 'verified'; answer: WorkerQuestionAnswer }
  | { state: 'refused'; detail: string };

export function readWorkerQuestionAnswer(
  dir: string,
  key: string,
  expected: { verifyKey: string; nonce: string },
): WorkerQuestionAnswerRead {
  const bridge = createNodeFileBridge(dir);
  let raw: unknown;
  try {
    if (!bridge.exists(questionAnswerFilePath(key)))
      return { state: 'missing' };
    raw = JSON.parse(bridge.readTextFile(questionAnswerFilePath(key)));
  } catch {
    return {
      state: 'refused',
      detail: `answer for question ${key}: unreadable`,
    };
  }
  const sealed = verifySealed<WorkerQuestionAnswerPayload>(
    expected.verifyKey,
    raw,
  );
  if (sealed === undefined) {
    return {
      state: 'refused',
      detail: `answer for question ${key}: no MAC from this run's manager`,
    };
  }
  const payload = sealed.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    payload.key !== key ||
    payload.nonce !== expected.nonce ||
    !isAnswer(payload.answer)
  ) {
    return {
      state: 'refused',
      detail: `answer for question ${key}: stale or malformed`,
    };
  }
  return { state: 'verified', answer: payload.answer };
}

// The manager's side: every published question with no verified answer yet,
// in key order. A torn or foreign file is not a question.
export function readPendingWorkerQuestions(
  dir: string,
  verifyKey: string,
): PublishedWorkerQuestion[] {
  const bridge = createNodeFileBridge(dir);
  if (!bridge.exists(QUESTIONS_DIR)) return [];
  const pending: PublishedWorkerQuestion[] = [];
  for (const entry of bridge.listDir(QUESTIONS_DIR)) {
    if (!/^question-[0-9a-f]{40}\.json$/.test(entry.name)) continue;
    let question: unknown;
    try {
      question = JSON.parse(
        bridge.readTextFile(`${QUESTIONS_DIR}/${entry.name}`),
      );
    } catch {
      continue;
    }
    if (!isQuestion(question)) continue;
    const answer = readWorkerQuestionAnswer(dir, question.key, {
      verifyKey,
      nonce: question.nonce,
    });
    if (answer.state !== 'verified') pending.push(question);
  }
  return pending.sort((a, b) => a.key.localeCompare(b.key));
}

// The manager's answer, sealed with the question's key and nonce. First answer
// wins: when a verified answer already exists the call writes nothing and
// returns false.
export function answerWorkerQuestion(
  dir: string,
  published: Pick<PublishedWorkerQuestion, 'key' | 'nonce'>,
  answer: WorkerQuestionAnswer,
  signer: ApprovalSigner,
): boolean {
  const existing = readWorkerQuestionAnswer(dir, published.key, {
    verifyKey: signer.verifyKey,
    nonce: published.nonce,
  });
  if (existing.state === 'verified') return false;
  const bridge = createNodeFileBridge(dir);
  const target = questionAnswerFilePath(published.key);
  const sealed = signer.seal<WorkerQuestionAnswerPayload>({
    key: published.key,
    nonce: published.nonce,
    answer,
  });
  const tmp = `${target}.${process.pid}.tmp`;
  bridge.writeFile(tmp, JSON.stringify(sealed), { mode: 0o600 });
  bridge.renameFile(tmp, target);
  return true;
}

function removeQuestionFiles(dir: string, key: string): void {
  const bridge = createNodeFileBridge(dir);
  for (const path of [questionFilePath(key), questionAnswerFilePath(key)]) {
    try {
      if (bridge.exists(path)) bridge.remove(path, false, true);
    } catch {
      // Best-effort withdrawal.
    }
  }
}

// The child's bounded wait. A verified answer settles it (an empty or
// declined answer is reported as unanswered, with the seat's reason); the
// bound or an abort withdraws the question and reports QUESTION_UNANSWERED.
export async function awaitWorkerQuestionAnswer(
  dir: string,
  published: Pick<PublishedWorkerQuestion, 'key' | 'nonce'>,
  options: {
    maxPendingMs: number;
    verifyKey: string;
    pollMs?: number;
    clock?: () => number;
    signal?: AbortSignal;
  },
): Promise<WorkerQuestionOutcome> {
  const clock = options.clock ?? Date.now;
  const pollMs = options.pollMs ?? 25;
  const deadline = clock() + options.maxPendingMs;
  for (;;) {
    const read = readWorkerQuestionAnswer(dir, published.key, {
      verifyKey: options.verifyKey,
      nonce: published.nonce,
    });
    if (read.state === 'verified') {
      return read.answer.answered
        ? { answered: true, text: read.answer.text }
        : {
            answered: false,
            code: QUESTION_UNANSWERED_CODE,
            reason: read.answer.reason,
          };
    }
    if (options.signal?.aborted === true || clock() >= deadline) {
      removeQuestionFiles(dir, published.key);
      return {
        answered: false,
        code: QUESTION_UNANSWERED_CODE,
        reason:
          options.signal?.aborted === true
            ? 'the question was withdrawn before anyone answered'
            : `no answer within ${options.maxPendingMs}ms (no one is presenting worker questions)`,
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

// One question, end to end on the child's side: publish (or reuse) and wait.
export async function askWorkerQuestion(
  dir: string,
  input: WorkerQuestionInput,
  options: {
    maxPendingMs: number;
    verifyKey: string;
    pollMs?: number;
    signal?: AbortSignal;
  },
): Promise<WorkerQuestionOutcome> {
  const published = publishWorkerQuestion(dir, input);
  return awaitWorkerQuestionAnswer(dir, published, options);
}
