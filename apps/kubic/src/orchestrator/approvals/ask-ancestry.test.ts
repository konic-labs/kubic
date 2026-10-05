// Worker-ask ancestry (issue #159; §23, §60).
//
// Three identities were conflated on the delegation path: the child was told
// the orchestrator session's env var while the value in it was its OWN session
// (`<orch>-<agent>`), the ask published `sessionId` = the agent id, and the
// role was hardcoded `worker`. `kubic audit` therefore could not attribute a
// worker's decision to the run that spawned it or to the role that asked.
// What the three surfaces must now agree on:
//
//   env    KUBIC_ORCHESTRATOR_SESSION = the orchestration session (`orch-9`)
//          KUBIC_WORKER_SESSION       = the worker's own session
//                                       (`orch-9-worker-1`)
//   ask    request.sessionId           = `orch-9-worker-1`
//          request.agentId             = `worker-1`
//          request.role                = the assigned role (`implementer`)
//          provenance.parentSessionId  = `orch-9`
//   ledger agent.session / role / parent and worker.role follow the ask.
//
// Faux provider only: no network, no paid tokens. Temp dirs are removed in
// afterEach; nothing here talks to the real mailbox.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../../../packages/exec/src/env.js';
import { createApprovalSigner } from '../../../../../packages/host/src/orchestrator/approvals/seal.js';
import {
  answerWorkerAsk,
  createOrchestratorApprovalsRun,
  createWorkerMailboxSeat,
  publishWorkerAsk,
  readPendingWorkerAsks,
  type WorkerApprovalScope,
} from '../../../../../packages/host/src/orchestrator/approvals/worker-asks.js';
import {
  auditLedgerDir,
  readAuditLedger,
} from '../../../../../packages/host/src/policy/audit-ledger.js';
import { fauxToolUse } from '../../../../../packages/worker/src/lane/test-harness.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '../../../../../packages/worker/src/pi-boundary.js';
import { runHeadlessPrompt } from '../../headless-run.js';

const made: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-159-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The child's env as `kubic orchestrate` sets it (issue #159): the worker's
// own session in KUBIC_WORKER_SESSION, the orchestration's in
// KUBIC_ORCHESTRATOR_SESSION.
function workerEnv(): void {
  vi.stubEnv('KUBIC_WORKER_ID', 'worker-1');
  vi.stubEnv('KUBIC_WORKER_SESSION', 'orch-9-worker-1');
  vi.stubEnv('KUBIC_ORCHESTRATOR_SESSION', 'orch-9');
}

const lane = {
  key: 'lane-key',
  capability: 'outside-write',
  toolName: 'bash',
  summary: 'bash: echo x > /etc/y',
};

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

const DESTRUCTIVE = (): FauxMessage =>
  fauxToolUse([fauxToolCall('bash', { command: 'rm -rf /tmp/x' })]);

function catalog(steps: FauxMessage[]): MutableModels {
  const faux = fauxProvider({
    provider: 'faux',
    models: [{ id: 'big', contextWindow: 200000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(steps);
  return models;
}

const IMPLEMENTER_ROLE = `---
role: implementer

tools: [read, ls, find, grep, write, edit, bash]
filesystem: workspace-write
shell: true
network: none
git: false
credentials: none
---

# implementer

## Prompt

You are the implementer.
`;

describe('the ask names the worker, the orchestrator and the role (issue #159)', () => {
  it('publishes the worker session, the orchestrator as parent, and the assigned role', async () => {
    workerEnv();
    const dir = tmpDir();
    const signer = createApprovalSigner();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 500,
      pollMs: 5,
      verifyKey: signer.verifyKey,
      role: 'implementer',
    });
    const verdict = seat(lane);
    const [published] = readPendingWorkerAsks(dir, {
      verifyKey: signer.verifyKey,
    });
    if (published === undefined) throw new Error('no ask published');
    expect(published.request.sessionId).toBe('orch-9-worker-1');
    expect(published.request.agentId).toBe('worker-1');
    expect(published.request.role).toBe('implementer');
    expect(published.request.provenance.parentSessionId).toBe('orch-9');
    // Settle the seat so no timer outlives the test.
    answerWorkerAsk(
      dir,
      published,
      { approved: false, reason: 'ancestry probe done' },
      signer,
    );
    await expect(verdict).resolves.toMatchObject({ approved: false });
  });

  it('defaults the role to `worker` when the child runs without one', async () => {
    workerEnv();
    const dir = tmpDir();
    const signer = createApprovalSigner();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 500,
      pollMs: 5,
      verifyKey: signer.verifyKey,
    });
    const verdict = seat(lane);
    const [published] = readPendingWorkerAsks(dir, {
      verifyKey: signer.verifyKey,
    });
    if (published === undefined) throw new Error('no ask published');
    expect(published.request.role).toBe('worker');
    answerWorkerAsk(
      dir,
      published,
      { approved: false, reason: 'ancestry probe done' },
      signer,
    );
    await verdict;
  });
});

