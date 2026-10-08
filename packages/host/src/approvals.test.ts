// Approval policy + durable service.
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ApprovalRequest,
  ApprovalService,
  approvalKey,
  detectTriggers,
  enableFullAccess,
  FileApprovalStore,
  installSoloPolicy,
  MemoryApprovalStore,
  summarizeRequest,
  type TriggerContext,
  validatePolicy,
} from './approvals.js';

const made: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

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

describe('approval service', () => {
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

  // A timeout is an unanswered question, not a decision. The
  // call denies (bounded, named) but nothing persists — a missed dialog
  // must not latch a denial that no later surface can overturn.
  it('keeps timeout verdicts transient: no store entry, and a re-ask waits again', async () => {
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

  it('persists a real answer that arrives on a re-ask after a timeout', async () => {
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

  it('a failing surface rejects the request and leaves nothing pending', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 10_000 }),
      awaitAnswer: () => Promise.reject(new Error('seat unavailable')),
    });
    await expect(service.request(request())).rejects.toThrow(
      'seat unavailable',
    );
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

  it('detects every trigger class with a detector', () => {
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
    // An allowlist with no domains allows nothing — never the
    // silent unrestricted network.
    expect(
      detectTriggers(
        'bash',
        { command: 'curl https://x' },
        triggerContext({ network: 'allowlist' }),
      ),
    ).toEqual(['network']);
    expect(
      detectTriggers(
        'bash',
        { command: 'echo $(curl https://x)' },
        triggerContext({ network: 'allowlist' }),
      ),
    ).toEqual(['network']);
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

describe('approval adapter, file store, posture', () => {
  it('passes non-triggered calls without asking the seat', async () => {
    const dir = mkTmp('approvals-');
    const installed = installSoloPolicy({
      workspace: dir,
      sessionDir: dir,
      answer: () => {
        throw new Error('must not ask');
      },
    });
    await expect(
      installed.ask({
        toolName: 'read',
        args: { path: 'notes.txt' },
        toolCallId: 'c1',
      }),
    ).resolves.toEqual({ approved: true, challenged: false });
  });

  it('denies triggered calls headless and approves on answer', async () => {
    const dir = mkTmp('approvals-');
    const headless = installSoloPolicy({
      workspace: dir,
      sessionDir: dir,
      maxPendingMs: 10,
    });
    const verdict = await headless.ask({
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/x' },
      toolCallId: 'c1',
    });
    expect(verdict.approved).toBe(false);

    // The seat presents the dialog and its verdict arrives as the answer.
    const seated = installSoloPolicy({
      workspace: dir,
      sessionDir: dir,
      maxPendingMs: 5_000,
      answer: async () => ({ approved: true, by: 'user' }),
    });
    await expect(
      seated.ask({
        toolName: 'bash',
        args: { command: 'git push origin main' },
        toolCallId: 'c2',
      }),
    ).resolves.toEqual({ approved: true, challenged: true });
  });

  it('persists decisions and posture across restarts; fresh dirs start safe', async () => {
    const dir = mkTmp('approvals-');
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
    const fresh = new FileApprovalStore(mkTmp('approvals-'));
    expect(fresh.load()).toEqual({});
    expect(fresh.loadPosture()).toEqual({ fullAccess: false });
  });

  it('tolerates corrupt files', async () => {
    const dir = mkTmp('approvals-');
    writeFileSync(join(dir, 'approvals.json'), '{torn');
    writeFileSync(join(dir, 'posture.json'), '[torn');
    const store = new FileApprovalStore(dir);
    expect(store.load()).toEqual({});
    expect(store.loadPosture()).toEqual({ fullAccess: false });
  });

  // A state file that PARSES but is the wrong shape must never be cast and
  // then crash the boot (`Object.entries(null)` in the service
  // constructor, `.fullAccess` on null in installedPolicyPosture). Load is
  // corrupt-tolerant by contract — the fallback is the documented safe
  // default, and malformed individual entries are dropped, not the file.
  it('tolerates well-formed JSON of the wrong shape', () => {
    const dir = mkTmp('approvals-');
    const store = new FileApprovalStore(dir);
    for (const text of ['null', '[]', '"x"', '3', 'true']) {
      writeFileSync(join(dir, 'approvals.json'), text);
      expect(store.load(), text).toEqual({});
      writeFileSync(join(dir, 'posture.json'), text);
      expect(store.loadPosture(), text).toEqual({ fullAccess: false });
    }
    writeFileSync(join(dir, 'posture.json'), '{"fullAccess":"yes"}');
    expect(store.loadPosture()).toEqual({ fullAccess: false });
    // A real grant survives; a malformed optional field falls back to the
    // safe side (no fabricated enable time).
    writeFileSync(
      join(dir, 'posture.json'),
      JSON.stringify({ fullAccess: true, enabledAt: 'soon', enabledBy: 'cli' }),
    );
    expect(store.loadPosture()).toEqual({ fullAccess: true, enabledBy: 'cli' });
  });

  it('drops malformed verdict entries and keeps the valid ones', () => {
    const dir = mkTmp('approvals-');
    writeFileSync(
      join(dir, 'approvals.json'),
      JSON.stringify({
        good: { approved: true, by: 'user' },
        goodDeny: { approved: false, reason: 'no' },
        noBy: { approved: true },
        noReason: { approved: false },
        notObject: 'x',
        nullEntry: null,
        arrayEntry: [],
        weirdApproved: { approved: 'yes', by: 'user' },
      }),
    );
    expect(new FileApprovalStore(dir).load()).toEqual({
      good: { approved: true, by: 'user' },
      goodDeny: { approved: false, reason: 'no' },
    });
  });

  it('boots a policy and a service over wrong-shaped state files', () => {
    const workspace = mkTmp('approvals-ws-');
    const sessionDir = mkTmp('approvals-session-');
    writeFileSync(join(sessionDir, 'approvals.json'), 'null');
    writeFileSync(join(sessionDir, 'posture.json'), '{"fullAccess":"yes"}');
    const installed = installSoloPolicy({ workspace, sessionDir });
    expect(installed.posture.fullAccess).toBe(false);
    expect(installed.approvalsSkipped()).toBe(false);
    // The service reads the same store at construction (Object.entries(null)
    // must not throw there).
    expect(
      () =>
        new ApprovalService({
          policy: validatePolicy({}),
          store: new FileApprovalStore(sessionDir),
        }),
    ).not.toThrow();
  });

  it('cleans its tmp file when a posture rename fails, and rethrows', () => {
    const dir = mkTmp('approvals-');
    // A rename failure reachable without mocks: the destination exists as
    // a DIRECTORY, so the tmp write succeeds and rename(tmp, posture.json)
    // fails (EISDIR) — the disk-full/permission shape the cleanup exists
    // for. save() already cleaned up on this path; savePosture must mirror
    // it instead of stranding `posture.json.<pid>.tmp` beside the session.
    mkdirSync(join(dir, 'posture.json'));
    const store = new FileApprovalStore(dir);
    let caught: unknown;
    try {
      store.savePosture({ fullAccess: true });
    } catch (error) {
      caught = error;
    }
    // Both halves: the original failure surfaces…
    expect(caught).toBeInstanceOf(Error);
    expect((caught as NodeJS.ErrnoException).code).toBe('EISDIR');
    // …and no tmp file is stranded beside the posture file.
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
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

describe('approval policy maxPendingMs bound', () => {
  it('refuses a non-positive or non-numeric maxPendingMs when the policy loads', () => {
    for (const maxPendingMs of [Number.NaN, 0, -1]) {
      expect(() => validatePolicy({ maxPendingMs })).toThrow(
        'maxPendingMs must be a positive number',
      );
    }
  });
});
