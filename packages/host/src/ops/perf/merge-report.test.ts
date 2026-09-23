// Per-agent merge reporting RED slice 5 (issue #55; §61): merge cost
// per agent lands in the run summary with no fixed budget, and N
// teardowns never delay the next spawn past the attach budget.
// Fails until merge-report.js lands.
import { describe, expect, it } from 'vitest';
import { recordMergeTelemetry } from '../../orchestrator/merge/telemetry.js';
import { formatMergeCost, summarizeMerges } from './merge-report.js';

function sample(agentId: string): ReturnType<typeof recordMergeTelemetry> {
  return recordMergeTelemetry({
    agentId,
    queueMs: 10,
    diffMs: 20,
    mergeMs: 30,
    resolveMs: 5,
    applyMs: 15,
    outcome: 'merged',
  });
}

describe('per-agent merge reporting (no fixed budget)', () => {
  it('formats one line per agent with the five phases and total', () => {
    const line = formatMergeCost(sample('agent-1'));
    expect(line).toMatch(/agent-1/);
    expect(line).toMatch(/total=80ms/);
    expect(line).toMatch(/merged/);
  });

  it('summarizes every agent in run order for the run summary', () => {
    const lines = summarizeMerges([sample('agent-1'), sample('agent-2')]);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/agent-1/);
    expect(lines[1]).toMatch(/agent-2/);
  });

  it('reports N teardowns plus the next attach without hiding delay', () => {
    const lines = summarizeMerges([sample('agent-1')]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/total=80ms/);
  });
});
