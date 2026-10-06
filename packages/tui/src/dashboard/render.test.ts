// The orchestrator dashboard's rows (issue #465; docs/ui 04-A, 04-B, 04-C,
// 04-E): headless renders of the model at 140, 120 and 90 columns, the empty
// run, a finished run, a failed worker and budgets near and over a limit.
import { describe, expect, it } from 'vitest';
import type {
  KubicPresentationState,
  RunPhaseState,
  WorkerSummary,
} from '../../../core/src/presentation.js';
import { createUiTheme } from '../../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../../core/src/ui/tokens.js';
import { visibleWidth } from '../tui-boundary.js';
import {
  clock,
  compactTokens,
  dashboardListWidth,
  renderDashboardBody,
  renderDashboardFooter,
  renderDashboardHeader,
  renderDispatchBox,
  renderTimeline,
  renderWorkerList,
  workerViewLines,
} from './render.js';
import { type DashboardLimits, dashboardModel } from './state.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const color = createUiTheme(DARK_PALETTE, 'truecolor');
const SPIN = '⠹';

function presentation(
  workers: readonly WorkerSummary[],
  runPhases: readonly RunPhaseState[],
): KubicPresentationState {
  return {
    session: {
      sessionId: 's',
      mode: 'orchestrator',
      approvalsSkipped: false,
      runPhases,
    },
    agents: new Map(),
    lanes: new Map(),
    workers: new Map(workers.map((worker) => [worker.workerId, worker])),
    approvals: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    connection: { status: 'connected' },
  };
}

const LIVE_PHASES: RunPhaseState[] = [
  { phase: 'plan', state: 'done', at: 31_000, startedAt: 0 },
  { phase: 'implement', state: 'running', at: 31_000, startedAt: 31_000 },
];

const LIVE: WorkerSummary[] = [
  {
    workerId: 'worker-1',
    role: 'implementer',
    task: 'titleCase()',
    status: 'completed',
    startedAt: 31_000,
    endedAt: 171_000,
    inputTokens: 9_000,
    outputTokens: 1_000,
    diffStat: { files: 2, added: 9, removed: 1 },
    toolCount: 7,
  },
  {
    workerId: 'worker-2',
    role: 'implementer',
    task: 'cart clear()',
    status: 'running',
    startedAt: 32_000,
    toolCount: 12,
    activity: {
      id: 'c',
      tool: 'edit',
      target: 'src/cart.js',
      state: 'running',
      at: 1,
    },
    workspace: '/repo/.kubic/wt/run/worker-2',
    model: 'claude-sonnet-5-5',
    generation: 1,
  },
  {
    workerId: 'worker-3',
    role: 'reviewer',
    task: 'review w1',
    status: 'running',
    startedAt: 180_000,
    awaiting: { approvalKey: 'k', summary: 'approve merge of worker-1?' },
  },
  { workerId: 'worker-4', task: 'format tests', status: 'queued' },
];

function live(limits?: DashboardLimits, filter?: string) {
  return dashboardModel(presentation(LIVE, LIVE_PHASES), {
    now: 222_000,
    task: 'add cart clear() and format tests',
    branch: 'main',
    ...(limits === undefined ? {} : { limits }),
    ...(filter === undefined ? {} : { filter }),
  });
}

const widthsOf = (lines: readonly string[]): number[] =>
  lines.map((line) => visibleWidth(line));

