// Trust-first docs ordering note (issue #58; §77).
// RED first: limits docs before features — the ordering is data so docs
// and help text can follow it. Faux-only: pure data, no I/O.
import { describe, expect, it } from 'vitest';
import { formatTrustFirstNote, TRUST_FIRST_DOC_ORDER } from './trust-first.js';

describe('trust-first docs ordering (issue #58)', () => {
  it('orders honest limits before features', () => {
    const limitsIdx = TRUST_FIRST_DOC_ORDER.findIndex((section) =>
      section.toLowerCase().includes('limit'),
    );
    const featuresIdx = TRUST_FIRST_DOC_ORDER.findIndex((section) =>
      section.toLowerCase().includes('feature'),
    );
    expect(limitsIdx).toBeGreaterThanOrEqual(0);
    expect(featuresIdx).toBeGreaterThanOrEqual(0);
    expect(limitsIdx).toBeLessThan(featuresIdx);
  });

  it('note cites §77 and reads limits-before-features', () => {
    const note = formatTrustFirstNote();
    expect(note).toContain('§77');
    expect(note).toMatch(/limits.*before.*features/i);
  });
});
