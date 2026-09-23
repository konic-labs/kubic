// Slice C: usage rollups + kubic models CLI (issue #20; §39, §17/§18).
// RED: summarizeUsage/formatUsageLine do not exist yet.
import { describe, expect, it } from 'vitest';
import type { Usage } from './pi-boundary.js';
import {
  formatUsageLine,
  type KubicUsageRow,
  summarizeUsage,
} from './usage.js';

function usage(over: Partial<Usage>): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...over,
  };
}

function row(over: Partial<KubicUsageRow>): KubicUsageRow {
  return {
    model: 'local/llama3',
    provider: 'local',
    usage: usage({}),
    ...over,
  };
}

describe('usage rollups (issue #20, slice C)', () => {
  it('sums requests, tokens, cache split, and priced cost', () => {
    const summary = summarizeUsage([
      row({
        usage: usage({
          input: 100,
          output: 50,
          cacheRead: 20,
          cacheWrite: 10,
          totalTokens: 180,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.001,
            cacheWrite: 0.002,
            total: 0.033,
          },
        }),
      }),
      row({
        model: 'faux/big',
        provider: 'faux',
        usage: usage({ input: 10, output: 5, totalTokens: 15 }),
      }),
    ]);
    expect(summary.requests).toBe(2);
    expect(summary.input).toBe(110);
    expect(summary.output).toBe(55);
    expect(summary.cacheRead).toBe(20);
    expect(summary.cacheWrite).toBe(10);
    expect(summary.costTotal).toBeCloseTo(0.033);
    expect(summary.byModel['local/llama3']?.requests).toBe(1);
    expect(summary.byModel['faux/big']?.input).toBe(10);
  });

  it('formats a one-line status readout', () => {
    const summary = summarizeUsage([
      row({ usage: usage({ input: 100, output: 50, totalTokens: 150 }) }),
    ]);
    const line = formatUsageLine('local/llama3', 'off', summary);
    expect(line).toContain('local/llama3');
    expect(line).toContain('150 tokens');
    expect(line).toContain('$0.00');
  });

  it('empty usage formats without NaN', () => {
    const summary = summarizeUsage([]);
    expect(summary.requests).toBe(0);
    expect(formatUsageLine('m', 'off', summary)).toContain('0 tokens');
  });
});
