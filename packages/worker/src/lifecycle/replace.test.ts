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
    // Generation 1 answers the deferred approval, then dies.
    const first = await memos.once('inv-7', 'approval:write', 'approved-gen-1');
    expect(first).toBe('approved-gen-1');
    // The replacement worker's resumed lane replays the same deferred
    // drain with a fresh candidate: the memo already owns the answer, so
    // the second approval never takes effect.
    const replayed: unknown[] = [];
    const out = await replaceWorker(
      { workerId: 'w-1', sessionId: 's-1', oldGeneration: 1 },
      {
        allocateGeneration: () => 2,
        openSession: async () => ({ laneId: 'main' }),
        resumeLane: async () => {
          replayed.push(
            await memos.once('inv-7', 'approval:write', 'approved-gen-2'),
          );
          return { resumed: true };
        },
        terminate: async () => undefined,
      },
    );
    expect(replayed).toEqual(['approved-gen-1']);
    expect(out.generation).toBe(2);
    // Issue #153: memo survival rides the durable task record, not a
    // Kubic field — the outcome carries no memos flag.
    expect(out).not.toHaveProperty('memosSurvived');
  });

  it('stale replace leaves the live worker untouched and throws StaleGenerationError', async () => {
    const calls: string[] = [];
    const replacing = replaceWorker(
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
    );
    await expect(replacing).rejects.toBeInstanceOf(StaleGenerationError);
    await expect(replacing).rejects.toThrow(
      'stale generation for session s-1: got generation 1, want newer than 1',
    );
    // Generation is validated BEFORE terminate: the live proc is never
    // killed, the session never opened, the lane never resumed.
    expect(calls).toEqual([]);
  });
});
