// The orchestrator run's phase tracker (issue #464; docs/ui 04-B).
import { describe, expect, it } from 'vitest';
import { createRunPhaseTracker, type RunPhaseEvent } from './run-phases.js';

function tracked() {
  const events: string[] = [];
  let at = 0;
  const tracker = createRunPhaseTracker(
    (event: RunPhaseEvent) => events.push(`${event.phase}:${event.state}`),
    () => {
      at += 1;
      return at;
    },
  );
  return { tracker, events };
}

describe('run phases (issue #464)', () => {
  it('reports each transition once', () => {
    const { tracker, events } = tracked();
    tracker.start('plan');
    tracker.start('plan');
    tracker.finish('plan');
    tracker.finish('plan');
    tracker.start('implement');
    tracker.finish('review');
    expect(events).toEqual(['plan:running', 'plan:done', 'implement:running']);
  });

  it('on success finishes what runs and skips what never ran', () => {
    const { tracker, events } = tracked();
    tracker.start('plan');
    tracker.finish('plan');
    tracker.start('implement');
    tracker.finish('implement');
    tracker.skip('review');
    tracker.start('merge');
    tracker.settle(true);
    expect(events).toEqual([
      'plan:running',
      'plan:done',
      'implement:running',
      'implement:done',
      'review:skipped',
      'merge:running',
      'merge:done',
      'verify:skipped',
    ]);
  });

  it('on failure fails what runs and reports nothing it never reached', () => {
    const { tracker, events } = tracked();
    tracker.start('plan');
    tracker.finish('plan');
    tracker.start('implement');
    tracker.settle(false);
    expect(events).toEqual([
      'plan:running',
      'plan:done',
      'implement:running',
      'implement:failed',
    ]);
  });

  it('a skip never overrides a phase that reported', () => {
    const { tracker, events } = tracked();
    tracker.start('review');
    tracker.skip('review');
    expect(events).toEqual(['review:running']);
  });
});
