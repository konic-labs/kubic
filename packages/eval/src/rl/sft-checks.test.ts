// The RL record checkers. checkProvenance,
// checkFailureCategory and checkVerifier return the exact error list a
// stripped wire record produces; preference.ts reuses them, so their
// messages are part of the export contract. Direct unit tests pin the
// valid case as [] and each invalid field by its exact string.
import { describe, expect, it } from 'vitest';
import { makeExport } from '../test-support/fixtures.js';
import { checkFailureCategory, checkProvenance, checkVerifier } from './sft.js';
import { extractProvenance } from './types.js';

const VALID_PROVENANCE = {
  proc: null,
  worktree: 'w',
  model: 'm',
  base: 'b',
};

describe('checkProvenance', () => {
  it('accepts the provenance a built record carries', () => {
    expect(checkProvenance(extractProvenance(makeExport({})))).toEqual([]);
    expect(checkProvenance(VALID_PROVENANCE)).toEqual([]);
    expect(checkProvenance({ ...VALID_PROVENANCE, proc: 4242 })).toEqual([]);
  });

  it('requires a provenance object', () => {
    for (const value of [undefined, null, 'x', 7, ['x']]) {
      expect(checkProvenance(value)).toEqual([
        'provenance is required: proc/worktree/model/base',
      ]);
    }
  });

  it('names every stripped field with its exact message, in order', () => {
    expect(
      checkProvenance({
        proc: 1.5,
        worktree: '',
        model: '  ',
        base: '',
      }),
    ).toEqual([
      'provenance.proc must be an integer or null',
      'provenance.worktree is required',
      'provenance.model is required',
      'provenance.base is required',
    ]);
  });

  it('requires proc to be an integer or null', () => {
    for (const proc of [1.5, '3', undefined]) {
      expect(checkProvenance({ ...VALID_PROVENANCE, proc })).toEqual([
        'provenance.proc must be an integer or null',
      ]);
    }
  });

  it('rejects a non-integer proc but keeps null', () => {
    expect(checkProvenance({ ...VALID_PROVENANCE, proc: 1.5 })).toEqual([
      'provenance.proc must be an integer or null',
    ]);
    expect(checkProvenance({ ...VALID_PROVENANCE, proc: null })).toEqual([]);
  });
});

describe('checkFailureCategory', () => {
  it('accepts null (no failure) and a known failure code', () => {
    expect(checkFailureCategory({ failureCategory: null })).toEqual([]);
    expect(checkFailureCategory({ failureCategory: 'tool_timeout' })).toEqual(
      [],
    );
  });

  it('requires the field to be present at all', () => {
    expect(checkFailureCategory({})).toEqual([
      'failureCategory is required: embed the failure category',
    ]);
  });

  it('rejects an unknown code by name, never defaulting to null', () => {
    expect(checkFailureCategory({ failureCategory: 'completed' })).toEqual([
      'unknown failure category "completed"',
    ]);
    expect(checkFailureCategory({ failureCategory: undefined })).toEqual([
      'unknown failure category undefined',
    ]);
  });
});

describe('checkVerifier', () => {
  it('accepts pass and fail verdicts', () => {
    expect(checkVerifier({ verdict: 'pass' })).toEqual([]);
    expect(checkVerifier({ verdict: 'fail' })).toEqual([]);
  });

  it('requires a verifier object', () => {
    for (const value of [undefined, null, 'pass', ['pass']]) {
      expect(checkVerifier(value)).toEqual([
        'verifier is required: wire the reference verifier',
      ]);
    }
  });

  it('rejects any verdict that is not pass or fail', () => {
    expect(checkVerifier({})).toEqual([
      'verifier.verdict must be pass or fail',
    ]);
    expect(checkVerifier({ verdict: 'maybe' })).toEqual([
      'verifier.verdict must be pass or fail',
    ]);
  });
});
