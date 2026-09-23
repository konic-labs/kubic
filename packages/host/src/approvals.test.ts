// Slice A: approval policy + durable service (issue #16).
import { describe, expect, it } from 'vitest';
import {
  ApprovalService,
  MemoryApprovalStore,
  validatePolicy,
  type ApprovalRequest,
} from './approvals.js';

function request(key = 'k1'): ApprovalRequest {
  return { key, capability: 'destructive-shell', toolName: 'bash', summary: 'rm -rf /tmp/x' };
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
    expect(verdict).toEqual({ approved: false, reason: 'approval timed out after 20ms' });
    expect(service.pendingRequests()).toEqual([]);
  });

  it('settles racing submits once: first answer wins', async () => {
    const service = new ApprovalService({
      policy: validatePolicy({ maxPendingMs: 10_000 }),
      awaitAnswer: () => new Promise(() => {}),
    });
    const pending = service.request(request());
    expect(service.pendingRequests()).toHaveLength(1);
    const first = service.submit(request(), { approved: true, by: 'user' });
    const late = service.submit(request(), { approved: false, reason: 'changed mind' });
    expect(first).toEqual({ approved: true, by: 'user' });
    expect(late).toEqual({ approved: true, by: 'user' });
    await expect(pending).resolves.toEqual({ approved: true, by: 'user' });
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
    await expect(second.request(request())).resolves.toEqual({ approved: true, by: 'user' });
  });

  it('auto-approves only from explicit config', async () => {
    const explicit = new ApprovalService({
      policy: validatePolicy({ autoApprove: ['install'] }),
    });
    await expect(
      explicit.request({ ...request(), capability: 'install' }),
    ).resolves.toEqual({ approved: true, by: 'autoApprove' });
    const implicit = new ApprovalService({ policy: validatePolicy({ maxPendingMs: 20 }) });
    await expect(
      implicit.request({ ...request(), capability: 'install', key: 'k2' }),
    ).resolves.toEqual({ approved: false, reason: 'approval timed out after 20ms' });
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
      service.submit({ ...request(), justification: 'cleanup tmp' }, { approved: true, by: 'user' }),
    ).toEqual({ approved: true, by: 'user' });
  });

  it('rejects malformed policy', () => {
    expect(() => validatePolicy({ route: 'ask-manager' })).toThrow();
    expect(() => validatePolicy({ autoApprove: 'install' })).toThrow();
    expect(() => validatePolicy({ maxPendingMs: -1 })).toThrow();
  });
});
