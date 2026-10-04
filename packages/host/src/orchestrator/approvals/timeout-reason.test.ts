// The timeout-reason pin (issue #129): every producer that emits an
// approval-timeout reason must carry the SHARED marker — and the
// classifier that reads the marker must label the same denial a timeout.
// A producer reworded without the marker turns this test red, so drift is
// a broken build rather than a prose surprise.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ApprovalService,
  MemoryApprovalStore,
  validatePolicy,
} from '../../approvals.js';
import { buildOrchestratorRequest } from './request.js';
import { createOrchestratorRouter } from './routing.js';
import { createApprovalSigner } from './seal.js';
import {
  APPROVAL_TIMEOUT_CODE,
  awaitWorkerAskAnswer,
  classifyVerdict,
  TIMEOUT_REASON_MARKER,
} from './worker-asks.js';

describe('every approval timeout producer carries the shared marker (issue #129)', () => {
  it('the approval-service bound', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({ route: 'ask-user', maxPendingMs: 1 }),
      store: new MemoryApprovalStore(),
    });
    const verdict = await service.request({
      key: 'pin-approval-service',
      capability: 'install',
      toolName: 'bash',
      summary: 'npm i',
    });
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) {
      expect(verdict.reason).toContain(TIMEOUT_REASON_MARKER);
    }
  });

  it('the mailbox ask path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kubic-timeout-pin-'));
    try {
      const outcome = await awaitWorkerAskAnswer(dir, 'pin-mailbox', {
        maxPendingMs: 1,
        pollMs: 1,
        verifyKey: createApprovalSigner().verifyKey,
        nonce: 'pin-nonce',
      });
      expect(outcome.approved).toBe(false);
      if (!outcome.approved) {
        expect(outcome.code).toBe(APPROVAL_TIMEOUT_CODE);
        expect(outcome.reason).toContain(TIMEOUT_REASON_MARKER);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the orchestrator routing decision', async () => {
    const router = createOrchestratorRouter({ maxPendingMs: 1 });
    const request = buildOrchestratorRequest({
      trigger: 'network',
      toolName: 'bash',
      args: { command: 'curl https://example.com' },
      justification: 'need release tarball',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      role: 'implementer',
      worktree: '/wt/agent-1',
      provenance: { parentSessionId: 'root' },
    });
    const verdict = await router.request(request);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) {
      expect(verdict.reason).toContain(TIMEOUT_REASON_MARKER);
    }
    // The classifier reads the same constant: a producer that drifts breaks
    // this label here, not silently at run time.
    const classified = classifyVerdict(request.key, verdict);
    expect(classified.approved).toBe(false);
    if (!classified.approved) {
      expect(classified.code).toBe(APPROVAL_TIMEOUT_CODE);
    }
  });
});
