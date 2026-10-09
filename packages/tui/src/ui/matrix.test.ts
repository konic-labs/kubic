// The render matrix: every surface of the TUI rendered for each palette (dark, light, terminal) × colour
// level (truecolor, 256, 16, none) × width (60, 80, 100, 140). Each line
// must fit its width, carry no escape at depth none, close every style (and
// hyperlink) it opens before it ends, and a surface that paints a background
// must paint it edge to edge. Failures are collected, so one run names them
// all.

import type { ColorLevel } from '@kubic/core/ui/color';
import { createUiTheme, openStyles, type UiTheme } from '@kubic/core/ui/style';
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  type Palette,
  TERMINAL_PALETTE,
} from '@kubic/core/ui/tokens';
import { afterAll, describe, expect, it } from 'vitest';
import { renderApprovalCard } from '../approval-card.js';
import { APPROVAL_DEFAULT_KEYS } from '../approval-view.js';
import { BlockViewer } from '../block-viewer.js';
import { keyHintSet, renderHeader } from '../chrome.js';
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

interface Surface {
  readonly name: string;
  readonly render: (ui: UiTheme, width: number) => string[];
  /** Every line paints a background edge to edge (exactly the width). */
  readonly fullWidth?: boolean;
}

const SURFACES: Surface[] = [
  {
    name: 'header',
    fullWidth: true,
    render: (ui, width) => [
      renderHeader(
        ui,
        {
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
      const set = keyHintSet('working', DEFAULT_KEY_REGISTRY);
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
          isolation: LONG,
          keys: { palette: '^P', help: '?' },
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
];

describe('the render matrix', () => {
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

describe('16 colours', () => {
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
    // The badge reads by inverse video; there is no warn surface.
    expect(backgrounds(card)).toEqual([]);
    expect(card).toContain('\u001b[1;7;');
    const header = renderHeader(ansi16, { approvalsSkipped: false }, 100);
    expect(backgrounds(header)).toEqual([]);
    const palette = renderPalette(
      ansi16,
      createPalette([
        { group: 'commands', value: '/model', text: '/model' },
        { group: 'commands', value: '/help', text: '/help' },
      ]),
      100,
      { input: '', maxRows: 20, keyLabel: '^P' },
    ).join('\n');
    expect(new Set(backgrounds(palette))).toEqual(new Set(['100']));
  });
});
