// Slice A: approval policy + durable service (issue #16).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalRequest,
  ApprovalService,
  type ApprovalVerdict,
  approvalKey,
  createApprovalAsk,
  detectTriggers,
  enableFullAccess,
  FileApprovalStore,
  MemoryApprovalStore,
  summarizeRequest,
  type TriggerContext,
  validatePolicy,
} from './approvals.js';

function request(key = 'k1'): ApprovalRequest {
  return {
    key,
    capability: 'destructive-shell',
    toolName: 'bash',
    summary: 'rm -rf /tmp/x',
  };
}

function triggerContext(
  overrides: Partial<TriggerContext> = {},
): TriggerContext {
  return {
    workspace: '/work',
    network: 'none',
    isDestructive: (command) => /rm -rf/.test(command),
    isNetworkCommand: (command) => /curl/.test(command),
    isOutsideWorkspace: (path) => path.startsWith('/etc'),
    ...overrides,
  };
}

describe('approval service (issue #16, slice A)', () => {
  it('denies by route without asking', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({ route: 'deny' }),
      awaitAnswer: () => {
        throw new Error('must not ask');
      },
    });
    const verdict = await service.request(request());
    expect(verdict).toEqual({
      approved: false,
      reason: 'denied by policy route (capability: destructive-shell)',
    });
    expect(service.pendingRequests()).toEqual([]);
  });

  it('times out to denial and never hangs headless', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 20 }),
    });
    const verdict = await service.request(request());
    expect(verdict).toEqual({
      approved: false,
      reason: 'approval timed out after 20ms',
    });
    expect(service.pendingRequests()).toEqual([]);
  });

  // Issue #110: a timeout is an unanswered question, not a decision. The
  // call denies (bounded, named) but nothing persists — a missed dialog
  // must not latch a denial that no later surface can overturn.
  it('keeps timeout verdicts transient: no store entry, and a re-ask waits again (issue #110)', async () => {
    const store = new MemoryApprovalStore();
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 20 }),
      store,
    });
    const first = await service.request(request());
    expect(first).toMatchObject({
      approved: false,
      reason: 'approval timed out after 20ms',
    });
    // Not persisted: the decision store and the live map stay empty.
    expect(service.decided(request().key)).toBeUndefined();
    expect(store.load()[request().key]).toBeUndefined();
    // And a second ask for the same key waits the full bound again instead
    // of being short-circuited by a stored timeout denial.
    const start = Date.now();
    const second = await service.request(request());
    const waited = Date.now() - start;
    expect(second).toMatchObject({
      approved: false,
      reason: 'approval timed out after 20ms',
    });
    expect(waited).toBeGreaterThanOrEqual(15);
  });

  it('persists a real answer that arrives on a re-ask after a timeout (issue #110)', async () => {
    let calls = 0;
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 20 }),
      awaitAnswer: () => {
        calls += 1;
        return calls === 1
          ? new Promise<undefined>(() => {})
          : Promise.resolve({ approved: true, by: 'user' } as const);
      },
    });
    const first = await service.request(request());
    expect(first).toMatchObject({
      approved: false,
      reason: 'approval timed out after 20ms',
    });
    // The second ask presents the dialog again and this answer latches.
    const second = await service.request(request());
    expect(second).toEqual({ approved: true, by: 'user', justified: false });
    // First-wins on REAL answers: a third ask is answered from the latch,
    // without reaching the seat again.
    const again = await service.request(request());
    expect(again).toEqual({ approved: true, by: 'user', justified: false });
    expect(calls).toBe(2);
  });

  it('settles racing submits once: first answer wins', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 10_000 }),
      awaitAnswer: () => new Promise(() => {}),
    });
    const pending = service.request(request());
    expect(service.pendingRequests()).toHaveLength(1);
    const first = service.submit(request(), { approved: true, by: 'user' });
    const late = service.submit(request(), {
      approved: false,
      reason: 'changed mind',
    });
    expect(first).toEqual({ approved: true, by: 'user', justified: false });
    expect(late).toEqual({ approved: true, by: 'user', justified: false });
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'user',
      justified: false,
    });
    expect(service.pendingRequests()).toEqual([]);
  });

  it('restores decisions across restart and never re-asks', async () => {
    const store = new MemoryApprovalStore();
    const first = new ApprovalService({ policy: validatePolicy({}), store });
    first.submit(request(), { approved: true, by: 'user' });
    const second = new ApprovalService({
      policy: validatePolicy({}),
      store,
      awaitAnswer: () => {
        throw new Error('must not re-ask');
      },
    });
    await expect(second.request(request())).resolves.toEqual({
      approved: true,
      by: 'user',
      justified: false,
    });
  });

  it('auto-approves only from explicit config', async () => {
    const explicit = new ApprovalService({
      policy: validatePolicy({ autoApprove: ['install'] }),
    });
    await expect(
      explicit.request({ ...request(), capability: 'install' }),
    ).resolves.toEqual({ approved: true, by: 'autoApprove', justified: false });
    const implicit = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 20 }),
    });
    await expect(
      implicit.request({ ...request(), capability: 'install', key: 'k2' }),
    ).resolves.toEqual({
      approved: false,
      reason: 'approval timed out after 20ms',
    });
  });

  it('rejects unjustified approvals when justification is required', () => {
    const service = new ApprovalService({
      policy: validatePolicy({ requireJustification: true }),
    });
    expect(service.submit(request(), { approved: true, by: 'user' })).toEqual({
      approved: false,
      reason: 'approval requires justification',
    });
    expect(
      service.submit(
        { ...request(), justification: 'cleanup tmp' },
        { approved: true, by: 'user' },
      ),
    ).toEqual({ approved: true, by: 'user', justified: true });
  });

  it('rejects malformed policy', () => {
    expect(() => validatePolicy({ route: 'ask-manager' })).toThrow();
    expect(() => validatePolicy({ autoApprove: 'install' })).toThrow();
    expect(() => validatePolicy({ maxPendingMs: -1 })).toThrow();
  });

  it('detects every §41.1 trigger class with a detector', () => {
    const ctx = triggerContext();
    expect(detectTriggers('bash', { command: 'rm -rf /tmp/x' }, ctx)).toEqual([
      'destructive-shell',
    ]);
    expect(
      detectTriggers('bash', { command: 'curl https://x.example' }, ctx),
    ).toEqual(['network']);
    expect(
      detectTriggers('bash', { command: 'git push origin main' }, ctx),
    ).toEqual(['git-push']);
    expect(
      detectTriggers('bash', { command: 'npm install left-pad' }, ctx),
    ).toEqual(['install']);
    expect(
      detectTriggers('bash', { command: 'kubectl apply -f deploy.yaml' }, ctx),
    ).toEqual(['deploy']);
    expect(detectTriggers('write', { path: '/etc/cron.d/x' }, ctx)).toEqual([
      'outside-write',
    ]);
    expect(detectTriggers('read', { path: '/etc/passwd' }, ctx)).toEqual([]);
    expect(
      detectTriggers(
        'bash',
        { command: 'curl https://x.example' },
        triggerContext({ network: 'full' }),
      ),
    ).toEqual([]);
    expect(
      detectTriggers(
        'read',
        { path: 'notes.txt' },
        triggerContext({ budgetOverrun: true }),
      ),
    ).toEqual(['budget-overrun']);
    expect(
      detectTriggers(
        'read',
        { path: 'notes.txt' },
        triggerContext({ requires: ['read'] }),
      ),
    ).toEqual(['requires:read']);
  });

  it('keys approvals stably across restarts and arg order', () => {
    const args = { command: 'rm -rf /tmp/x', timeout: 30 };
    const reordered = { timeout: 30, command: 'rm -rf /tmp/x' };
    expect(approvalKey('bash', 'destructive-shell', args)).toBe(
      approvalKey('bash', 'destructive-shell', reordered),
    );
    expect(approvalKey('bash', 'destructive-shell', args)).not.toBe(
      approvalKey('bash', 'network', args),
    );
    expect(summarizeRequest('bash', 'destructive-shell', args)).toContain(
      'rm -rf /tmp/x',
    );
  });

  it('raises approval for each trigger without it (negative path)', async () => {
    const ctx = triggerContext();
    // Without an answer, every trigger denies on timeout — the run fails
    // per policy instead of executing.
    for (const [tool, args] of [
      ['bash', { command: 'rm -rf /tmp/x' }],
      ['bash', { command: 'git push origin main' }],
      ['write', { path: '/etc/cron.d/x' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const capabilities = detectTriggers(tool, args, ctx);
      expect(capabilities).not.toHaveLength(0);
      for (const capability of capabilities) {
        const service = new ApprovalService({
          policy: validatePolicy({ maxPendingMs: 10 }),
        });
        const verdict = await service.request({
          key: approvalKey(tool, capability, args),
          capability,
          toolName: tool,
          summary: summarizeRequest(tool, capability, args),
        });
        expect(verdict.approved).toBe(false);
      }
    }
  });
});

describe('approval adapter, file store, posture (issue #16, slice D)', () => {
  it('passes non-triggered calls without touching the service', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 10 }),
      awaitAnswer: () => {
        throw new Error('must not ask');
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'approvals-'));
    const ask = createApprovalAsk(
      service,
      triggerContext(),
      new FileApprovalStore(dir),
    );
    await expect(
      ask({ toolName: 'read', args: { path: 'notes.txt' }, toolCallId: 'c1' }),
    ).resolves.toEqual({ approved: true, challenged: false });
  });

  it('denies triggered calls headless and approves on answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approvals-'));
    const store = new FileApprovalStore(dir);
    const denied = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 10 }),
      store,
    });
    const askDenied = createApprovalAsk(denied, triggerContext(), store);
    const verdict = await askDenied({
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/x' },
      toolCallId: 'c1',
    });
    expect(verdict.approved).toBe(false);

    const approved = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 5_000 }),
      store,
      // The seat presents the dialog and waits; the answer arrives below
      // via submit() exactly as a surface delivers it (the waiter path).
      // (Previously this seat resolved undefined immediately and the ask
      // was answered through the timeout-denial's latch — the backdoor
      // issue #110 closed.)
      awaitAnswer: () => new Promise<ApprovalVerdict | undefined>(() => {}),
    });
    const askApproved = createApprovalAsk(approved, triggerContext(), store);
    const pending = askApproved({
      toolName: 'bash',
      args: { command: 'git push origin main' },
      toolCallId: 'c2',
    });
    const key = approvalKey('bash', 'git-push', {
      command: 'git push origin main',
    });
    approved.submit(
      { key, capability: 'git-push', toolName: 'bash', summary: 'push' },
      { approved: true, by: 'user' },
    );
    await expect(pending).resolves.toEqual({
      approved: true,
      challenged: true,
    });
  });

  it('persists decisions and posture across restarts; fresh dirs start safe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approvals-'));
    const first = new FileApprovalStore(dir);
    expect(first.loadPosture()).toEqual({ fullAccess: false });
    const service = new ApprovalService({
      policy: validatePolicy({}),
      store: first,
    });
    service.submit(
      { key: 'k', capability: 'install', toolName: 'bash', summary: 'npm i' },
      { approved: true, by: 'user' },
    );
    enableFullAccess(first, 'cli', () => 1700000000000);
    const second = new FileApprovalStore(dir);
    expect(second.load().k).toEqual({
      approved: true,
      by: 'user',
      justified: false,
    });
    expect(second.loadPosture()).toEqual({
      fullAccess: true,
      enabledAt: 1700000000000,
      enabledBy: 'cli',
    });
    const fresh = new FileApprovalStore(
      mkdtempSync(join(tmpdir(), 'approvals-')),
    );
    expect(fresh.load()).toEqual({});
    expect(fresh.loadPosture()).toEqual({ fullAccess: false });
  });

  it('tolerates corrupt files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'approvals-'));
    writeFileSync(join(dir, 'approvals.json'), '{torn');
    writeFileSync(join(dir, 'posture.json'), '[torn');
    const store = new FileApprovalStore(dir);
    expect(store.load()).toEqual({});
    expect(store.loadPosture()).toEqual({ fullAccess: false });
  });

  it('detects shell-redirection outside-writes and redacts summaries', () => {
    const ctx = triggerContext();
    expect(
      detectTriggers('bash', { command: 'echo x > /etc/cron.d/x' }, ctx),
    ).toEqual(['outside-write']);
    expect(
      detectTriggers('bash', { command: 'echo x > "/etc/cron.d/x"; id' }, ctx),
    ).toEqual(['outside-write']);
    expect(
      detectTriggers('bash', { command: "echo hi > 'notes.txt'" }, ctx),
    ).toEqual([]);
    expect(
      summarizeRequest('bash', 'network', { command: 'curl --token abc123 x' }),
    ).not.toContain('abc123');
  });

  it('holds autoApprove to the justification requirement', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({
        autoApprove: ['install'],
        requireJustification: true,
      }),
    });
    await expect(
      service.request({
        key: 'j1',
        capability: 'install',
        toolName: 'bash',
        summary: 'npm i',
      }),
    ).resolves.toEqual({
      approved: false,
      reason: 'approval requires justification',
    });
    await expect(
      service.request({
        key: 'j2',
        capability: 'install',
        toolName: 'bash',
        summary: 'npm i',
        justification: 'deps for build',
      }),
    ).resolves.toEqual({ approved: true, by: 'autoApprove', justified: true });
  });

  it('evicts stored approvals when the policy tightens to require justification', async () => {
    const store = new MemoryApprovalStore();
    const granted = new ApprovalService({
      policy: validatePolicy({ route: 'ask-user' }),
      store,
    });
    const req = {
      key: 't1',
      capability: 'install' as const,
      toolName: 'bash',
      summary: 'npm i',
    };
    granted.submit(req, { approved: true, by: 'user' });
    expect(granted.decided('t1')?.approved).toBe(true);
    const tight = new ApprovalService({
      policy: validatePolicy({
        route: 'ask-user',
        requireJustification: true,
        maxPendingMs: 10,
      }),
      store,
    });
    await expect(tight.request(req)).resolves.toEqual({
      approved: false,
      reason: expect.stringContaining('timed out'),
    });
  });
});
