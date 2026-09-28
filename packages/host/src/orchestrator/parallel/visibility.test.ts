// Parallel visibility hooks (issue #47): tree/workers/trajectory surface
// concurrency + usage. RED first — implementation lands in visibility.ts.
import { describe, expect, it } from 'vitest';
import {
  buildParallelTrajectoryEvent,
  buildParallelTreeLine,
  buildParallelWorkersExtra,
} from './visibility.js';

describe('parallel visibility (issue #47)', () => {
  it('renders concurrency in the tree line', () => {
    const line = buildParallelTreeLine({
      sessionId: 'sess-1',
      running: 3,
      queued: 1,
      maxConcurrency: 4,
    });
    expect(line).toBe('sess-1 parallel 3/4 (queued 1)');
    // An empty queue is not rendered as noise.
    expect(
      buildParallelTreeLine({
        sessionId: 'sess-1',
        running: 3,
        queued: 0,
        maxConcurrency: 4,
      }),
    ).toBe('sess-1 parallel 3/4');
  });

  it('exposes conc + usage in the workers extra row', () => {
    const extra = buildParallelWorkersExtra({
      running: 2,
      queued: 0,
      maxConcurrency: 4,
      usage: { requests: 10, costTotal: 1.5, tokens: 4000 },
    });
    expect(extra).toEqual({
      running: 2,
      maxConcurrency: 4,
      queued: 0,
      usage: { requests: 10, costTotal: 1.5, tokens: 4000 },
    });
  });

  it('emits a plain-JSON trajectory event with conc and usage', () => {
    const event = buildParallelTrajectoryEvent({
      sessionId: 'sess-1',
      running: 4,
      queued: 1,
      maxConcurrency: 4,
      wakeups: ['a5'],
      usage: { requests: 3, costTotal: 0.25, tokens: 1000 },
    });
    expect(event.kind).toBe('parallel');
    expect(event).toMatchObject({
      sessionId: 'sess-1',
      running: 4,
      queued: 1,
      maxConcurrency: 4,
      wakeups: ['a5'],
      usage: { requests: 3, costTotal: 0.25, tokens: 1000 },
    });
    // Plain JSON: a round trip loses nothing.
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
