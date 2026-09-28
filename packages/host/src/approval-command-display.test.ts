// Approval dialogs show what will actually run (issue #316; §41.2, §16.4). A
// model can pad a harmless prefix past any character cap and hide a
// destructive tail: the request therefore carries the FULL command
// (control characters neutralized, secrets redacted), the summary never
// truncates silently, and orchestrator worker asks forward the full command
// to the manager's seat. Hermetic: temp dirs only, cleaned in afterEach.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approvalCommandText,
  SUMMARY_COMMAND_LIMIT,
} from './approval-display.js';
import {
  type ApprovalRequest,
  ApprovalService,
  approvalKey,
  createApprovalAsk,
  FileApprovalStore,
  summarizeRequest,
  type TriggerContext,
  validatePolicy,
} from './approvals.js';
import {
  buildOrchestratorRequest,
  type OrchestratorApprovalRequest,
} from './orchestrator/approvals/request.js';
import {
  ASKS_DIR,
  answerWorkerAsk,
  createWorkerAskRouter,
  createWorkerMailboxSeat,
  formatWorkerAskQuestion,
  readPendingWorkerAsks,
} from './orchestrator/approvals/worker-asks.js';

const made: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'approval-display-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A harmless prefix padded past every cap, then the destructive tail.
const PADDED = `echo 'running formatter' ${'x'.repeat(380)}; rm -rf ~/work`;

function triggerContext(): TriggerContext {
  return {
    workspace: '/work',
    network: 'none',
    isDestructive: (command) => /rm -rf/.test(command),
    isNetworkCommand: () => false,
    isOutsideWorkspace: () => false,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('summaries never truncate silently (issue #316)', () => {
  it('marks a truncated command summary with the hidden length', () => {
    const summary = summarizeRequest('bash', 'destructive-shell', {
      command: PADDED,
    });
    const hidden = PADDED.length - SUMMARY_COMMAND_LIMIT;
    expect(summary).toContain(`… (+${hidden} chars)`);
    expect(summary).not.toContain('rm -rf ~/work');
  });

  it('leaves a short command summary untouched', () => {
    expect(
      summarizeRequest('bash', 'destructive-shell', {
        command: 'rm -rf /tmp/x',
      }),
    ).toBe('destructive-shell: rm -rf /tmp/x');
  });

  it('neutralizes control and bidi characters and redacts secrets in the command text', () => {
    const text = approvalCommandText(
      'echo \u001b[2Jhi\u0007 \u202eevil --token abc123secret\nrm -rf x',
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/);
    expect(text).toContain('\\x1b[2J');
    expect(text).toContain('\\x07');
    expect(text).toContain('\\u202e');
    expect(text).not.toContain('abc123secret');
    // Newlines are kept: a multi-line command is shown as its lines.
    expect(text.split('\n')).toHaveLength(2);
  });
});

describe('the request carries the full command (issue #316)', () => {
  it('the approval key and the displayed command come from the same args', async () => {
    const seen: ApprovalRequest[] = [];
    const store = new FileApprovalStore(tmp());
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 1000 }),
      store,
      awaitAnswer: async (request) => {
        seen.push(request);
        return { approved: false, reason: 'no' };
      },
    });
    const ask = createApprovalAsk(service, triggerContext(), store);
    const args = { command: PADDED };
    await ask({ toolName: 'bash', args, toolCallId: 'c1' });
    const request = seen[0];
    expect(request?.command).toBe(PADDED);
    expect(request?.command?.endsWith('; rm -rf ~/work')).toBe(true);
    expect(request?.key).toBe(approvalKey('bash', 'destructive-shell', args));
  });
});

describe('orchestrator worker asks forward the full command (issue #316)', () => {
  it('derives a full command and a marked summary from the args', () => {
    const request = buildOrchestratorRequest({
      trigger: 'destructive-shell',
      toolName: 'bash',
      args: { command: PADDED },
      justification: 'clean the build output before rebuilding',
      sessionId: 's',
      agentId: 'worker-1',
      role: 'worker',
      worktree: '/wt',
      provenance: { parentSessionId: 'p' },
    });
    expect(request.command).toBe(PADDED);
    expect(request.summary).toMatch(/… \(\+\d+ chars\)$/);
    expect(formatWorkerAskQuestion(request)).toContain(PADDED);
  });

  it('a worker ask delivers the full command to the manager seat', async () => {
    const dir = tmp();
    mkdirSync(join(dir, ASKS_DIR), { recursive: true });
    const childSeat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 5000,
      pollMs: 2,
    });
    const verdict = childSeat({
      key: 'k',
      capability: 'destructive-shell',
      toolName: 'bash',
      summary: summarizeRequest('bash', 'destructive-shell', {
        command: PADDED,
      }),
      command: PADDED,
      justification: 'clean the build output before rebuilding',
    });
    await waitFor(() => readPendingWorkerAsks(dir).length === 1);
    const published = readPendingWorkerAsks(dir)[0];
    if (published === undefined) throw new Error('no ask published');
    const shown: OrchestratorApprovalRequest[] = [];
    const router = createWorkerAskRouter({
      dir,
      maxPendingMs: 5000,
      seat: async (request) => {
        shown.push(request);
        return { approved: false, reason: 'not now' };
      },
    });
    const { request, args } = published;
    const outcome = await router.ask({
      trigger: request.trigger,
      toolName: request.toolName,
      args,
      justification: request.justification,
      sessionId: request.sessionId,
      agentId: request.agentId,
      role: request.role,
      worktree: request.worktree,
      provenance: request.provenance,
    });
    answerWorkerAsk(dir, request.key, {
      approved: false,
      reason: outcome.approved ? 'unexpected' : outcome.reason,
    });
    await verdict;
    expect(shown[0]?.command).toBe(PADDED);
  });
});
