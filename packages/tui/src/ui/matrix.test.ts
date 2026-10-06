// The render matrix (EPIC N, issue #468; docs/ui README): every surface of
// the new TUI rendered for each palette (dark, light, terminal) × colour
// level (truecolor, 256, 16, none) × width (60, 80, 100, 140). Each line
// must fit its width, carry no escape at depth none, close every style (and
// hyperlink) it opens before it ends, and a surface that paints a background
// must paint it edge to edge. Failures are collected, so one run names them
// all.
import { afterAll, describe, expect, it } from 'vitest';
import type {
  KubicPresentationState,
  WorkerSummary,
} from '../../../core/src/presentation.js';
import type { ColorLevel } from '../../../core/src/ui/color.js';
import {
  createUiTheme,
  openStyles,
  type UiTheme,
} from '../../../core/src/ui/style.js';
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  type Palette,
  TERMINAL_PALETTE,
} from '../../../core/src/ui/tokens.js';
import { renderApprovalCard } from '../approval-card.js';
import { APPROVAL_DEFAULT_KEYS } from '../approval-view.js';
import { BlockViewer } from '../block-viewer.js';
import { keyHintSet, renderHeader } from '../chrome.js';
import { renderWorkerPreview, WorkerPreview } from '../dashboard/preview.js';
import {
  renderDashboardBody,
  renderDashboardFooter,
  renderDashboardHeader,
  renderDispatchBox,
} from '../dashboard/render.js';
import { dashboardModel } from '../dashboard/state.js';
import {
  EDITOR_FRAME_CELLS,
  frameEditorLines,
  renderWorkingLine,
} from '../editor-frame.js';
import { DEFAULT_KEY_REGISTRY } from '../keybindings.js';
import { renderPreflight } from '../preflight.js';
import { renderStatusLine } from '../status-bar.js';
import {
  createThemeFromPalette,
  createTuiTheme,
  setTuiTheme,
} from '../theme.js';
import { createTranscriptView, type TranscriptEntry } from '../transcript.js';
import { visibleWidth } from '../tui-boundary.js';
import { renderKeyHintRow } from './key-hints.js';
import { fitLine } from './line.js';
import { createPalette, renderPalette } from './palette.js';
import { createPicker, renderPicker } from './picker.js';

const PALETTES: ReadonlyArray<readonly [string, Palette]> = [
  ['dark', DARK_PALETTE],
  ['light', LIGHT_PALETTE],
  ['terminal', TERMINAL_PALETTE],
];
const LEVELS: readonly ColorLevel[] = ['truecolor', '256', '16', 'none'];
const WIDTHS = [60, 80, 100, 140];

afterAll(() => {
  setTuiTheme(createTuiTheme('none'));
});

// ── fixtures ─────────────────────────────────────────────────────────────
const LONG =
  'a fairly long line of text that will not fit in sixty columns at all, nor eighty';

const CELLS: TranscriptEntry[] = [
  { id: 'p1', kind: 'prompt', markdown: `› ${LONG}`, timestamp: 0 },
  {
    id: 'h1',
    kind: 'thinking',
    markdown: `The cart adds. ${LONG}`,
    durationMs: 1_200,
  },
  {
    id: 'a1',
    kind: 'text',
    markdown: `Running **the tests** with \`npm test\`:\n\n- ${LONG}\n- two\n\n\`\`\`ts\nconst total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n\`\`\``,
  },
  {
    id: 't1',
    kind: 'tool',
    markdown: 'tool bash',
    detail: `npm test -- ${LONG}`,
    toolCallId: 'c1',
  },
  {
    id: 'o1',
    kind: 'output',
    markdown: `${'ok line\n'.repeat(10)}${LONG}`,
    toolCallId: 'c1',
  },
  {
    id: 't2',
    kind: 'tool',
    markdown: 'tool edit',
    detail: 'src/cart.js',
    toolCallId: 'c2',
  },
  {
    id: 'o2',
    kind: 'output',
    markdown: '',
    toolCallId: 'c2',
    display: {
      kind: 'diff',
      text: ` 9 const total = 0;\n-10 return ${LONG};\n+10 return ${LONG} and more;`,
      firstChangedLine: 10,
      added: 1,
      removed: 1,
    },
  },
  {
    id: 'r1',
    kind: 'receipt',
    markdown: '',
    receipt: {
      outcome: 'completed',
      elapsedMs: 63_000,
      tools: 2,
      files: 1,
      added: 1,
      removed: 1,
      costUsd: 0.0312,
      diffKey: '^O',
    },
  },
];

