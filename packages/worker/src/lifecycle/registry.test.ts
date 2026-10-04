// In-memory worker registry (issue #42): the host `workers` CLI reads
// live procs (age/owner/resources §50) from here — no filesystem, no
// network, clock injected so age is deterministic in tests.
import { describe, expect, it } from 'vitest';
import { WorkerRegistry } from './registry.js';

function registry() {
  let now = 100_000;
  const reg = new WorkerRegistry(() => now);
  return { reg, advance: (ms: number) => (now += ms) };
}

describe('worker registry (issue #42)', () => {
  it('registers a worker as created and reports age from the clock', () => {
    const { reg, advance } = registry();
    reg.register({
      workerId: 'w-1',
      sessionId: 's-1',
      generation: 1,
      owner: 'parent-session',
    });
    advance(5_000);
    const row = reg.get('w-1');
    expect(row?.status).toBe('spawning');
    expect(row?.agentStatus).toBe('starting');
    expect(row?.ageMs).toBe(5_000);
  });

  it('bumps generation on replace and keeps the owner', () => {
    const { reg } = registry();
    reg.register({
      workerId: 'w-1',
      sessionId: 's-1',
      generation: 1,
      owner: 'parent-session',
    });
    const next = reg.replace('w-1');
    expect(next.generation).toBe(2);
    expect(next.owner).toBe('parent-session');
    expect(reg.get('w-1')?.generation).toBe(2);
  });

  it('replace with a wrong expected generation refuses without bumping', () => {
    const { reg } = registry();
    reg.register({
      workerId: 'w-1',
      sessionId: 's-1',
      generation: 1,
      owner: 'parent-session',
    });
    expect(() => reg.replace('w-1', 99)).toThrow(/generation/i);
    // CAS refusal leaves the live row untouched: no bump, no reset.
    expect(reg.get('w-1')?.generation).toBe(1);
    expect(reg.get('w-1')?.status).toBe('spawning');
    // Matching expectation still bumps.
    expect(reg.replace('w-1', 1).generation).toBe(2);
  });

  it('lists rows carrying age/owner/resources for `kubic workers`', () => {
    const { reg, advance } = registry();
    reg.register({
      workerId: 'w-1',
      sessionId: 's-1',
      generation: 1,
      owner: 'parent-session',
      resources: { skills: ['review'] },
      pid: 4242,
    });
    advance(1_000);
    const rows = reg.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workerId: 'w-1',
      owner: 'parent-session',
      pid: 4242,
      ageMs: 1_000,
    });
    expect(rows[0]?.resources).toEqual({ skills: ['review'] });
  });

  it('names the failure a worker settled on, for `kubic workers` (issue #163)', () => {
    const { reg } = registry();
    reg.register({
      workerId: 'w-1',
      sessionId: 's-1',
      generation: 1,
      owner: 'o',
    });
    expect(reg.get('w-1')?.failure).toBeUndefined();
    reg.recordFailure('w-1', {
      code: 'resource_disk_exceeded',
      message: "worker 'w-1' exceeded its worktree disk quota",
    });
    expect(reg.get('w-1')?.failure).toEqual({
      code: 'resource_disk_exceeded',
      message: "worker 'w-1' exceeded its worktree disk quota",
    });
    expect(() =>
      reg.recordFailure('nope', { code: 'x', message: 'y' }),
    ).toThrow(/unknown worker/);
  });

  it('drops a reaped worker exactly once', () => {
    const { reg } = registry();
    reg.register({
      workerId: 'w-1',
      sessionId: 's-1',
      generation: 1,
      owner: 'o',
    });
    expect(reg.remove('w-1')).toBe(true);
    expect(reg.remove('w-1')).toBe(false);
    expect(reg.get('w-1')).toBeUndefined();
  });
});
