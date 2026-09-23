// Worker lifecycle status kernel (issue #42; §13, §81): legal
// transitions, terminal set, and exit classification (crash vs tool vs
// budget vs cancel) feeding result + trajectory.
import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  classifyExit,
  isTerminalStatus,
  WORKER_STATUSES,
} from './status.js';

describe('worker lifecycle §13 (issue #42)', () => {
  it('pins the closed status vocabulary', () => {
    expect([...WORKER_STATUSES]).toEqual([
      'created',
      'spawning',
      'ready',
      'running',
      'completed',
      'spawn_failed',
      'crashed',
      'timeout',
      'budget_exhausted',
      'cancelled',
    ]);
  });

  it('walks the happy path created→spawning→ready→running→completed', () => {
    expect(assertTransition('created', 'spawning')).toBe('spawning');
    expect(assertTransition('spawning', 'ready')).toBe('ready');
    expect(assertTransition('ready', 'running')).toBe('running');
    expect(assertTransition('running', 'completed')).toBe('completed');
  });

  it('refuses to skip readiness (spawning→running is illegal)', () => {
    expect(() => assertTransition('spawning', 'running')).toThrow(/readiness/i);
  });

  it('marks exactly the five §13 terminal states', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('spawn_failed')).toBe(true);
    expect(isTerminalStatus('crashed')).toBe(true);
    expect(isTerminalStatus('timeout')).toBe(true);
    expect(isTerminalStatus('budget_exhausted')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('ready')).toBe(false);
  });

  it('lets cancel land from any live state but never resurrects a terminal', () => {
    expect(assertTransition('running', 'cancelled')).toBe('cancelled');
    expect(assertTransition('spawning', 'cancelled')).toBe('cancelled');
    expect(() => assertTransition('completed', 'running')).toThrow(/terminal/i);
  });
});

describe('exit classification (crash vs tool vs budget vs cancel)', () => {
  it('classifies a clean exit as completed', () => {
    expect(classifyExit({ code: 0, signal: null, cancelled: false }).kind).toBe(
      'completed',
    );
  });

  it('classifies a signaled death as a crash, never a tool failure', () => {
    expect(
      classifyExit({ code: 1, signal: 'SIGKILL', cancelled: false }).kind,
    ).toBe('crash');
  });

  it('classifies a non-zero code without a signal as a tool failure', () => {
    expect(classifyExit({ code: 1, signal: null, cancelled: false }).kind).toBe(
      'tool',
    );
  });

  it('prefers cancel over code/signal when the worker was cancelled', () => {
    expect(
      classifyExit({ code: 1, signal: 'SIGTERM', cancelled: true }).kind,
    ).toBe('cancel');
  });

  it('classifies budget and timeout distinctly from crashes', () => {
    expect(
      classifyExit({
        code: 1,
        signal: null,
        cancelled: false,
        budgetExhausted: true,
      }).kind,
    ).toBe('budget');
    expect(
      classifyExit({ code: 1, signal: null, cancelled: false, timedOut: true })
        .kind,
    ).toBe('timeout');
  });

  it('maps each classification to a distinct result status', () => {
    expect(
      classifyExit({ code: 0, signal: null, cancelled: false }).status,
    ).toBe('completed');
    expect(
      classifyExit({ code: 1, signal: 'SIGSEGV', cancelled: false }).status,
    ).toBe('failed');
    expect(
      classifyExit({ code: 1, signal: null, cancelled: false }).status,
    ).toBe('failed');
    expect(
      classifyExit({
        code: 1,
        signal: null,
        cancelled: false,
        budgetExhausted: true,
      }).status,
    ).toBe('budget_exhausted');
    expect(
      classifyExit({ code: 1, signal: null, cancelled: true }).status,
    ).toBe('cancelled');
    expect(
      classifyExit({ code: 1, signal: null, cancelled: false, timedOut: true })
        .status,
    ).toBe('timeout');
    expect(
      classifyExit({ code: null, signal: null, cancelled: false }).status,
    ).toBe('spawn_failed');
  });
});
