// Settlement mapping (issue #11 slice C; ported to pi-durable in #395):
// submitted settlements → Kubic §52 codes and #7 result vocabulary.
import { describe, expect, it } from 'vitest';
import type { SettledSubmissionRecord } from '../pi-boundary.js';
import {
  classifyHarnessError,
  classifySubmissionFailure,
  classifyThrownError,
  laneErrorOf,
  laneStatusOf,
  settleSubmission,
  settleTerminalStatus,
} from './settle.js';

function settled(
  record:
    | { status: 'done' }
    | { status: 'unanswered'; reason: string; detail?: string },
): SettledSubmissionRecord {
  return {
    id: 'sub-1',
    conversationId: 'conv-1',
    type: 'input',
    ...record,
  } as unknown as SettledSubmissionRecord;
}

describe('settlement mapping (issue #11, slice C)', () => {
  it('maps completed to a completed result without error', () => {
    expect(settleTerminalStatus('completed')).toEqual({ status: 'completed' });
  });

  it('maps failed with a classified error', () => {
    const settled = settleTerminalStatus('failed', {
      code: 'context_overflow',
      message: 'too many tokens',
    });
    expect(settled.status).toBe('failed');
    expect(settled.error?.kind).toBe('context');
  });

  it('maps aborted to cancelled', () => {
    expect(settleTerminalStatus('aborted')).toEqual({ status: 'cancelled' });
    expect(
      settleTerminalStatus('aborted', {
        code: 'aborted',
        message: 'lane aborted',
      }).status,
    ).toBe('cancelled');
  });

  it('classifies harness error codes by keyword', () => {
    expect(classifyHarnessError('budget_exhausted', 'no money').kind).toBe(
      'budget',
    );
    expect(classifyHarnessError('model_unavailable', 'gone').kind).toBe(
      'model',
    );
    expect(classifyHarnessError('provider_auth', 'denied').kind).toBe(
      'provider',
    );
    expect(classifyHarnessError('tool_crashed', 'x').kind).toBe('tool');
  });

  it('falls back to process for unrecognized harness errors', () => {
    const error = classifyHarnessError(
      'structural_interrupted',
      'unknown outcome',
    );
    expect(error.kind).toBe('process');
    expect(error.message).toContain('structural_interrupted');
  });
});

describe('settled pi-durable submissions (#395)', () => {
  it('maps a done submission to completed', () => {
    expect(settleSubmission(settled({ status: 'done' }))).toEqual({
      status: 'completed',
    });
    expect(laneStatusOf(settled({ status: 'done' }))).toBe('completed');
    expect(laneErrorOf(settled({ status: 'done' }))).toBeUndefined();
  });

  it('maps model_error to the §52 model code with the harness detail as message', () => {
    const record = settled({
      status: 'unanswered',
      reason: 'model_error',
      detail: 'provider returned 500',
    });
    expect(settleSubmission(record)).toEqual({
      status: 'failed',
      error: {
        kind: 'model',
        message: 'provider returned 500',
        details: 'provider returned 500',
      },
    });
    expect(
      classifySubmissionFailure('model_error', 'provider returned 500'),
    ).toEqual({
      code: 'model_failed',
      message: 'provider returned 500',
      error: {
        kind: 'model',
        message: 'provider returned 500',
        details: 'provider returned 500',
      },
    });
    expect(laneStatusOf(record)).toBe('failed');
    expect(laneErrorOf(record)).toEqual({
      code: 'model_error',
      message: 'provider returned 500',
      details: 'provider returned 500',
    });
  });

  it('maps a bare reason to a readable message, never the code alone', () => {
    const failure = classifySubmissionFailure('no_model');
    expect(failure.code).toBe('provider_auth');
    expect(failure.message).toBe('lane settled no_model');
  });

  it('maps an aborted settlement to cancelled with no error (D6.1)', () => {
    const record = settled({ status: 'unanswered', reason: 'aborted' });
    expect(settleSubmission(record)).toEqual({ status: 'cancelled' });
    expect(laneStatusOf(record)).toBe('aborted');
    expect(laneErrorOf(record)).toBeUndefined();
  });

  it('maps a faulted settlement to the §52 process code', () => {
    const failure = classifySubmissionFailure('faulted', 'task bug');
    expect(failure.code).toBe('process_crashed');
    expect(failure.error.kind).toBe('process');
  });

  it('classifies a thrown provider error as its §52 code', () => {
    const failure = classifyThrownError(
      Object.assign(new Error('fetch failed'), { name: 'FetchError' }),
    );
    expect(failure.code).toBe('provider_transient');
    expect(failure.message).toBe('fetch failed');
  });

  it('classifies a thrown unknown as process_crashed, keeping the message', () => {
    const failure = classifyThrownError(new Error('kaboom'));
    expect(failure.code).toBe('process_crashed');
    expect(failure.error.message).toBe('kaboom');
  });
});
