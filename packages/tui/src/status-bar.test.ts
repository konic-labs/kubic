// Slice A RED: session aggregates from usage rows (issue #27; §39).
// Fixture rows must sum to exact session cost/tokens with the cache
// split kept; TTFT/tool-ms are last-wins (latest row reporting wins).
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

  it('resolves TTFT/tool-ms last-wins from the latest reporting row', () => {
    const summary = summarizeStatusRows([
      row({ ttftMs: 100, latencyMs: 40 }),
      row({ ttftMs: 250, latencyMs: 60 }),
      row({}),
    ]);
    expect(summary.ttftMs).toBe(250);
    expect(summary.toolMs).toBe(60);
  });

  it('empty rows aggregate without NaN and format $0.00', () => {
    const summary = summarizeStatusRows([]);
    expect(summary.requests).toBe(0);
    expect(summary.ttftMs).toBeUndefined();
    expect(formatStatusCost(summary.costTotal)).toBe('$0.00');
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
    ttftMs: 120,
    latencyMs: 45,
    ...over,
  };
}

describe('status bar rows (issue #27, slice B)', () => {
  it('renders model/thinking/tokens/cache/cost/TTFT/tool + mode/approvals/session', () => {
    const lines = renderStatusLines(state({ rows: [priced()] }), 100);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('test/model-long-name');
    expect(lines[0]).toContain('medium');
    expect(lines[0]).toContain('100');
    expect(lines[0]).toContain('cached 20');
    expect(lines[0]).toContain('$0.03');
    expect(lines[0]).toContain('120ms');
    expect(lines[0]).toContain('45ms');
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

  it('truncates the model first at 70 cols, keeps $ and mode', () => {
    const full = 'test/model-long-name';
    const lines = renderStatusLines(state({ rows: [priced()] }), 70);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(statusVisibleWidth(line)).toBeLessThanOrEqual(70);
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
      const lines = bar.render(width);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(statusVisibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(skipped.render(100)[1]).toContain('OFF');
    expect(basic.render(60)[1]).toContain('solo');
  });
});
