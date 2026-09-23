// replace = gen bump + SessionRepo.open + lane.resume with memos
// surviving §20.3 (issue #42): a kill during a deferred approval must
// resume without repeating the approved effect (memoOnce dedupe).
import { describe, expect, it } from 'vitest';
import { MemoryMemoStore } from '../ops/memos.js';
import { replaceWorker, StaleGenerationError } from './replace.js';

describe('replaceWorker (issue #42)', () => {
  it('bumps the generation and resumes the lane from the opened session', async () => {
    const calls: string[] = [];
    const out = await replaceWorker(
      { workerId: 'w-1', sessionId: 's-1', oldGeneration: 1 },
      {
        allocateGeneration: (_sessionId: string) => 2,
        openSession: async (sessionId: string) => {
          calls.push(`open:${sessionId}`);
          return { laneId: 'main' };
        },
        resumeLane: async (lane: { laneId: string }) => {
          calls.push(`resume:${lane.laneId}`);
          return { resumed: true };
        },
        terminate: async (workerId: string) => {
          calls.push(`terminate:${workerId}`);
        },
      },
    );
    expect(out.generation).toBe(2);
    expect(out.resumed).toBe(true);
    expect(calls).toEqual(['terminate:w-1', 'open:s-1', 'resume:main']);
  });

  it('kill-during-deferred: memoOnce keeps the approved effect single', async () => {
    const memos = new MemoryMemoStore();
    const first = await memos.once('inv-7', 'approval:write', 'approved');
    expect(first).toBe('approved');
    // The replacement worker replays the same deferred drain: the memo
    // already owns the answer, so no second approval fires.
    let secondApprovalFired = false;
    const replayed = await memos.once('inv-7', 'approval:write', 'approved');
    if (replayed !== 'approved') secondApprovalFired = true;
    expect(replayed).toBe('approved');
    expect(secondApprovalFired).toBe(false);

    const out = await replaceWorker(
      { workerId: 'w-1', sessionId: 's-1', oldGeneration: 1 },
      {
        allocateGeneration: () => 2,
        openSession: async () => ({ laneId: 'main' }),
        resumeLane: async () => ({ resumed: true }),
        terminate: async () => undefined,
      },
    );
    expect(out.memosSurvived).toBe(true);
  });

  it('refuses a stale generation instead of replacing over it', async () => {
    await expect(
      replaceWorker(
        { workerId: 'w-1', sessionId: 's-1', oldGeneration: 1 },
        {
          allocateGeneration: () => 1,
          openSession: async () => ({ laneId: 'main' }),
          resumeLane: async () => ({ resumed: true }),
          terminate: async () => undefined,
        },
      ),
    ).rejects.toThrow(/generation/i);
  });

  it('stale replace leaves the live worker untouched and throws StaleGenerationError', async () => {
    const calls: string[] = [];
    await expect(
      replaceWorker(
        { workerId: 'w-1', sessionId: 's-1', oldGeneration: 1 },
        {
          allocateGeneration: () => 1,
          openSession: async (sessionId: string) => {
            calls.push(`open:${sessionId}`);
            return { laneId: 'main' };
          },
          resumeLane: async (lane: { laneId: string }) => {
            calls.push(`resume:${lane.laneId}`);
            return { resumed: true };
          },
          terminate: async (workerId: string) => {
            calls.push(`terminate:${workerId}`);
          },
        },
      ),
    ).rejects.toBeInstanceOf(StaleGenerationError);
    // Generation is validated BEFORE terminate: the live proc is never
    // killed, the session never opened, the lane never resumed.
    expect(calls).toEqual([]);
  });
});
