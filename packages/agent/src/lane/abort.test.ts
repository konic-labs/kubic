// Lane abort kill handling.
// abortLane drains the conversation's kills BEFORE running them, so a
// rejected abort still consumed the handles: a retry finds the registry
// empty and every original kill ran exactly once across both attempts.
import { describe, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '../pi-boundary.js';
import {
  type AbortableLane,
  abortLane,
  killLaneProcesses,
  LaneDriveError,
  OperationKillRegistry,
} from './abort.js';

function lane(options: {
  conversationId: string | number;
  abort: (context: unknown) => Promise<void>;
  kills: OperationKillRegistry;
}): AbortableLane {
  return {
    conversation: {
      id: options.conversationId,
      abort: options.abort,
    },
    kills: options.kills,
  } as unknown as AbortableLane;
}

describe('abortLane', () => {
  it('a rejected-then-retried abort drains the original kills exactly once', async () => {
    const kills = new OperationKillRegistry();
    let runs = 0;
    kills.track('7', () => {
      runs += 1;
    });
    kills.track('7', () => {
      runs += 1;
    });
    let attempts = 0;
    const stub = lane({
      conversationId: 7,
      kills,
      abort: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('durable abort refused');
      },
    });
    await expect(abortLane(stub, BACKGROUND_CONTEXT)).rejects.toThrowError(
      LaneDriveError,
    );
    // The first attempt already ran both kills before the abort failed.
    expect(runs).toBe(2);
    const retry = await abortLane(stub, BACKGROUND_CONTEXT);
    // The retry found the registry empty: nothing ran a second time.
    expect(retry).toEqual({ killed: 0 });
    expect(runs).toBe(2);
    expect(attempts).toBe(2);
  });
});

describe('killLaneProcesses', () => {
  it("kills every tracked child of the conversation, past one that already exited, and only that conversation's", () => {
    const kills = new OperationKillRegistry();
    const killed: string[] = [];
    kills.track('c1', () => killed.push('first'));
    kills.track('c1', () => {
      throw new Error('ESRCH');
    });
    kills.track('c1', () => killed.push('third'));
    kills.track('other', () => killed.push('other'));
    killLaneProcesses(
      lane({ conversationId: 'c1', abort: async () => {}, kills }),
    );
    expect(killed).toEqual(['first', 'third']);
    expect(kills.drain('c1')).toEqual([]);
    expect(kills.drain('other')).toHaveLength(1);
    expect(() => killLaneProcesses(undefined)).not.toThrow();
  });
});