const WORKERS: WorkerSummary[] = [
  {
    workerId: 'worker-1',
    role: 'implementer',
    task: LONG,
    status: 'running',
    startedAt: 0,
    toolCount: 4,
    workspace: '/repo/.kubic/wt/run/worker-1',
    activity: {
      id: 'c',
      tool: 'edit',
      target: 'src/cart.js',
      state: 'running',
      at: 1,
    },
    recentTools: [
      { id: 'c1', tool: 'read', target: 'src/cart.js', state: 'done', at: 1 },
      {
        id: 'c2',
        tool: 'edit',
        target: 'src/cart.js',
        state: 'done',
        outcome: '+1 −0',
        diff: { text: `+22 ${LONG}`, firstChangedLine: 22 },
        at: 2,
      },
    ],
    budget: { inputTokens: 1, outputTokens: 1, costUsd: 0.45, limitUsd: 0.5 },
  },
  {
    workerId: 'worker-2',
    task: 'format tests',
    status: 'running',
    startedAt: 0,
    awaiting: { approvalKey: 'k', summary: LONG },
  },
  {
    workerId: 'worker-3',
    task: 'docs',
    status: 'failed',
    startedAt: 0,
    endedAt: 5_000,
    failure: LONG,
    diffStat: { files: 2, added: 9, removed: 1 },
  },
  { workerId: 'worker-4', task: 'queued task', status: 'queued' },
];

const STATE: KubicPresentationState = {
  session: {
    sessionId: 's',
    mode: 'orchestrator',
    approvalsSkipped: false,
    runPhases: [
      { phase: 'plan', state: 'done', at: 1, startedAt: 0 },
      { phase: 'implement', state: 'running', at: 1, startedAt: 1 },
      { phase: 'review', state: 'skipped', at: 1 },
    ],
  },
  agents: new Map(),
  lanes: new Map(),
  workers: new Map(WORKERS.map((worker) => [worker.workerId, worker])),
  approvals: [],
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  connection: { status: 'connected' },
};

interface Surface {
  readonly name: string;
  readonly render: (ui: UiTheme, width: number) => string[];
  /** Every line paints a background edge to edge (exactly the width). */
  readonly fullWidth?: boolean;
}

const model = () =>
  dashboardModel(STATE, {
    now: 222_000,
    task: LONG,
    branch: 'feature/a-long-branch-name',
    limits: { maxTokens: 400_000, maxCostUsd: 2, maxRuntimeMs: 1_800_000 },
  });

