// Per-session cost surface: table row + --json shape, Σ(rows) == task total.
import { describe, expect, it } from 'vitest';
import {
  formatCostUsd,
  formatSessionCostRow,
  groupCostRows,
  isCostGroupBy,
  summarizeSessionCost,
  toCostJson,
} from './session-cost.js';

const ROWS = [
  {
    session: 'sess-1',
    model: 'cheap/small',
    costUsd: 0.2,
    input: 100,
    output: 50,
  },
  {
    session: 'sess-2',
    model: 'pro/large',
    costUsd: 0.3,
    input: 200,
    output: 60,
  },
];

describe('per-session cost surface', () => {
  it('sums per-row costs to exactly the task total', () => {
    const summary = summarizeSessionCost(ROWS);
    expect(summary.taskTotal).toBeCloseTo(0.5);
    const parts = summary.rows.reduce((acc, entry) => acc + entry.costUsd, 0);
    expect(parts).toBeCloseTo(summary.taskTotal);
  });

  it('formats a TUI row per session', () => {
    const summary = summarizeSessionCost(ROWS);
    const first = summary.rows[0];
    if (first === undefined) throw new Error('missing fixture row');
    const row = formatSessionCostRow(first);
    expect(row).toMatch(/sess-1/);
    // Sub-cent precision — $0.20 prints at 4 decimals.
    expect(row).toMatch(/0\.2000/);
  });

  it('counts a session with several model buckets as one unit', () => {
    const buckets = [
      {
        session: 's-1',
        model: 'faux/faux-1',
        costUsd: 0.2,
        input: 10,
        output: 5,
        cacheRead: 100,
        cacheWrite: 0,
      },
      { session: 's-1', model: 'tool:bash', costUsd: 0.1, input: 1, output: 1 },
      {
        session: 's-2',
        model: 'faux/faux-1',
        costUsd: 0.3,
        input: 20,
        output: 5,
        cacheRead: 0,
        cacheWrite: 50,
      },
    ];
    const summary = summarizeSessionCost(buckets, 'session');
    expect(summary.rows).toHaveLength(3);
    expect(summary.units).toBe(2);
    // s-1 is one unit: its cache read is the session's, judged once.
    expect(summary.cache).toEqual({ hits: 1, total: 2, rate: 0.5 });
  });

  it('counts one unit per row at the request and project levels', () => {
    expect(summarizeSessionCost(ROWS, 'project').units).toBe(2);
    expect(summarizeSessionCost(ROWS, 'request').units).toBe(2);
  });

  it('exposes a --json shape with the rows plus the task total', () => {
    const json = toCostJson(summarizeSessionCost(ROWS));
    expect(json.taskTotal).toBeCloseTo(0.5);
    expect(json.rows).toHaveLength(2);
    expect(json.rows[1]?.session).toBe('sess-2');
  });
});

describe('cost precision and grouping', () => {
  it('prints sub-cent costs at 4 decimals so $0.0023 never reads $0.00', () => {
    expect(formatCostUsd(0.0023)).toBe('$0.0023');
    expect(formatCostUsd(0.041)).toBe('$0.0410');
    expect(formatCostUsd(0)).toBe('$0.0000');
  });

  it('prints $1 and above at 2 decimals', () => {
    expect(formatCostUsd(12.5)).toBe('$12.50');
    expect(formatCostUsd(1)).toBe('$1.00');
  });

  it('accepts exactly the three levels', () => {
    expect(isCostGroupBy('request')).toBe(true);
    expect(isCostGroupBy('session')).toBe(true);
    expect(isCostGroupBy('project')).toBe(true);
    expect(isCostGroupBy('agent')).toBe(false);
    expect(isCostGroupBy('model')).toBe(false);
    expect(isCostGroupBy('')).toBe(false);
  });

  // Two sessions on one model, and one session that also ran a tool bucket:
  // four base facts across two projects.
  const FACTS = [
    {
      session: 's-1',
      project: '/proj',
      model: 'faux/faux-1',
      costUsd: 0.002,
      input: 100,
      output: 10,
      cacheRead: 40,
      cacheWrite: 5,
    },
    {
      session: 's-1',
      project: '/proj',
      model: 'tool:bash',
      costUsd: 0.001,
      input: 7,
      output: 1,
    },
    {
      session: 's-2',
      project: '/proj',
      model: 'faux/faux-1',
      costUsd: 0.003,
      input: 50,
      output: 20,
      cacheRead: 10,
      cacheWrite: 0,
    },
    {
      session: 's-3',
      project: '/other',
      model: 'faux/faux-1',
      costUsd: 0.006,
      input: 200,
      output: 30,
    },
  ];

  it('groups by session and model, one row per session bucket', () => {
    const grouped = groupCostRows(FACTS, 'session');
    expect(grouped).toHaveLength(4);
    expect(grouped[0]?.session).toBe('s-1');
    expect(grouped[0]?.model).toBe('faux/faux-1');
    expect(grouped[0]?.costUsd).toBeCloseTo(0.002);
    expect(grouped[1]?.model).toBe('tool:bash');
    const total = grouped.reduce((acc, row) => acc + row.costUsd, 0);
    expect(total).toBeCloseTo(0.012);
  });

  it('sums counters within one session and model bucket', () => {
    const grouped = groupCostRows([...FACTS, ...FACTS.slice(0, 1)], 'session');
    expect(grouped).toHaveLength(4);
    expect(grouped[0]?.costUsd).toBeCloseTo(0.004);
    expect(grouped[0]?.input).toBe(200);
    expect(grouped[0]?.cacheRead).toBe(80);
    expect(grouped[0]?.cacheWrite).toBe(10);
  });

  it('groups by project, aggregating every model and session away', () => {
    const grouped = groupCostRows(FACTS, 'project');
    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.project).toBe('/proj');
    expect(grouped[0]?.model).toBe('-');
    expect(grouped[0]?.session).toBeUndefined();
    expect(grouped[0]?.costUsd).toBeCloseTo(0.006);
    expect(grouped[0]?.input).toBe(157);
    expect(grouped[1]?.project).toBe('/other');
    expect(grouped[1]?.costUsd).toBeCloseTo(0.006);
  });

  it('passes request rows through copied', () => {
    const requested = FACTS.map((fact, index) => ({
      ...fact,
      request: String(index + 1),
    }));
    const grouped = groupCostRows(requested, 'request');
    expect(grouped).toHaveLength(4);
    expect(grouped[1]?.request).toBe('2');
  });
});
