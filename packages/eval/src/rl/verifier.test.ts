// Reference verifier tests (issue #54, RED first).
// The reference verifier answers tests-pass using the eval runner's own
// signal derivation (computeSignals/gatesPass) — never a re-guess.
import { describe, expect, it } from 'vitest';
import { makeExport } from './fixtures.js';
import { referenceVerifier } from './verifier.js';

describe('referenceVerifier (issue #54)', () => {
  it('passes when the eval labels carry signal:tests=pass', () => {
    const verdict = referenceVerifier(
      makeExport({ evalLabels: { 'signal:tests': 'pass' } }),
    );
    expect(verdict.verdict).toBe('pass');
  });

  it('fails when the eval labels carry signal:tests=fail', () => {
    const verdict = referenceVerifier(
      makeExport({ evalLabels: { 'signal:tests': 'fail' } }),
    );
    expect(verdict.verdict).toBe('fail');
  });

  it('fails closed on unknown signals (abstains, never guesses pass)', () => {
    const verdict = referenceVerifier(makeExport({}));
    expect(verdict.verdict).toBe('fail');
  });

  it('fails a completed run with a red build gate', () => {
    const verdict = referenceVerifier(
      makeExport({
        evalLabels: { 'signal:tests': 'pass', 'signal:build': 'fail' },
      }),
    );
    expect(verdict.verdict).toBe('fail');
  });
});
