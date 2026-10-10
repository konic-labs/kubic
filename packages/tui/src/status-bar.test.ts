// Session aggregates from usage rows.
// Fixture rows must sum to exact session cost/tokens with the cache split
// kept. The bar renders only what the lane really reports (Pi 1.0 routes no
// timing Kubic can read, so there is no TTFT or tool-ms segment). The bar is
// one row: plain text at depth none reads like the design.

import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import {
  compactCount,
  formatStatusCost,
  renderStatusLine,
  StatusBar,
  type StatusBarState,
  type StatusUsageRow,
  summarizeStatusRows,
} from './status-bar.js';
import { spinnerFrame } from './theme.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');
const NOW = 1_000_000;

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

describe('status aggregates', () => {
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
});

function state(over: Partial<StatusBarState>): StatusBarState {
  return {
    model: 'test/model-long-name',
    thinking: 'medium',
    rows: [],
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

const line = (over: Partial<StatusBarState>, width: number): string =>
  renderStatusLine(state(over), width, plain, NOW);

const between = (left: string, right: string, width: number): string =>
  `${left}${' '.repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

describe('status line', () => {
  it('renders model · thinking, cost and the state word on one row', () => {
    expect(line({ rows: [priced()] }, 100)).toBe(
      between(' ● test/model-long-name · medium  │  $0.033', 'ready ', 100),
    );
    expect(new StatusBar(state({})).render(100)).toHaveLength(1);
  });

  it('matches the design row: gauge, window, cost and journal count', () => {
    const full = line(
      {
        model: 'claude-sonnet-5-5',
        thinking: 'high',
        rows: [
          row({
            usage: {
              ...priced().usage,
              cost: { ...priced().usage.cost, total: 0.031 },
            },
          }),
        ],
        contextTokens: 62000,
        contextWindow: 200000,
        journalChanges: 2,
      },
      120,
    );
    expect(full).toBe(
      between(
        ' ● claude-sonnet-5-5 · high  │  ctx ━━━─────── 31% of 200k  │  $0.031  │  journal 2 changes',
        'ready ',
        120,
      ),
    );
  });

  it('names each turn state on the right, with the spinner while working', () => {
    expect(line({ turn: 'working', busySince: NOW - 160 }, 80)).toMatch(
      new RegExp(`^ ${spinnerFrame(160)} .* working $`),
    );
    expect(line({ turn: 'approval' }, 80).endsWith(' needs approval ')).toBe(
      true,
    );
    expect(line({ turn: 'cancelling' }, 80).endsWith(' cancelling… ')).toBe(
      true,
    );
    expect(line({ turn: 'error' }, 80).endsWith(' error ')).toBe(true);
    const working = renderStatusLine(
      state({ turn: 'working', busySince: NOW }),
      80,
      rich,
      NOW,
    );
    expect(working).toContain(rich.fg('accent')('working'));
    expect(renderStatusLine(state({}), 80, rich, NOW)).toContain(
      rich.fg('ok')('ready'),
    );
  });

  it('counts journal changes in the singular and hides zero', () => {
    expect(line({ journalChanges: 1 }, 100)).toContain('journal 1 change ');
    expect(line({ journalChanges: 0 }, 100)).not.toContain('journal');
  });

  it('drops the window, journal, gauge, thinking and ctx in that order', () => {
    const busy: Partial<StatusBarState> = {
      rows: [priced()],
      contextTokens: 420,
      contextWindow: 1000,
      journalChanges: 3,
    };
    const at = (width: number): string => line(busy, width);
    expect(at(110)).toContain('ctx ━━━━────── 42% of 1k');
    expect(at(110)).toContain('journal 3 changes');
    expect(at(100)).not.toContain('of 1k');
    expect(at(100)).toContain('journal 3 changes');
    expect(at(90)).not.toContain('journal');
    expect(at(90)).toContain('ctx ━━━━────── 42%');
    expect(at(70)).toContain('ctx 42%');
    expect(at(70)).toContain('· medium');
    expect(at(60)).not.toContain('· medium');
    expect(at(60)).toContain('ctx 42%');
    expect(at(50)).not.toContain('ctx');
    expect(at(45)).toContain('test/model-long-name');
  });

  it('cuts the model last and keeps the cost and the state word', () => {
    for (const width of [44, 40, 32]) {
      const narrow = line(
        { rows: [priced()], approvalsSkipped: true, turn: 'approval' },
        width,
      );
      expect(visibleWidth(narrow)).toBe(width);
      expect(narrow).toContain('$0.033');
      expect(narrow.endsWith(' needs approval ')).toBe(true);
      expect(narrow).toContain('…');
    }
    expect(line({ rows: [priced()] }, 24)).toBe(' ● te…  │  $0.033 ready ');
    expect(line({ rows: [priced()] }, 20)).toBe(
      between(' ● $0.033', 'ready ', 20),
    );
  });

  it('is exactly the width at every width, painted on bg1', () => {
    const open = rich.open({ bg: 'bg1' });
    for (const width of [20, 40, 60, 80, 100, 120, 200]) {
      const over = {
        contextTokens: 420,
        contextWindow: 1000,
        journalChanges: 2,
      };
      expect(visibleWidth(line(over, width))).toBe(width);
      const painted = renderStatusLine(state(over), width, rich, NOW);
      expect(visibleWidth(painted)).toBe(width);
      expect(painted.startsWith(open)).toBe(true);
    }
  });

  it('renders nothing for a zero or non-finite width', () => {
    for (const width of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(line({ rows: [priced()] }, width)).toBe('');
    }
  });

  it('never renders a TTFT or tool-ms segment', () => {
    const text = line({ rows: [priced()] }, 120);
    expect(text).not.toContain('TTFT');
    expect(text).not.toContain('tool ');
  });

  it('keeps the posture in its state for the header', () => {
    const bar = new StatusBar(state({}));
    bar.setApprovalsSkipped(true);
    expect(bar.getState().approvalsSkipped).toBe(true);
    bar.setApprovalsSkipped(false);
    expect(bar.getState().approvalsSkipped).toBe(false);
  });

  it('propagates setRows to the rendered cost within one frame', () => {
    const bar = new StatusBar(state({ rows: [] }));
    expect(bar.render(100)[0]).toContain('$0.00');
    bar.setRows([priced()]);
    expect(bar.render(100)[0]).toContain('$0.033');
    expect(bar.getState().rows.length).toBe(1);
  });

  it('writes context windows the way people say them', () => {
    expect(compactCount(200000)).toBe('200k');
    expect(compactCount(128000)).toBe('128k');
    expect(compactCount(1048576)).toBe('1M');
    expect(compactCount(1500000)).toBe('1.5M');
    expect(compactCount(512)).toBe('512');
  });
});

describe('context-window gauge', () => {
  // A measured context of 420 tokens against a 1000-token window: `ctx 42%`.
  it('renders 42% for a 1000-token window and a 420-token context', () => {
    expect(line({ contextTokens: 420, contextWindow: 1000 }, 100)).toContain(
      '42%',
    );
  });

  it('hides the gauge when the context window is unknown', () => {
    expect(line({ contextTokens: 420 }, 100)).not.toContain('ctx');
  });

  it('hides the gauge until the context is measured', () => {
    expect(line({ rows: [priced()], contextWindow: 1000 }, 100)).not.toContain(
      'ctx',
    );
  });

  it('reads the measured context, never the usage rows', () => {
    // The rows are spend: a resumed session's seeded buckets are cumulative,
    // and even a committed response's own prompt leaves out its reply and
    // everything committed after it.
    const response = row({
      entryId: 'e1',
      usage: { ...priced().usage, input: 900, cacheRead: 0, cacheWrite: 0 },
    });
    const text = line(
      { rows: [response], contextTokens: 120, contextWindow: 1000 },
      100,
    );
    expect(text).toContain(' 12% of 1k');
    expect(text).not.toContain('90%');
  });

  it('warns at or above the compaction threshold, never below it', () => {
    const below = renderStatusLine(
      state({
        contextTokens: 420,
        contextWindow: 1000,
        compactionThreshold: 500,
      }),
      100,
      rich,
      NOW,
    );
    expect(below).toContain(rich.fg('fg1')('42%'));
    expect(below).not.toContain(rich.fg('warn')('42%'));
    const at = renderStatusLine(
      state({
        contextTokens: 420,
        contextWindow: 1000,
        compactionThreshold: 420,
      }),
      100,
      rich,
      NOW,
    );
    expect(at).toContain(rich.fg('warn')('42%'));
    expect(at).toContain(rich.fg('warn')('━━━━'));
  });

  it('clamps a window smaller than the context instead of exceeding 100%', () => {
    expect(line({ contextTokens: 420, contextWindow: 100 }, 100)).toContain(
      'ctx ━━━━━━━━━━ 100%',
    );
  });
});

describe('status bar spend and usage rows', () => {
  it('floors sub-cent spend to <$0.01 instead of $0.00', () => {
    expect(formatStatusCost(0)).toBe('$0.00');
    expect(formatStatusCost(0.001)).toBe('<$0.01');
    expect(formatStatusCost(0.0049)).toBe('<$0.01');
    expect(formatStatusCost(0.005)).toBe('$0.01');
    expect(formatStatusCost(0.033)).toBe('$0.03');
  });

  it('mirrors agent KubicUsageRow field-for-field (drift guard)', () => {
    // Structural mirror of packages/agent/src/usage.ts KubicUsageRow,
    // hand-copied because dep-lint forbids tui → agent imports: a shape
    // change on either side fails here loudly instead of drifting.
    interface ExpectedAgentCost {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly total: number;
    }
    interface ExpectedAgentUsage {
      readonly input: number;
      readonly output: number;
      readonly cacheRead: number;
      readonly cacheWrite: number;
      readonly totalTokens: number;
      readonly cost: ExpectedAgentCost;
    }
    interface ExpectedAgentRow {
      readonly model: string;
      readonly provider: string;
      readonly usage: ExpectedAgentUsage;
      readonly toolCallId?: string;
      readonly entryId?: string;
    }
    // Type-level: assignability holds in both directions.
    const probe: StatusUsageRow = row({
      toolCallId: 'tool-1',
      entryId: 'entry-1',
    });
    const asExpected: ExpectedAgentRow = probe;
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

describe('a turn of auto-approved edits', () => {
  it('says so beside the state word while it applies', () => {
    const line = renderStatusLine(
      state({ turn: 'working', turnEdits: true }),
      120,
      plain,
      NOW,
    );
    expect(line).toContain('edits auto-approved this turn  │  working');
    expect(
      renderStatusLine(state({ turn: 'working' }), 120, plain, NOW),
    ).not.toContain('auto-approved');
  });
});