describe('dashboard header and timeline (issue #465)', () => {
  it('carries the badge, objective, branch and live counts', () => {
    const line = renderDashboardHeader(plain, live(), 140, SPIN);
    expect(
      line.startsWith(
        ' ■ KUBIC  │ [ORCHESTRATE]  add cart clear() and format tests  ⎇ main ',
      ),
    ).toBe(true);
    expect(line.endsWith(' ◆ 1 awaiting │ ⠹ 1 working │ ✓ 1 done │ ✕ 0 ')).toBe(
      true,
    );
    expect(visibleWidth(line)).toBe(140);
  });

  it('cuts the objective, then compacts the counts, as the row narrows', () => {
    const at90 = renderDashboardHeader(plain, live(), 90, SPIN);
    expect(at90).toContain('⎇ main');
    expect(at90).toContain('◆ 1 awaiting');
    expect(at90).toContain('add cart');
    expect(visibleWidth(at90)).toBe(90);
    const at50 = renderDashboardHeader(plain, live(), 50, SPIN);
    expect(at50).toContain('◆1 ⠹1 ✓1 ✕0');
    expect(visibleWidth(at50)).toBe(50);
  });

  it('shows where the plan is, and how long the run has gone', () => {
    const line = renderTimeline(plain, live(), 140, SPIN);
    expect(
      line.startsWith(
        ` RUN  ✓ plan ━━━━━ ${SPIN} implement ×2 ━━━━━ ○ review ━━━━━ ○ merge ━━━━━ ○ verify `,
      ),
    ).toBe(true);
    expect(line.endsWith(' elapsed 3:42 ')).toBe(true);
    expect(visibleWidth(line)).toBe(140);
    const narrow = renderTimeline(plain, live(), 90, SPIN);
    expect(narrow).toContain('○ verify');
    expect(narrow).toContain('elapsed 3:42');
    expect(visibleWidth(narrow)).toBe(90);
  });

  it('marks a failed phase and strikes a skipped one', () => {
    const model = dashboardModel(
      presentation(
        [],
        [
          { phase: 'plan', state: 'done', at: 1, startedAt: 0 },
          { phase: 'implement', state: 'failed', at: 2, startedAt: 1 },
          { phase: 'review', state: 'skipped', at: 2 },
        ],
      ),
      { now: 3 },
    );
    expect(renderTimeline(plain, model, 120, SPIN)).toContain(
      '✕ implement ━━━━━ ○ review',
    );
    // Strike (SGR 9) on the skipped name only.
    const struck = renderTimeline(color, model, 120, SPIN);
    const at = struck.indexOf('review');
    const opener = struck.lastIndexOf('\u001b[', at);
    expect(struck.slice(opener, at)).toMatch(/[;[]9[;m]/);
  });
});

describe('dashboard workers (issue #465)', () => {
  it('lists awaiting first, then working, done and queued at 140 columns', () => {
    const lines = renderDashboardBody(plain, live(), {
      selected: 'worker-2',
      width: 140,
      maxRows: 30,
      spinner: SPIN,
    });
    expect(widthsOf(lines).every((w) => w === 140)).toBe(true);
    const list = lines.slice(2).map((line) => line.slice(0, 50).trimEnd());
    expect(list).toEqual([
      ' AWAITING YOU',
      ' ◆ worker-3  approve merge of worker-1?      0:42',
      '',
      ' WORKING',
      `▌${SPIN} worker-2  cart clear()                    3:10`,
      '      edit src/cart.js · 12 tools',
      '',
      ' DONE',
      ' ✓ worker-1  titleCase()                     2:20',
      '      +9 −1 · 2 files · 7 tools · 10k tok',
      '',
      ' QUEUED',
      ' ○ worker-4  format tests',
    ]);
    // The side column names the selected worker.
    expect(lines[2]?.slice(51)).toContain('worker-2 · cart clear()');
    expect(lines[2]?.slice(51)).toContain('worktree worker-2');
    expect(lines[3]).toContain(
      'role implementer · model claude-sonnet-5-5 · generation 1',
    );
    expect(lines[2]?.[50]).toBe('│');
  });

  it('gives the list 40% under 120 columns and the whole row under 100', () => {
    expect(dashboardListWidth(140)).toBe(50);
    expect(dashboardListWidth(110)).toBe(44);
    expect(dashboardListWidth(90)).toBe(90);
    const at120 = renderDashboardBody(plain, live(), {
      selected: 'worker-2',
      width: 120,
      maxRows: 30,
      spinner: SPIN,
    });
    expect(widthsOf(at120).every((w) => w === 120)).toBe(true);
    const at90 = renderDashboardBody(plain, live(), {
      selected: 'worker-2',
      width: 90,
      maxRows: 30,
      spinner: SPIN,
    });
    expect(widthsOf(at90).every((w) => w === 90)).toBe(true);
    expect(at90.join('\n')).not.toContain('│');
    expect(at90.join('\n')).toContain('worker-4  format tests');
  });

  it('raises the selected worker and tints the one waiting on you', () => {
    const lines = renderWorkerList(color, live(), {
      selected: 'worker-2',
      width: 50,
      maxRows: 30,
      spinner: SPIN,
    });
    const bg3 = '\u001b[48;2;34;34;42m';
    const warnBg = '\u001b[48;2;42;29;7m';
    expect(lines.find((line) => line.includes('worker-2'))).toContain(bg3);
    expect(lines.find((line) => line.includes('worker-3'))).toContain(warnBg);
    expect(lines.find((line) => line.includes('worker-1'))).not.toContain(bg3);
  });

  it('windows a long list around the selection and says what it hides', () => {
    const many: WorkerSummary[] = Array.from({ length: 12 }, (_, i) => ({
      workerId: `worker-${i + 1}`,
      task: `task ${i + 1}`,
      status: 'running',
      startedAt: 0,
    }));
    const model = dashboardModel(presentation(many, LIVE_PHASES), { now: 1 });
    const lines = renderWorkerList(plain, model, {
      selected: 'worker-12',
      width: 50,
      maxRows: 8,
      spinner: SPIN,
    });
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/↑ \d+ more/);
    expect(lines.join('\n')).toContain('worker-12');
    // In the middle both ways are named; at the top only what is below.
    const middle = renderWorkerList(plain, model, {
      selected: 'worker-6',
      width: 50,
      maxRows: 8,
      spinner: SPIN,
    });
    expect(middle).toHaveLength(8);
    expect(middle[0]).toMatch(/↑ \d+ more/);
    expect(middle[7]).toMatch(/↓ \d+ more/);
    expect(middle.join('\n')).toContain('worker-6');
    const top = renderWorkerList(plain, model, {
      selected: 'worker-1',
      width: 50,
      maxRows: 8,
      spinner: SPIN,
    });
    expect(top).toHaveLength(8);
    expect(top[0]).toContain('WORKING');
    expect(top[7]).toMatch(/↓ \d+ more/);
  });

  it('marks a failed worker and names how it ended', () => {
    const model = dashboardModel(
      presentation(
        [
          {
            workerId: 'worker-1',
            status: 'failed',
            startedAt: 0,
            endedAt: 9_000,
          },
        ],
        [{ phase: 'implement', state: 'failed', at: 9_000, startedAt: 0 }],
      ),
      { now: 10_000 },
    );
    const lines = renderWorkerList(plain, model, {
      selected: 'worker-1',
      width: 50,
      maxRows: 10,
      spinner: SPIN,
    });
    expect(lines[1]).toContain('✕ worker-1');
    expect(lines[2]).toContain('failed');
  });

  it('says what an empty dashboard is waiting for', () => {
    const none = dashboardModel(presentation([], []), { now: 0 });
    expect(
      renderWorkerList(plain, none, {
        width: 60,
        maxRows: 5,
        spinner: SPIN,
      })[0],
    ).toContain('no run yet');
    const planning = dashboardModel(
      presentation(
        [],
        [{ phase: 'plan', state: 'running', at: 0, startedAt: 0 }],
      ),
      { now: 0 },
    );
    expect(
      renderWorkerList(plain, planning, {
        width: 60,
        maxRows: 5,
        spinner: SPIN,
      })[0],
    ).toContain('the run is planning');
    expect(
      renderWorkerList(plain, live(undefined, 'zzz'), {
        width: 60,
        maxRows: 5,
        spinner: SPIN,
      })[0],
    ).toContain('no worker matches “zzz”');
  });

  it('shows a finished run with every phase settled', () => {
    const model = dashboardModel(
      presentation(
        [
          {
            workerId: 'worker-1',
            status: 'completed',
            startedAt: 0,
            endedAt: 60_000,
          },
          {
            workerId: 'worker-2',
            status: 'completed',
            startedAt: 0,
            endedAt: 90_000,
          },
        ],
        [
          { phase: 'plan', state: 'done', at: 1_000, startedAt: 0 },
          { phase: 'implement', state: 'done', at: 90_000, startedAt: 1_000 },
          { phase: 'review', state: 'skipped', at: 90_000 },
          { phase: 'merge', state: 'done', at: 95_000, startedAt: 90_000 },
          { phase: 'verify', state: 'skipped', at: 95_000 },
        ],
      ),
      { now: 500_000 },
    );
    expect(renderTimeline(plain, model, 120, SPIN)).toContain('elapsed 1:35');
    expect(renderDashboardHeader(plain, model, 120, SPIN)).toContain(
      '◆ 0 awaiting │ ⠋ 0 working │ ✓ 2 done │ ✕ 0',
    );
  });
});

