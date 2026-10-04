// Worker lifecycle status kernel (issue #42; §13, §81): legal transitions,
// terminal sets, and exit classification (crash vs tool vs budget vs cancel)
// feeding result + trajectory. Issue #151 splits the two vocabularies: the
// PROCESS phase (spawning → ready → exiting) and the AGENT state
// (starting → running → waiting/settling → terminal).
import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUSES,
  AGENT_TERMINAL_STATUSES,
  assertAgentTransition,
  assertProcessTransition,
  classifyExit,
  isTerminalAgentStatus,
  PROCESS_STATUSES,
} from './status.js';

describe('worker lifecycle §13 process status (issue #151)', () => {
  it('pins the closed process vocabulary', () => {
    expect([...PROCESS_STATUSES]).toEqual(['spawning', 'ready', 'exiting']);
  });

  it('walks spawning → ready → exiting', () => {
    expect(assertProcessTransition('spawning', 'ready')).toBe('ready');
    expect(assertProcessTransition('ready', 'exiting')).toBe('exiting');
  });

  it('lets a launch that never becomes ready exit directly', () => {
    expect(assertProcessTransition('spawning', 'exiting')).toBe('exiting');
  });

  it('refuses to go back, and refuses anything after exiting', () => {
    expect(() => assertProcessTransition('ready', 'spawning')).toThrow(
      /illegal worker process transition/i,
    );
    expect(() => assertProcessTransition('exiting', 'ready')).toThrow(
      /already exited/i,
    );
  });
});

describe('worker lifecycle §13 agent status (issue #151)', () => {
  it('pins the closed agent vocabulary', () => {
    expect([...AGENT_STATUSES]).toEqual([
      'starting',
      'running',
      'waiting',
      'settling',
      'completed',
      'failed',
      'cancelled',
      'timeout',
      'budget_exhausted',
      'spawn_failed',
    ]);
  });

  it('walks the happy path starting → running → settling → completed', () => {
    expect(assertAgentTransition('starting', 'running')).toBe('running');
    expect(assertAgentTransition('running', 'settling')).toBe('settling');
    expect(assertAgentTransition('settling', 'completed')).toBe('completed');
  });

  it('models a held ask: running → waiting → running', () => {
    expect(assertAgentTransition('running', 'waiting')).toBe('waiting');
    expect(assertAgentTransition('waiting', 'running')).toBe('running');
    // An ask that is never answered still terminates.
    expect(assertAgentTransition('waiting', 'timeout')).toBe('timeout');
  });

  it('refuses to skip readiness (starting → settling is illegal)', () => {
    expect(() => assertAgentTransition('starting', 'settling')).toThrow(
      /readiness handshake required/i,
    );
  });

  it('refuses to reuse a settled agent (completed → running is illegal)', () => {
    expect(() => assertAgentTransition('completed', 'running')).toThrow(
      /terminal \(completed\)/i,
    );
  });

  it('marks exactly the six §13 terminal outcomes as terminal', () => {
    expect(
      AGENT_STATUSES.filter((status) => isTerminalAgentStatus(status)),
    ).toEqual([...AGENT_TERMINAL_STATUSES]);
    expect(AGENT_TERMINAL_STATUSES).toEqual([
      'completed',
      'failed',
      'cancelled',
      'timeout',
      'budget_exhausted',
      'spawn_failed',
    ]);
  });
});

describe('worker exit classification (§13, §78; issue #151)', () => {
  it('maps a clean exit to SETTLING, never straight to COMPLETED', () => {
    const exit = classifyExit({ code: 0, signal: null, cancelled: false });
    expect(exit.kind).toBe('completed');
    expect(exit.status).toBe('completed');
    // The §68 report check is what completes the agent (a child that exits 0
    // with an invalid report is FAILED, not completed).
    expect(exit.agent).toBe('settling');
    expect(exit.process).toBe('exiting');
  });

  it('maps a signal death to a crash', () => {
    const exit = classifyExit({ code: 1, signal: 'SIGKILL', cancelled: false });
    expect(exit.kind).toBe('crash');
    expect(exit.agent).toBe('failed');
  });

  it('maps a plain non-zero exit to a failure', () => {
    expect(classifyExit({ code: 1, signal: null, cancelled: false }).kind).toBe(
      'tool',
    );
    expect(
      classifyExit({ code: 1, signal: null, cancelled: false }).agent,
    ).toBe('failed');
  });

  it('maps exit 3 to BUDGET_EXHAUSTED even without a reported flag', () => {
    const exit = classifyExit({
      code: 3,
      signal: null,
      cancelled: false,
      declaredExit: 3,
    });
    expect(exit.kind).toBe('budget');
    expect(exit.agent).toBe('budget_exhausted');
  });

  it('maps exit 4 to a FAILED agent (an approval terminus, never a crash)', () => {
    const exit = classifyExit({
      code: 4,
      signal: null,
      cancelled: false,
      declaredExit: 4,
    });
    expect(exit.status).toBe('failed');
    expect(exit.agent).toBe('failed');
    expect(exit.kind).not.toBe('crash');
  });

  it('maps a manager cancel to CANCELLED', () => {
    const exit = classifyExit({ code: 1, signal: null, cancelled: true });
    expect(exit.kind).toBe('cancel');
    expect(exit.agent).toBe('cancelled');
    expect(exit.status).toBe('cancelled');
  });

  it('maps a timeout to TIMEOUT', () => {
    const exit = classifyExit({
      code: 1,
      signal: null,
      cancelled: false,
      timedOut: true,
    });
    expect(exit.agent).toBe('timeout');
    expect(exit.status).toBe('timeout');
  });

  it('maps a launch that never started to SPAWN_FAILED', () => {
    const exit = classifyExit({ code: null, signal: null, cancelled: false });
    expect(exit.agent).toBe('spawn_failed');
    expect(exit.status).toBe('spawn_failed');
  });

  it('keeps a declared budget flag authoritative over the signal', () => {
    const exit = classifyExit({
      code: 1,
      signal: null,
      cancelled: false,
      budgetExhausted: true,
    });
    expect(exit.kind).toBe('budget');
    expect(exit.agent).toBe('budget_exhausted');
  });
});