describe("the manager's §60 row carries that ancestry (issue #159)", () => {
  it("records session '<orch>-<agent>', parent '<orch>', role 'implementer'", async () => {
    workerEnv();
    const repo = tmpDir();
    const home = tmpDir();
    const run = createOrchestratorApprovalsRun({
      dir: join(repo, '.kubic', 'orchestrator'),
      sessionId: 'orch-9',
      maxPendingMs: 1_000,
      pollMs: 5,
      home,
      seat: async () => ({ approved: true, by: 'user' }),
    });
    const seat = createWorkerMailboxSeat({
      dir: run.mailboxDir(),
      maxPendingMs: 500,
      pollMs: 5,
      verifyKey: run.verifyKey(),
      role: 'implementer',
    });
    const verdict = seat(lane);
    // The manager pumps its own worker; the seat's ask is answered.
    const scope: WorkerApprovalScope = {
      sessionId: 'orch-9',
      agentId: 'worker-1',
      worktree: '/wt/worker-1',
      role: 'implementer',
    };
    await expect(run.pump(scope)).resolves.toBeUndefined();
    await expect(verdict).resolves.toEqual({ approved: true, by: 'user' });

    const row = readAuditLedger(auditLedgerDir(repo)).find(
      (record) => record.what === 'tool:bash',
    );
    expect(row).toMatchObject({
      agent: {
        session: 'orch-9-worker-1',
        role: 'implementer',
        parent: 'orch-9',
      },
      worker: { role: 'implementer' },
      mode: 'orchestrator',
    });
  });

  it('the headless lane attaches the seat with the --role it booted with', async () => {
    // The full child chain: `kubic run --role implementer` in a worker
    // environment publishes an ask whose ancestry is the run that spawned it.
    workerEnv();
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    const mailbox = tmpDir();
    const signer = createApprovalSigner();
    vi.stubEnv('KUBIC_APPROVALS_DIR', mailbox);
    vi.stubEnv('KUBIC_APPROVALS_VERIFY_KEY', signer.verifyKey);
    vi.stubEnv('KUBIC_APPROVALS_BOUND_MS', '2_000');
    const workspace = tmpDir();
    const rolesDir = join(workspace, '.kubic', 'roles');
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(join(rolesDir, 'implementer.md'), IMPLEMENTER_ROLE);
    const running = runHeadlessPrompt(
      'clean up',
      { role: 'implementer' },
      {
        sessionsRoot: tmpDir(),
        models: catalog([DESTRUCTIVE(), fauxAssistantMessage('done')]),
        env: new NodeExecutionEnv(workspace),
        modelsCwd: workspace,
        skills: { cwd: workspace, homeDir: workspace, trusted: false },
        roles: { cwd: workspace },
        notice: () => undefined,
      },
    );
    // This test IS the manager here: pick the published ask up and answer it.
    // (Reading it only afterwards would not work: a bound that elapses
    // withdraws the ask — issue #232 — and a real answer is what the child
    // waits for anyway.)
    let published = readPendingWorkerAsks(mailbox, {
      verifyKey: signer.verifyKey,
    })[0];
    // A generous waiter (review finding 4): the lane has to reach the
    // challenged call before the seat's own bound (2s) elapses, and a loaded
    // machine must not turn that race into a red test. The bound only decides
    // when the wait ENDS; the waiter's patience is separate.
    for (
      let attempt = 0;
      published === undefined && attempt < 3_000;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      published = readPendingWorkerAsks(mailbox, {
        verifyKey: signer.verifyKey,
      })[0];
    }
    if (published === undefined) throw new Error('no ask published');
    expect(published.request.sessionId).toBe('orch-9-worker-1');
    expect(published.request.agentId).toBe('worker-1');
    expect(published.request.role).toBe('implementer');
    expect(published.request.provenance.parentSessionId).toBe('orch-9');
    answerWorkerAsk(
      mailbox,
      published,
      { approved: false, reason: 'the test denied it' },
      signer,
    );
    const result = await running;
    expect(result.terminus).not.toBe('completed');
  });
});

describe('a blank identity env var is absent, never an empty id (issue #159 review)', () => {
  it('falls back to the worker id instead of throwing on an empty session', async () => {
    vi.stubEnv('KUBIC_WORKER_ID', 'worker-1');
    vi.stubEnv('KUBIC_WORKER_SESSION', '   ');
    vi.stubEnv('KUBIC_ORCHESTRATOR_SESSION', '');
    const dir = tmpDir();
    const signer = createApprovalSigner();
    const seat = createWorkerMailboxSeat({
      dir,
      maxPendingMs: 500,
      pollMs: 5,
      verifyKey: signer.verifyKey,
      role: 'implementer',
    });
    const verdict = seat(lane);
    const [published] = readPendingWorkerAsks(dir, {
      verifyKey: signer.verifyKey,
    });
    if (published === undefined) throw new Error('no ask published');
    // The blank session falls back to the worker id; the blank parent to the
    // documented default (a thrown buildOrchestratorRequest here was the bug).
    expect(published.request.sessionId).toBe('worker-1');
    expect(published.request.provenance.parentSessionId).toBe('orchestrator');
    answerWorkerAsk(
      dir,
      published,
      { approved: false, reason: 'blank-env probe done' },
      signer,
    );
    await verdict;
  });
});

describe('publishWorkerAsk keeps whatever it was handed (issue #159)', () => {
  it('carries the caller identity verbatim — the seat is what derives it', () => {
    const dir = tmpDir();
    const published = publishWorkerAsk(dir, {
      trigger: 'network',
      toolName: 'bash',
      args: { command: 'curl https://example.com' },
      justification: 'need the release tarball for the plan step',
      sessionId: 'orch-9-worker-1',
      agentId: 'worker-1',
      role: 'implementer',
      worktree: '/wt/worker-1',
      provenance: { parentSessionId: 'orch-9' },
    });
    expect(published.request.sessionId).toBe('orch-9-worker-1');
    expect(published.request.role).toBe('implementer');
    expect(published.request.provenance.parentSessionId).toBe('orch-9');
  });
});