describe('dashboard run budget (issue #465)', () => {
  it('shows spend plainly when the run has no limits', () => {
    const [ruleLine, row] = renderDashboardFooter(plain, live(), 120);
    expect(ruleLine).toBe('─'.repeat(120));
    expect(row?.trimEnd()).toBe(
      ' RUN BUDGET  no limits  ·  tokens 10k  ·  cost $0.00  ·  wall 3:42',
    );
  });

  it('draws gauges against the limits, warn at 80% and err at 100%', () => {
    const near = renderDashboardFooter(
      plain,
      live({ maxTokens: 12_000, maxCostUsd: 2, maxRuntimeMs: 30 * 60_000 }),
      140,
    )[1];
    expect(near).toContain('tokens ━━━━━━━━━━── 83% of 12k');
    expect(near).toContain('cost ──────────── $0.00 / $2.00');
    expect(near).toContain('wall ━───────────');
    expect(near).toContain('3:42 / 30:00');
    const warn = renderDashboardFooter(
      color,
      live({ maxTokens: 12_000 }),
      140,
    )[1];
    const over = renderDashboardFooter(
      color,
      live({ maxTokens: 9_000 }),
      140,
    )[1];
    const warnFg = color.open({ fg: 'warn' });
    const errFg = color.open({ fg: 'err' });
    expect(warn).toContain(warnFg);
    expect(over).toContain(errFg);
  });

  it('formats tokens and clocks compactly', () => {
    expect([950, 1_200, 18_400, 400_000, 1_250_000].map(compactTokens)).toEqual(
      ['950', '1.2k', '18k', '400k', '1.3M'],
    );
    expect([42_000, 190_000, 3_725_000].map(clock)).toEqual([
      '0:42',
      '3:10',
      '1:02:05',
    ]);
  });
});