const SURFACES: Surface[] = [
  {
    name: 'header',
    fullWidth: true,
    render: (ui, width) => [
      renderHeader(
        ui,
        {
          mode: 'solo',
          approvalsSkipped: false,
          project: 'kubic-playground',
          branch: 'feature/a-long-branch-name',
          dirty: 3,
          session: LONG,
          waiting: 2,
          clock: '23:25',
        },
        width,
      ),
    ],
  },
  {
    name: 'status line',
    fullWidth: true,
    render: (ui, width) => [
      renderStatusLine(
        {
          model: 'anthropic/claude-sonnet-5-5',
          thinking: 'high',
          rows: [],
          mode: 'solo',
          approvalsSkipped: false,
          sessionId: 's',
          contextWindow: 200_000,
          turn: 'working',
          busySince: 0,
          journalChanges: 3,
          turnEdits: true,
        },
        width,
        ui,
        5_000,
      ),
    ],
  },
  {
    name: 'key hints',
    render: (ui, width) => {
      const set = keyHintSet('dashboard', DEFAULT_KEY_REGISTRY);
      return [renderKeyHintRow(ui, set.hints, width, set.right)];
    },
  },
  {
    name: 'editor frame',
    render: (ui, width) =>
      // The editor hands the frame rows already fitted to its inner width.
      frameEditorLines(
        ui,
        [fitLine(`› ${LONG}`, width - EDITOR_FRAME_CELLS)],
        width,
        {
          busy: false,
          empty: false,
          hint: '@ file  / cmd',
        },
      ),
  },
  {
    name: 'working line',
    render: (ui, width) => [
      renderWorkingLine(
        ui,
        {
          elapsedMs: 12_000,
          input: 9_200,
          output: 640,
          tools: 3,
          queues: true,
        },
        width,
      ),
    ],
  },
  {
    name: 'transcript (cards, diff, thinking, receipt)',
    render: (_ui, width) => {
      const view = createTranscriptView();
      view.applyLaneSnapshot({ laneId: 'l' }, CELLS, 1);
      view.toggleBlock('t1');
      return view.render(width);
    },
  },
  {
    name: 'approval card',
    render: (ui, width) =>
      renderApprovalCard(
        ui,
        {
          key: 'k',
          capability: 'destructive-shell',
          toolName: 'bash',
          command: `rm -rf ${LONG}`,
          summary: 'rm -rf …',
          justification: LONG,
          editable: true,
        },
        width,
        {
          armed: true,
          allowable: true,
          keys: APPROVAL_DEFAULT_KEYS,
          commandPage: 0,
          position: 1,
          total: 2,
          explain: true,
          cwd: '~/Desktop/kubic-playground',
          pageKey: 'v',
          explainKey: '?',
        },
      ),
  },
  {
    name: 'approval card input',
    render: (ui, width) =>
      renderApprovalCard(
        ui,
        {
          key: 'k',
          capability: 'destructive-shell',
          toolName: 'bash',
          command: 'rm -rf dist',
          editable: true,
        },
        width,
        {
          armed: true,
          allowable: true,
          keys: APPROVAL_DEFAULT_KEYS,
          commandPage: 0,
          position: 1,
          total: 1,
          explain: false,
          pageKey: 'v',
          explainKey: '?',
          input: { kind: 'edit', text: LONG },
        },
      ),
  },
  {
    name: 'palette',
    render: (ui, width) =>
      renderPalette(
        ui,
        createPalette([
          { group: 'commands', value: '/model', text: '/model', detail: LONG },
          {
            group: 'models',
            value: 'm',
            text: 'anthropic/claude-sonnet-5-5',
            meta: '200k  high',
            current: true,
          },
          { group: 'files', value: 'f', text: `src/${LONG}.ts` },
        ]),
        width,
        { input: 'cla', maxRows: 20, keyLabel: '^P' },
      ),
  },
  {
    name: 'picker',
    render: (ui, width) =>
      renderPicker(
        ui,
        createPicker([
          {
            id: 'anthropic',
            title: 'anthropic',
            status: { text: 'key set', ok: true },
            rows: [
              {
                value: 'a',
                text: 'claude-sonnet-5-5',
                right: '200k  high',
                current: true,
              },
              { value: 'b', text: LONG, disabled: true, note: 'no key' },
            ],
          },
        ]),
        width,
        { title: 'switch model', input: '', maxRows: 20 },
      ),
  },
  {
    name: 'preflight',
    render: (ui, width) =>
      renderPreflight(
        ui,
        {
          version: '0.0.0',
          provider: {
            model: 'anthropic/claude-sonnet-5-5',
            keySource: 'ANTHROPIC_API_KEY',
          },
          project: {
            path: `~/Desktop/${LONG}`,
            branch: 'main',
            dirty: 2,
            git: true,
          },
          trust: 'loaded',
          mode: 'solo',
          isolation: LONG,
          keys: { palette: '^P', mode: '^G', help: '?' },
          recent: [{ title: LONG, age: '2h ago', detail: '4 turns' }],
        },
        width,
      ),
  },
  {
    name: 'block viewer',
    render: (ui, width) =>
      new BlockViewer({
        title: `bash ${LONG}`,
        lines: () => Array.from({ length: 30 }, (_, i) => `row ${i} ${LONG}`),
        maxRows: () => 12,
        onCopy: () => {},
        onClose: () => {},
        ui: () => ui,
      }).render(width),
  },
  {
    name: 'dashboard header',
    fullWidth: true,
    render: (ui, width) => [renderDashboardHeader(ui, model(), width, '⠹')],
  },
  {
    name: 'dashboard body',
    render: (ui, width) =>
      renderDashboardBody(ui, model(), {
        selected: 'worker-1',
        width,
        maxRows: 30,
        spinner: '⠹',
      }),
  },
  {
    name: 'dashboard footer and dispatch box',
    render: (ui, width) => [
      ...renderDashboardFooter(ui, model(), width),
      ...renderDispatchBox(
        ui,
        { mode: 'new', text: LONG, focused: true, role: 'implementer' },
        width,
      ),
    ],
  },
  {
    name: 'preview pane',
    render: (ui, width) => {
      const preview = new WorkerPreview(() => 5_000);
      const rows = model().workers;
      return [
        ...renderWorkerPreview(ui, rows[1], {
          width: Math.max(20, width - 51),
          maxRows: 20,
          cards: (worker, w) => preview.cards(worker, w),
        }),
        ...renderWorkerPreview(
          ui,
          rows.find((row) => row.worker.workerId === 'worker-3'),
          {
            width: Math.max(20, width - 51),
            maxRows: 12,
            cards: (worker, w) => preview.cards(worker, w),
          },
        ),
      ];
    },
  },
];

