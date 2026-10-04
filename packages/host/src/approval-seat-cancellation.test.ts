// The worker mailbox seat's cancellation (issue #232; §41.2). A worker child
// whose bound expires used to keep polling its mailbox for as long as its own
// bound allowed — leaving a question in the manager's mailbox that the child
// had already given up on. The seat now stops polling (the service's
// AbortSignal, or its own bound) and withdraws the ask it published, and the
// child's service bound is pinned to the seat's bound.
//
// (The service/surface half of this issue lives in
// apps/kubic/src/approval-seat-cancellation.test.ts: only the composition root
// may import both packages — `npm run lint:deps` forbids host -> tui.)
//
// Fake timers, faux provider/fakes only, every temp dir removed in
// `afterEach` — no network, no paid tokens.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { NodeExecutionEnv } from '../../exec/src/env.js';
import { fauxToolUse } from '../../worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../worker/src/pi-boundary.js';
import { createApprovalSigner } from './orchestrator/approvals/seal.js';
import {
  ASKS_DIR,
  awaitWorkerAskAnswer,
  createWorkerMailboxSeat,
  publishWorkerAsk,
  readPendingWorkerAsks,
} from './orchestrator/approvals/worker-asks.js';
import { auditLedgerDir, readAuditLedger } from './policy/audit-ledger.js';

const made: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-232-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

const DESTRUCTIVE = (): FauxMessage =>
  fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]);

function catalog(steps: FauxMessage[]) {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'big', contextWindow: 200000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

describe('an aborted mailbox seat stops polling and withdraws its ask (issue #232)', () => {
  it('denies, leaves no timer behind, and removes the ask it published', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KUBIC_WORKER_ID', 'worker-1');
    vi.stubEnv('KUBIC_WORKER_SESSION', 'orch-9-worker-1');
    vi.stubEnv('KUBIC_ORCHESTRATOR_SESSION', 'orch-9');
    const dir = tmpDir();
    const signer = createApprovalSigner();
    const controller = new AbortController();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 600_000,
      pollMs: 25,
      verifyKey: signer.verifyKey,
      role: 'worker',
    });
    const verdict = seat(
      {
        key: 'lane-key',
        capability: 'outside-write',
        toolName: 'bash',
        summary: 'bash: echo x > /etc/y',
      },
      controller.signal,
    );
    const [published] = readPendingWorkerAsks(dir, {
      verifyKey: signer.verifyKey,
    });
    if (published === undefined) throw new Error('no ask published');

    controller.abort();

    await expect(verdict).resolves.toMatchObject({ approved: false });
    // No poll timer survives the abort…
    expect(vi.getTimerCount()).toBe(0);
    // …and the question is withdrawn, so the manager never routes an ask whose
    // asker has already given up.
    expect(
      existsSync(join(dir, ASKS_DIR, `${published.request.key}.json`)),
    ).toBe(false);
    expect(readPendingWorkerAsks(dir, { verifyKey: signer.verifyKey })).toEqual(
      [],
    );
  });

  it('the bounded wait still denies on its own bound, and withdraws too', async () => {
    vi.useFakeTimers();
    vi.stubEnv('KUBIC_WORKER_ID', 'worker-1');
    const dir = tmpDir();
    const signer = createApprovalSigner();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 100,
      pollMs: 25,
      verifyKey: signer.verifyKey,
    });
    const verdict = seat({
      key: 'lane-key',
      capability: 'outside-write',
      toolName: 'bash',
      summary: 'bash: echo x > /etc/y',
    });
    await vi.advanceTimersByTimeAsync(150);
    await expect(verdict).resolves.toMatchObject({ approved: false });
    expect(readPendingWorkerAsks(dir, { verifyKey: signer.verifyKey })).toEqual(
      [],
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the worker child's service bound is the seat's bound (AC4)", async () => {
    // The prod lane (headless-run) takes the mailbox seat's bound
    // (KUBIC_APPROVALS_BOUND_MS) and hands the SAME number to the installed
    // policy, so the bound that denies the call is the bound that withdraws the
    // question. Pinned through the child's own §60 row: the denial reason names
    // the bound the SERVICE used — the seat's 150ms, never the configured 1s.
    vi.useRealTimers();
    const signer = createApprovalSigner();
    const mailbox = tmpDir();
    const workspace = tmpDir();
    vi.stubEnv('KUBIC_APPROVALS_DIR', mailbox);
    vi.stubEnv('KUBIC_APPROVALS_VERIFY_KEY', signer.verifyKey);
    vi.stubEnv('KUBIC_APPROVALS_BOUND_MS', '150');
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    const result = await runHeadlessPrompt(
      'clean up',
      {},
      {
        sessionsRoot: tmpDir(),
        models: catalog([DESTRUCTIVE(), fauxAssistantMessage('done')]),
        env: new NodeExecutionEnv(workspace),
        modelsCwd: workspace,
        skills: { cwd: workspace, homeDir: workspace, trusted: false },
        roles: { cwd: workspace },
        notice: () => undefined,
        // The configured bound is LONGER: without the seat's bound winning,
        // the service would deny at 1s and the row below would say 1000ms.
        approvals: { maxPendingMs: 1_000 },
      },
    );
    expect(result.terminus).not.toBe('completed');
    const row = readAuditLedger(auditLedgerDir(workspace)).find(
      (record) => record.what === 'tool:bash',
    );
    expect(row?.reason).toContain('after 150ms');
  });

  it('awaitWorkerAskAnswer resolves at once for an already-aborted signal', async () => {
    const dir = tmpDir();
    const signer = createApprovalSigner();
    const published = publishWorkerAsk(dir, {
      trigger: 'outside-write',
      toolName: 'bash',
      args: { command: 'echo x > /etc/y' },
      justification: 'configure the service for the release',
      sessionId: 'orch-9-worker-1',
      agentId: 'worker-1',
      role: 'worker',
      worktree: '/wt/worker-1',
      provenance: { parentSessionId: 'orch-9' },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      awaitWorkerAskAnswer(dir, published.request.key, {
        maxPendingMs: 600_000,
        pollMs: 25,
        verifyKey: signer.verifyKey,
        nonce: published.nonce,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ approved: false });
    expect(
      existsSync(join(dir, ASKS_DIR, `${published.request.key}.json`)),
    ).toBe(false);
  });
});
