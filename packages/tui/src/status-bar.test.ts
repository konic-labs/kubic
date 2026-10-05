// Slice A: session aggregates from usage rows (issue #27; §39).
// Fixture rows must sum to exact session cost/tokens with the cache
// split kept. Issue #346 deleted the TTFT/tool-ms segments (Pi 1.0 routes
// no timing Kubic can read); the bar renders what the lane really reports.
// Headless + faux-only: no network, no VirtualTerminal (Pi 0.85.1).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUS_THEME,
  formatStatusCost,
  renderStatusLines,
  StatusBar,
  type StatusBarState,
  type StatusUsageRow,
  statusVisibleWidth,
  summarizeStatusRows,
} from './status-bar.js';

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function stripSgr(line: string): string {
  return line.replace(SGR, '');
}

function row(over: Partial<StatusUsageRow>): StatusUsageRow {
  return {
    model: 'test/model',
    provider: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...over,
  };
}

describe('status aggregates (issue #27, slice A)', () => {
  it('sums fixture rows to exact session cost/tokens with cache split', () => {
    const summary = summarizeStatusRows([
      row({
        model: 'alpha/one',
        usage: {
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
        },
      }),
      row({
        model: 'beta/two',
        usage: {
          input: 10,
          output: 5,
          cacheRead: 4,
          cacheWrite: 2,
          totalTokens: 21,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0.0001,
            cacheWrite: 0.0002,
            total: 0.0033,
          },
        },
      }),
    ]);
    expect(summary.requests).toBe(2);
    expect(summary.input).toBe(110);
    expect(summary.output).toBe(55);
    expect(summary.cacheRead).toBe(24);
    expect(summary.cacheWrite).toBe(12);
    expect(summary.costTotal).toBeCloseTo(0.0363);
    expect(formatStatusCost(summary.costTotal)).toBe('$0.04');
  });

  it('empty rows aggregate without NaN and format $0.00', () => {
    const summary = summarizeStatusRows([]);
    expect(summary.requests).toBe(0);
    expect(formatStatusCost(summary.costTotal)).toBe('$0.00');
  });

  it('reports the last committed request as the context size (issue #347)', () => {
    const summary = summarizeStatusRows([
      // Seeded cumulative buckets (#346) are not a request: no entry id.
      row({ usage: { ...priced().usage, input: 5000, cacheRead: 900 } }),
      row({
        entryId: 'e1',
        usage: { ...priced().usage, input: 300, cacheRead: 120 },
      }),
      row({
        entryId: 'e2',
        usage: { ...priced().usage, input: 420, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);
    expect(summary.contextTokens).toBe(420);
    expect(summarizeStatusRows([priced()]).contextTokens).toBeUndefined();
  });
});

function state(over: Partial<StatusBarState>): StatusBarState {
  return {
    model: 'test/model-long-name',
    thinking: 'medium',
    rows: [],
    mode: 'solo',
    approvalsSkipped: false,
    sessionId: 'sess-abc123',
    ...over,
  };
}

function priced(over: Partial<StatusUsageRow> = {}): StatusUsageRow {
  return {
    model: 'test/model-long-name',
    provider: 'test',
    usage: {
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
    },
    ...over,
  };
}

describe('budget burn-down (issue #285; §71)', () => {
  // The bar names the §71 limits with live burn-down — tools from the
  // attempt count the boot feeds in, tokens/cost from the usage rows —
  // and stays silent when no limit is set.
  it("renders 'budget tools 3/10' when a limit is set", () => {
    const [row1] = renderStatusLines(
      state({
        rows: [
          priced({
            usage: {
              ...priced().usage,
              cost: { ...priced().usage.cost, total: 0.12 },
            },
          }),
        ],
        budget: { limits: { maxToolCalls: 10, maxCostUsd: 0.5 }, toolCalls: 3 },
      }),
      120,
    );
    expect(row1).toContain('budget tools 3/10 · $0.12/$0.50');
  });

  it('renders nothing budget-shaped when no limit is set', () => {
    const [row1] = renderStatusLines(state({ rows: [priced()] }), 120);
    expect(row1).not.toContain('budget');
  });

  it('renders the limit text when only wall-clock is bounded', () => {
    const [row1] = renderStatusLines(
      state({ budget: { limits: { maxRuntimeMs: 60000 }, toolCalls: 0 } }),
      120,
    );
    expect(row1).toContain('budget wall≤60s');
  });
});

describe('context-window gauge (issue #347; §18)', () => {
  // A committed request whose prompt was 420 tokens (300 new + 120 cached)
  // against a 1000-token window: `ctx 42%`.
  function requestRow(input: number, cacheRead: number): StatusUsageRow {
    return row({
      entryId: 'e1',
      usage: { ...priced().usage, input, cacheRead, cacheWrite: 0 },
    });
  }

  const warn = (text: string): string => `[WARN:${text}]`;

  it('renders ctx 42% for a 1000-token window and a 420-token request', () => {
    const lines = renderStatusLines(
      state({ rows: [requestRow(300, 120)], contextWindow: 1000 }),
      100,
    );
    expect(lines[0]).toContain('ctx 42%');
  });

  it('hides the gauge when the context window is unknown', () => {
    const lines = renderStatusLines(
      state({ rows: [requestRow(300, 120)] }),
      100,
    );
    expect(lines[0]).not.toContain('ctx ');
  });

  it('hides the gauge until a committed request reports its prompt size', () => {
    // A seeded cumulative bucket (#346) is not context pressure.
    const lines = renderStatusLines(
      state({ rows: [priced()], contextWindow: 1000 }),
      100,
    );
    expect(lines[0]).not.toContain('ctx ');
  });

  it('warns at or above the compaction threshold, never below it', () => {
    const rows = [requestRow(300, 120)];
    const below = renderStatusLines(
      state({ rows, contextWindow: 1000, compactionThreshold: 500 }),
      100,
      { warning: warn },
    );
    expect(below[0]).toContain('ctx 42%');
    expect(below[0]).not.toContain('[WARN:');
    const at = renderStatusLines(
      state({ rows, contextWindow: 1000, compactionThreshold: 420 }),
      100,
      { warning: warn },
    );
    expect(at[0]).toContain('[WARN:ctx 42%]');
  });

  it('drops the gauge before the model when the terminal is narrow', () => {
    const full = renderStatusLines(
      state({ rows: [requestRow(300, 120)], contextWindow: 1000 }),
      100,
    );
    expect(full[0]).toContain('ctx 42%');
    expect(full[0]).toContain('thinking medium');
    const narrow = renderStatusLines(
      state({ rows: [requestRow(300, 120)], contextWindow: 1000 }),
      80,
    );
    expect(narrow[0]).not.toContain('ctx ');
    expect(narrow[0]).toContain('thinking medium');
    expect(narrow[0]).toContain('$0.03');
  });

  it('clamps a window smaller than the request instead of exceeding 100%', () => {
    const lines = renderStatusLines(
      state({ rows: [requestRow(300, 120)], contextWindow: 100 }),
      100,
    );
    expect(lines[0]).toContain('ctx 100%');
  });

  it('counts the cache-write prefix, not just the reused one (review #347)', () => {
    // The first request of a session (or one after the cache TTL lapses)
    // writes the whole prefix: pi's `input` is then only the new user text,
    // and a gauge that ignored cacheWrite would read `ctx 0%` while the
    // context is nearly 7% of a 128k window.
    const rowWithWrite = row({
      entryId: 'e1',
      usage: { ...priced().usage, input: 30, cacheRead: 0, cacheWrite: 9000 },
    });
    const summary = summarizeStatusRows([rowWithWrite]);
    expect(summary.contextTokens).toBe(9030);
    const lines = renderStatusLines(
      state({ rows: [rowWithWrite], contextWindow: 128000 }),
      120,
    );
    expect(lines[0]).toContain('ctx 7%');
    expect(lines[0]).not.toContain('ctx 0%');
  });
});

describe('status bar rows (issue #27, slice B)', () => {
  it('renders model/thinking/tokens/cache/cost + mode/approvals/session', () => {
    const lines = renderStatusLines(state({ rows: [priced()] }), 100);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('test/model-long-name');
    expect(lines[0]).toContain('medium');
    expect(lines[0]).toContain('100');
    expect(lines[0]).toContain('cached 20');
    expect(lines[0]).toContain('$0.03');
    expect(lines[1]).toContain('solo');
    expect(lines[1]).toContain('approvals:on');
    expect(lines[1]).toContain('sess-abc123');
  });

  it('flips to approvals:OFF within one frame, fresh starts safe', () => {
    const bar = new StatusBar(state({}));
    expect(bar.render(100)[1]).toContain('approvals:on');
    bar.setApprovalsSkipped(true);
    const off = bar.render(100);
    expect(off[1]).toContain('approvals OFF');
    expect(off[1]).toContain('warning:');
    expect(off[1]).toContain('full-access');
    expect(off[1]).not.toContain('approvals:on');
    bar.setApprovalsSkipped(false);
    expect(bar.render(100)[1]).toContain('approvals:on');
  });

  it('styles OFF with the warning theme and keeps it unmissable', () => {
    const lines = renderStatusLines(state({ approvalsSkipped: true }), 100);
    expect(lines[1]).toContain('! warning: approvals OFF (full-access)');
    expect(lines[1]).toContain(`${ESC}[`);
    expect(DEFAULT_STATUS_THEME.warning('x')).not.toBe('x');
    expect(statusVisibleWidth(lines[1])).toBeLessThanOrEqual(100);
  });

  it('truncates the model first at 50 cols, keeps $ and mode', () => {
    const full = 'test/model-long-name';
    const lines = renderStatusLines(state({ rows: [priced()] }), 50);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(statusVisibleWidth(line)).toBeLessThanOrEqual(50);
    }
    expect(lines[0]).toContain('$');
    expect(lines[1]).toContain('solo');
    expect(stripSgr(lines[0])).not.toContain(full);
  });

  it('keeps cost and mode longest under narrowing', () => {
    for (const width of [60, 50, 40]) {
      const lines = renderStatusLines(
        state({ rows: [priced()], approvalsSkipped: true }),
        width,
      );
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(statusVisibleWidth(line)).toBeLessThanOrEqual(width);
      }
      expect(lines[0]).toContain('$');
      expect(lines[1]).toContain('solo');
      expect(lines[1]).toContain('OFF');
    }
  });

  it('recolors the warning via theme override without layout change', () => {
    const skipped = state({ approvalsSkipped: true });
    const before = renderStatusLines(skipped, 100);
    const after = renderStatusLines(skipped, 100, {
      warning: (text: string): string => `[WARN:${text}]`,
    });
    expect(after[1]).toContain('[WARN:! warning: approvals OFF');
    const strip = (line: string): string =>
      stripSgr(line)
        .replace('[WARN:', '')
        .replace('(full-access)]', '(full-access)');
    expect(strip(after[1])).toBe(stripSgr(before[1]));
    expect(statusVisibleWidth(after[0])).toBe(statusVisibleWidth(before[0]));
  });

  it('headless snapshots: default, skip, and narrow frames', () => {
    const basic = new StatusBar(state({ rows: [priced()] }));
    const skipped = new StatusBar(
      state({ rows: [priced()], approvalsSkipped: true }),
    );
    for (const [bar, width] of [
      [basic, 100],
      [skipped, 100],
      [basic, 60],
    ] as const) {
      for (const line of bar.render(width)) {
        expect(statusVisibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    // Headless frames pinned exactly (SGR stripped): a regression in any
    // segment, separator, or drop order shows up as a frame diff.
    const frame = (bar: StatusBar, width: number): string[] =>
      bar.render(width).map(stripSgr);
    expect(frame(basic, 100)).toEqual([
      'test/model-long-name • thinking medium • in 100 out 50 (cached 20) • $0.03',
      'solo • approvals:on • session sess-abc123',
    ]);
    expect(frame(skipped, 100)).toEqual([
      'test/model-long-name • thinking medium • in 100 out 50 (cached 20) • $0.03',
      'solo • ! warning: approvals OFF (full-access) • session sess-abc123',
    ]);
    expect(frame(basic, 60)).toEqual([
      'test/model-long-name • in 100 out 50 (cached 20) • $0.03',
      'solo • approvals:on • session sess-abc123',
    ]);
  });
});

describe('status bar review fixes (issue #27, fix cycle 1)', () => {
  it('floors sub-cent spend to <$0.01 instead of $0.00', () => {
    expect(formatStatusCost(0)).toBe('$0.00');
    expect(formatStatusCost(0.001)).toBe('<$0.01');
    expect(formatStatusCost(0.0049)).toBe('<$0.01');
    expect(formatStatusCost(0.005)).toBe('$0.01');
    expect(formatStatusCost(0.033)).toBe('$0.03');
  });

  it('normalizes non-finite widths to 0 instead of ellipsis lines', () => {
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const lines = renderStatusLines(state({ rows: [priced()] }), width);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(statusVisibleWidth(line)).toBe(0);
        expect(stripSgr(line)).not.toContain('…');
      }
    }
  });

  it('keeps warning color on a narrowed OFF line, leaves ON plain', () => {
    const off = renderStatusLines(
      state({ rows: [priced()], approvalsSkipped: true }),
      40,
    );
    expect(statusVisibleWidth(off[1])).toBeLessThanOrEqual(40);
    expect(off[1]).toContain('OFF');
    expect(off[1]).toContain(`${ESC}[`);
    const on = renderStatusLines(state({ rows: [priced()] }), 12);
    expect(statusVisibleWidth(on[1])).toBeLessThanOrEqual(12);
    expect(on[1]).not.toContain(`${ESC}[`);
  });

  it('mirrors worker KubicUsageRow field-for-field (drift guard)', () => {
    // Structural mirror of packages/worker/src/usage.ts KubicUsageRow,
    // hand-copied because dep-lint forbids tui → worker imports: a shape
    // change on either side fails here loudly instead of drifting.
    interface ExpectedWorkerCost {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly total: number;
    }
    interface ExpectedWorkerUsage {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly totalTokens: number;
      readonly cost: ExpectedWorkerCost;
    }
    interface ExpectedWorkerRow {
      readonly model: string;
      readonly provider: string;
      readonly usage: ExpectedWorkerUsage;
      readonly toolCallId?: string;
      readonly entryId?: string;
    }
    // Type-level: assignability holds in both directions.
    const probe: StatusUsageRow = row({
      toolCallId: 'tool-1',
      entryId: 'entry-1',
    });
    const asExpected: ExpectedWorkerRow = probe;
    const backToStatus: StatusUsageRow = asExpected;
    expect(backToStatus.model).toBe(probe.model);
    // Runtime: exact key sets, required vs optional split.
    expect(Object.keys(backToStatus.usage.cost).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'input',
      'output',
      'total',
    ]);
    expect(Object.keys(backToStatus.usage).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'cost',
      'input',
      'output',
      'totalTokens',
    ]);
    expect(Object.keys(backToStatus).sort()).toEqual([
      'entryId',
      'model',
      'provider',
      'toolCallId',
      'usage',
    ]);
    expect(Object.keys(row({})).sort()).toEqual(['model', 'provider', 'usage']);
  });
});

