// The selected worker's preview (issue #466; docs/ui 04-D): meta rows, the
// worker's recent calls as the transcript's own cards (a diff as a diff
// block), how it ended, its budget — at 60 and 80 columns.
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerSummary } from '../../../core/src/presentation.js';
import { createUiTheme } from '../../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../../core/src/ui/tokens.js';
import { createTuiTheme, setTuiTheme } from '../theme.js';
import { visibleWidth } from '../tui-boundary.js';
import { previewCells, renderWorkerPreview, WorkerPreview } from './preview.js';
import type { DashboardWorker } from './state.js';

const plain = createUiTheme(DARK_PALETTE, 'none');

afterEach(() => {
  setTuiTheme(createTuiTheme('none'));
});

const RUNNING: WorkerSummary = {
  workerId: 'worker-2',
  role: 'implementer',
  task: 'cart clear()',
  model: 'claude-sonnet-5-5',
  generation: 1,
  status: 'running',
  workspace: '/repo/.kubic/wt/run/worker-2',
  recentTools: [
    { id: 'c1', tool: 'read', target: 'src/cart.js', state: 'done', at: 1 },
    {
      id: 'c2',
      tool: 'edit',
      target: 'src/cart.js',
      state: 'done',
      outcome: '+2 −0',
      diff: {
        text: ' 21 }\n+22 export function clear(cart) {\n+23   cart.items = [];',
        firstChangedLine: 22,
      },
      at: 2,
    },
    { id: 'c3', tool: 'bash', target: 'npm test', state: 'running', at: 3 },
  ],
};

function row(
  worker: WorkerSummary,
  extra: Partial<DashboardWorker> = {},
): DashboardWorker {
  return { worker, group: 'working', failed: false, ...extra };
}

function render(
  target: DashboardWorker | undefined,
  width: number,
  maxRows = 24,
) {
  setTuiTheme(createTuiTheme('none'));
  const preview = new WorkerPreview(() => 4_000);
  return renderWorkerPreview(plain, target, {
    width,
    maxRows,
    cards: (worker, cardWidth) => preview.cards(worker, cardWidth),
  });
}

describe('worker preview (issue #466)', () => {
  it('builds a card per call and an output for each finished one', () => {
    expect(previewCells(RUNNING).map((cell) => [cell.id, cell.kind])).toEqual([
      ['t:c1', 'tool'],
      ['o:c1', 'output'],
      ['t:c2', 'tool'],
      ['o:c2', 'output'],
      ['t:c3', 'tool'],
    ]);
    expect(previewCells(RUNNING)[3]?.display).toEqual({
      kind: 'diff',
      text: ' 21 }\n+22 export function clear(cart) {\n+23   cart.items = [];',
      firstChangedLine: 22,
      added: 2,
      removed: 0,
    });
  });

  it('shows a running worker with its diff card at 80 and 60 columns', () => {
    for (const width of [80, 60]) {
      const lines = render(row(RUNNING), width);
      expect(lines).toHaveLength(24);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const text = lines.join('\n');
      expect(lines[0]).toContain('worker-2 · cart clear()');
      expect(lines[0]).toContain('worktree worker-2');
      expect(lines[1]).toContain(
        'role implementer · model claude-sonnet-5-5 · generation 1',
      );
      expect(text).toContain('edit');
      expect(text).toContain('export function clear(cart) {');
      expect(text).toContain('npm test');
    }
  });

  it('keeps the newest cards when they do not all fit', () => {
    const lines = render(row(RUNNING), 80, 8);
    expect(lines).toHaveLength(8);
    expect(lines.join('\n')).toContain('npm test');
  });

  it('closes a done worker with its change and its summary', () => {
    const done: WorkerSummary = {
      ...RUNNING,
      status: 'completed',
      recentTools: RUNNING.recentTools?.slice(0, 2),
      diffStat: { files: 2, added: 9, removed: 1 },
      summary: 'Added clear() and its test.',
    };
    const text = render(
      row(done, { group: 'done', elapsedMs: 140_000 }),
      80,
    ).join('\n');
    expect(text).toContain('✓ completed · +9 −1 · 2 files · 2:20');
    expect(text).toContain('Added clear() and its test.');
  });

  it('names why a failed worker failed', () => {
    const failed: WorkerSummary = {
      ...RUNNING,
      status: 'failed',
      recentTools: [],
      failure: 'tests still fail after 3 attempts',
    };
    const text = render(row(failed, { group: 'done', failed: true }), 60).join(
      '\n',
    );
    expect(text).toContain('✕ failed');
    expect(text).toContain('tests still fail after 3 attempts');
    expect(text).toContain('no tool calls reported');
  });

  it('says what a worker with no activity is doing, and burns down a budget', () => {
    const fresh: WorkerSummary = {
      workerId: 'worker-5',
      status: 'running',
      budget: { inputTokens: 0, outputTokens: 0, costUsd: 0.45, limitUsd: 0.5 },
    };
    const text = render(row(fresh), 80).join('\n');
    expect(text).toContain('no tool calls yet');
    expect(text).toContain('WORKER BUDGET');
    expect(text).toContain('cost ━━━━━━━━━━━─ $0.45 / $0.50');
    expect(render(undefined, 60)[0]).toContain('no worker selected');
  });
});