describe('the render matrix (issue #468)', () => {
  it('every surface fits, closes its styles and paints its full width, in every palette, level and width', () => {
    const failures: string[] = [];
    for (const [paletteName, palette] of PALETTES) {
      for (const level of LEVELS) {
        const ui = createUiTheme(palette, level, paletteName);
        setTuiTheme(createThemeFromPalette(palette, level, paletteName));
        for (const surface of SURFACES) {
          for (const width of WIDTHS) {
            const where = `${surface.name} · ${paletteName}/${level}/${width}`;
            let lines: string[];
            try {
              lines = surface.render(ui, width);
            } catch (error) {
              failures.push(`${where}: threw ${String(error)}`);
              continue;
            }
            lines.forEach((line, index) => {
              const w = visibleWidth(line);
              if (w > width)
                failures.push(`${where} line ${index}: ${w} cells`);
              if (surface.fullWidth === true && w !== width) {
                failures.push(
                  `${where} line ${index}: ${w} of ${width} cells painted`,
                );
              }
              if (level === 'none' && line.includes('\u001b')) {
                failures.push(`${where} line ${index}: escape at depth none`);
              }
              const open = level === 'none' ? [] : openStyles(line);
              if (open.length > 0) {
                failures.push(
                  `${where} line ${index}: leaves ${open.join(', ')} open`,
                );
              }
            });
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('the leak check itself sees an unclosed style and a closed one', () => {
    expect(openStyles('\u001b[1;38;2;1;2;3mx')).toEqual(['intensity', 'fg']);
    expect(openStyles('\u001b[1;38;2;1;2;3mx\u001b[22;39m')).toEqual([]);
    expect(openStyles('\u001b[48;5;8mx\u001b[0m')).toEqual([]);
    expect(openStyles('\u001b]8;;file:///x\u0007x')).toEqual(['hyperlink']);
    expect(openStyles('\u001b]8;;file:///x\u0007x\u001b]8;;\u0007')).toEqual(
      [],
    );
  });
});

describe('16 colours (issue #468)', () => {
  const ansi16 = createUiTheme(DARK_PALETTE, '16', 'dark');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR escapes are what this reads
  const SGR_ESCAPE = /\u001b\[([0-9;]*)m/g;
  const backgrounds = (text: string): string[] =>
    [...text.matchAll(SGR_ESCAPE)].flatMap((match) =>
      (match[1] ?? '')
        .split(';')
        .filter((code) => /^(4[0-7]|10[0-7])$/.test(code)),
    );

  it('surfaces drop their backgrounds; the selection keeps bright black', () => {
    const card = renderApprovalCard(
      ansi16,
      {
        key: 'k',
        capability: 'destructive-shell',
        toolName: 'bash',
        command: 'rm -rf dist',
      },
      100,
      {
        armed: true,
        allowable: true,
        keys: APPROVAL_DEFAULT_KEYS,
        commandPage: 0,
        position: 1,
        total: 1,
        explain: false,
        pageKey: 'v',
        explainKey: '?',
      },
    ).join('\n');
    // The warn surface is gone; the badge reads by inverse video instead.
    expect(backgrounds(card)).toEqual([]);
    expect(card).toContain('\u001b[1;7;');
    const header = renderDashboardHeader(ansi16, model(), 100, '⠹');
    expect(backgrounds(header)).toEqual([]);
    const body = renderDashboardBody(ansi16, model(), {
      selected: 'worker-1',
      width: 100,
      maxRows: 30,
      spinner: '⠹',
    }).join('\n');
    expect(new Set(backgrounds(body))).toEqual(new Set(['100']));
  });
});
