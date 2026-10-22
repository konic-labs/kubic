// Provenance + failure-label policy tests.
// Every RL record embeds provenance (proc/worktree/model/base) and
// the failure category; stripped fields are validation errors.
import { describe, expect, it } from 'vitest';
import { makeExport } from '../test-support/fixtures.js';
import {
  ENV_FAILURE_CODES,
  extractProvenance,
  isEnvFailure,
  requireFailureLabel,
} from './types.js';

describe('extractProvenance', () => {
  it('embeds proc/worktree/model/base from the trajectory export', () => {
    const provenance = extractProvenance(makeExport({}));
    expect(provenance).toEqual({
      proc: null,
      worktree: '/wt/agent-1',
      model: 'acme/m1',
      base: 'abc123',
    });
  });

  it('carries a numeric pid through as proc', () => {
    const provenance = extractProvenance(makeExport({ pid: 4242 }));
    expect(provenance.proc).toBe(4242);
  });

  it('rejects a stripped worktree instead of emitting a labelless record', () => {
    expect(() => extractProvenance(makeExport({ worktree: '' }))).toThrow(
      /worktree/i,
    );
  });

  it('rejects a stripped base revision', () => {
    expect(() => extractProvenance(makeExport({ baseRevision: '' }))).toThrow(
      /base/i,
    );
  });
});

describe('requireFailureLabel', () => {
  it('accepts a completed run with a null failure category', () => {
    expect(requireFailureLabel(makeExport({ status: 'completed' })).ok).toBe(
      true,
    );
  });

  it('accepts a failed run carrying its failure code', () => {
    const checked = requireFailureLabel(
      makeExport({ status: 'failed', failureCategory: 'tool_failed' }),
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.category).toBe('tool_failed');
  });

  it('rejects a non-completed run with a stripped (null) category', () => {
    const checked = requireFailureLabel(
      makeExport({ status: 'failed', failureCategory: null }),
    );
    expect(checked.ok).toBe(false);
  });

  it('rejects an unknown failure code', () => {
    const exported = makeExport({
      status: 'failed',
      failureCategory: 'nope' as never,
    });
    expect(requireFailureLabel(exported).ok).toBe(false);
  });
});

describe('isEnvFailure', () => {
  it('flags tool_failed and workspace_failed as env failures', () => {
    expect(ENV_FAILURE_CODES).toContain('tool_failed');
    expect(ENV_FAILURE_CODES).toContain('workspace_failed');
    expect(isEnvFailure('tool_failed')).toBe(true);
    expect(isEnvFailure('workspace_failed')).toBe(true);
  });

  it('treats capability codes as capability failures', () => {
    expect(isEnvFailure('model_failed')).toBe(false);
    expect(isEnvFailure(null)).toBe(false);
  });
});
