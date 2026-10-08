// Settlement mapping:
// submitted settlements → Kubic failure codes and result vocabulary.
import { describe, expect, it } from 'vitest';
import {
  classifyHarnessError,
  classifySubmissionFailure,
  classifyThrownError,
  settleTerminalStatus,
} from './settle.js';

describe('settlement mapping', () => {
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

describe('settled pi-durable submissions', () => {
  it('maps a bare reason to a readable message, never the code alone', () => {
    const failure = classifySubmissionFailure('no_model');
    expect(failure.code).toBe('provider_auth');
    expect(failure.message).toBe('lane settled no_model');
  });

  it('maps a faulted settlement to the process code', () => {
    const failure = classifySubmissionFailure('faulted', 'task bug');
    expect(failure.code).toBe('process_crashed');
    expect(failure.error.kind).toBe('process');
  });

  it('classifies a thrown provider error as its failure code', () => {
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
