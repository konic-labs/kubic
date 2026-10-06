// An orchestrator run's phases (EPIC N, issue #464; docs/ui 04-B): plan →
// implement → review → merge → verify, reported as they happen so the
// dashboard's timeline can show where the run is. The run drives the
// tracker at its transitions; whatever is still running when the run ends
// finishes as the run did, and on success a phase the run never needed is
// reported skipped (a run without a review step, the verify step Kubic does
// not run yet).

import {
  RUN_PHASES,
  type RunPhase,
  type RunPhaseState,
} from '../../../core/src/presentation.js';

export interface RunPhaseEvent {
  readonly phase: RunPhase;
  readonly state: RunPhaseState['state'];
  readonly at: number;
}

export interface RunPhaseTracker {
  /** The phase began. A phase reports its start once. */
  start(phase: RunPhase): void;
  /** A running phase finished. Nothing for a phase that is not running. */
  finish(phase: RunPhase): void;
  /** The run will not run this phase. Nothing once the phase reported. */
  skip(phase: RunPhase): void;
  /** The run ended: a running phase finishes as the run did; on success,
   *  every phase never reached is skipped. */
  settle(ok: boolean): void;
}

export function createRunPhaseTracker(
  onPhase: ((event: RunPhaseEvent) => void) | undefined,
  now: () => number = Date.now,
): RunPhaseTracker {
  const states = new Map<RunPhase, RunPhaseState['state']>();
  const report = (phase: RunPhase, state: RunPhaseState['state']): void => {
    states.set(phase, state);
    onPhase?.({ phase, state, at: now() });
  };
  return {
    start(phase) {
      if (!states.has(phase)) report(phase, 'running');
    },
    finish(phase) {
      if (states.get(phase) === 'running') report(phase, 'done');
    },
    skip(phase) {
      if (!states.has(phase)) report(phase, 'skipped');
    },
    settle(ok) {
      for (const phase of RUN_PHASES) {
        const state = states.get(phase);
        if (state === 'running') report(phase, ok ? 'done' : 'failed');
        else if (state === undefined && ok) report(phase, 'skipped');
      }
    },
  };
}