describe('dispatch box and worker view (issue #466)', () => {
  it('frames the box and names who a message goes to', () => {
    const lines = renderDispatchBox(
      plain,
      {
        mode: 'message',
        text: '',
        focused: false,
        role: 'implementer',
        target: 'worker-2',
      },
      80,
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ ┌─ dispatch ─+┐ $/);
    expect(lines[1]).toContain(
      '› message worker-2, or ^N to dispatch a new worker',
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(80);
  });

  it('titles a new worker by its role and keeps a long draft in view', () => {
    const lines = renderDispatchBox(
      plain,
      { mode: 'new', text: 'x'.repeat(200), focused: true, role: 'tester' },
      60,
    );
    expect(lines[0]).toContain('new tester worker');
    expect(lines[1]).toContain('› …');
    expect(lines[1]).toContain('▏');
    for (const line of lines) expect(visibleWidth(line)).toBe(60);
  });

  it('lists the facts, every call and where the rest lives', () => {
    const found = live().workers.find(
      (entry) => entry.worker.workerId === 'worker-2',
    );
    if (found === undefined) throw new Error('fixture worker missing');
    const row = {
      ...found,
      worker: {
        ...found.worker,
        recentTools: [
          {
            id: 'c',
            tool: 'edit',
            target: 'src/cart.js',
            state: 'done' as const,
            at: 1,
          },
        ],
      },
    };
    const lines = workerViewLines(row, () => ['  ● edit  src/cart.js'], 80);
    expect(lines[0]).toBe('task: cart clear()');
    expect(lines).toContain('  ● edit  src/cart.js');
    expect(lines.at(-1)).toBe('more: kubic workers inspect worker-2');
  });
});
