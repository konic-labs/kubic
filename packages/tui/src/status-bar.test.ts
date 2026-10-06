// Slice A: session aggregates from usage rows (issue #27; §39).
// Fixture rows must sum to exact session cost/tokens with the cache
// split kept. Issue #346 deleted the TTFT/tool-ms segments (Pi 1.0 routes
// no timing Kubic can read); the bar renders what the lane really reports.
// Issue #453 made the bar one row (docs/ui 01-L): plain text at depth none
// reads like the design.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../core/src/ui/tokens.js';
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

const line = (over: Partial<StatusBarState>, width: number): string =>
  renderStatusLine(state(over), width, plain, NOW);

const between = (left: string, right: string, width: number): string =>
  `${left}${' '.repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

// A committed request whose prompt was `input + cacheRead` tokens.
function requestRow(input: number, cacheRead: number): StatusUsageRow {
  return row({
    entryId: 'e1',
    usage: { ...priced().usage, input, cacheRead, cacheWrite: 0 },
  });
}

describe('status line (issue #453; 01-L)', () => {
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
            entryId: 'e1',
            usage: {
              ...priced().usage,
              input: 62000,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { ...priced().usage.cost, total: 0.031 },
            },
          }),
        ],
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

  it('drops the window, journal, gauge, thinking, ctx, budget in that order', () => {
    const busy: Partial<StatusBarState> = {
      rows: [requestRow(300, 120)],
      contextWindow: 1000,
      journalChanges: 3,
      budget: { limits: { maxToolCalls: 10 }, toolCalls: 2 },
    };
    const at = (width: number): string => line(busy, width);
    expect(at(130)).toContain('ctx ━━━━────── 42% of 1k');
    expect(at(130)).toContain('journal 3 changes');
    expect(at(120)).not.toContain('of 1k');
    expect(at(120)).toContain('journal 3 changes');
    expect(at(100)).not.toContain('journal');
    expect(at(100)).toContain('ctx ━━━━────── 42%');
    expect(at(90)).toContain('ctx 42%');
    expect(at(90)).toContain('· medium');
    expect(at(80)).not.toContain('· medium');
    expect(at(80)).toContain('ctx 42%');
    expect(at(70)).not.toContain('ctx');
    expect(at(70)).toContain('budget tools 2/10');
    expect(at(50)).not.toContain('budget');
    expect(at(50)).toContain('test/model-long-name');
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
        rows: [requestRow(300, 120)],
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

  it('never renders a TTFT or tool-ms segment (issue #346 deleted them)', () => {
    const text = line({ rows: [priced()] }, 120);
    expect(text).not.toContain('TTFT');
    expect(text).not.toContain('tool ');
  });

  it('keeps the posture and mode in its state for the header', () => {
    const bar = new StatusBar(state({}));
    bar.setApprovalsSkipped(true);
    bar.setMode('orchestrator');
    expect(bar.getState().approvalsSkipped).toBe(true);
    expect(bar.getState().mode).toBe('orchestrator');
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

describe('budget burn-down (issue #285; §71)', () => {
  // The line names the §71 limits with live burn-down — tools from the
  // attempt count the boot feeds in, tokens/cost from the usage rows —
  // and stays silent when no limit is set.
  it("renders 'budget tools 3/10' when a limit is set", () => {
    const text = line(
      {
        rows: [
          priced({
            usage: {
              ...priced().usage,
              cost: { ...priced().usage.cost, total: 0.12 },
            },
          }),
        ],
        budget: { limits: { maxToolCalls: 10, maxCostUsd: 0.5 }, toolCalls: 3 },
      },
      120,
    );
    expect(text).toContain('budget tools 3/10 · $0.12/$0.50');
  });

  it('renders nothing budget-shaped when no limit is set', () => {
    expect(line({ rows: [priced()] }, 120)).not.toContain('budget');
  });

  it('renders the limit text when only wall-clock is bounded', () => {
    expect(
      line({ budget: { limits: { maxRuntimeMs: 60000 }, toolCalls: 0 } }, 120),
    ).toContain('budget wall≤60s');
  });

  it('warns once a dimension is breached', () => {
    const over = state({
      budget: { limits: { maxToolCalls: 2 }, toolCalls: 3 },
    });
    expect(renderStatusLine(over, 120, rich, NOW)).toContain(
      rich.style({ fg: 'warn', bold: true })('budget tools 3/2'),
    );
  });
});

describe('context-window gauge (issue #347; §18)', () => {
  // A committed request whose prompt was 420 tokens (300 new + 120 cached)
  // against a 1000-token window: `ctx 42%`.
  it('renders 42% for a 1000-token window and a 420-token request', () => {
    expect(
      line({ rows: [requestRow(300, 120)], contextWindow: 1000 }, 100),
    ).toContain('42%');
  });

  it('hides the gauge when the context window is unknown', () => {
    expect(line({ rows: [requestRow(300, 120)] }, 100)).not.toContain('ctx');
  });

  it('hides the gauge until a committed request reports its prompt size', () => {
    // A seeded cumulative bucket (#346) is not context pressure.
    expect(line({ rows: [priced()], contextWindow: 1000 }, 100)).not.toContain(
      'ctx',
    );
  });

  it('warns at or above the compaction threshold, never below it', () => {
    const rows = [requestRow(300, 120)];
    const below = renderStatusLine(
      state({ rows, contextWindow: 1000, compactionThreshold: 500 }),
      100,
      rich,
      NOW,
    );
    expect(below).toContain(rich.fg('fg1')('42%'));
    expect(below).not.toContain(rich.fg('warn')('42%'));
    const at = renderStatusLine(
      state({ rows, contextWindow: 1000, compactionThreshold: 420 }),
      100,
      rich,
      NOW,
    );
    expect(at).toContain(rich.fg('warn')('42%'));
    expect(at).toContain(rich.fg('warn')('━━━━'));
  });

  it('clamps a window smaller than the request instead of exceeding 100%', () => {
    expect(
      line({ rows: [requestRow(300, 120)], contextWindow: 100 }, 100),
    ).toContain('ctx ━━━━━━━━━━ 100%');
  });

  it('counts the cache-write prefix, not just the reused one (review #347)', () => {
    // The first request of a session (or one after the cache TTL lapses)
    // writes the whole prefix: pi's `input` is then only the new user text,
    // and a gauge that ignored cacheWrite would read 0% while the context is
    // nearly 7% of a 128k window.
    const rowWithWrite = row({
      entryId: 'e1',
      usage: { ...priced().usage, input: 30, cacheRead: 0, cacheWrite: 9000 },
    });
    const summary = summarizeStatusRows([rowWithWrite]);
    expect(summary.contextTokens).toBe(9030);
    const text = line({ rows: [rowWithWrite], contextWindow: 128000 }, 120);
    expect(text).toContain(' 7% of 128k');
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