describe('status bar mutation hardening (issue #68)', () => {
  it('propagates setRows to the rendered cost within one frame', () => {
    const bar = new StatusBar(state({ rows: [] }));
    expect(bar.render(100)[0]).toContain('$0.00');
    bar.setRows([priced()]);
    const lines = bar.render(100);
    expect(lines[0]).toContain('$0.03');
    expect(bar.getState().rows.length).toBe(1);
  });

  it('keeps the cost on the last rung at 40 columns (#346 review)', () => {
    // A realistic resumed session: the token counters are wide enough that
    // the old tail-truncating rung cut the `$` off entirely.
    const rows = [
      row({
        usage: {
          ...priced().usage,
          input: 120345,
          output: 7890,
          cacheRead: 90000,
        },
      }),
    ];
    const lines = renderStatusLines(state({ rows }), 40);
    expect(statusVisibleWidth(lines[0])).toBeLessThanOrEqual(40);
    expect(lines[0]).toContain('$');
    expect(lines[0]).toContain('…');
  });

  it('never renders a TTFT or tool-ms segment (issue #346 deleted them)', () => {
    const lines = renderStatusLines(state({ rows: [priced()] }), 100);
    expect(lines[0]).not.toContain('TTFT');
    expect(lines[0]).not.toContain('tool ');
  });

  it('truncates the model with an ellipsis when exactly 4 columns remain', () => {
    const lines = renderStatusLines(state({ rows: [priced()] }), 40);
    expect(statusVisibleWidth(lines[0])).toBe(40);
    // The ellipsis lands on the model (3 chars + '…'), not on the tail.
    expect(stripSgr(lines[0])).toBe('tes… • in 100 out 50 (cached 20) • $0.03');
  });

  it('returns the full line when it fits the width exactly', () => {
    const lines = renderStatusLines(state({ rows: [priced()] }), 74);
    expect(statusVisibleWidth(lines[0])).toBe(74);
    expect(lines[0]).toContain('thinking medium');
    expect(lines[0]).not.toContain('…');
  });

  it('keeps the session stub at 34 cols where 4 columns remain', () => {
    const lines = renderStatusLines(state({ rows: [priced()] }), 34);
    expect(lines[1]).toBe('solo • approvals:on • session ses…');
  });

  it('keeps warning color through the final narrow-OFF fallback at 47 cols', () => {
    const lines = renderStatusLines(
      state({ rows: [priced()], approvalsSkipped: true }),
      47,
    );
    expect(statusVisibleWidth(lines[1])).toBeLessThanOrEqual(47);
    expect(lines[1]).toContain('OFF');
    expect(lines[1]).toContain(`${ESC}[`);
  });
});
