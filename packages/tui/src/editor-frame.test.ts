// The framed editor and the working line (and the mid-turn frame). Pure renders
// at depth none read like the design; the real PromptEditor proves the rule
// markers, scroll indicators and the cursor marker survive the frame.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../core/src/ui/tokens.js';
import {
  EDITOR_FRAME_CELLS,
  formatTurnClock,
  frameEditorLines,
  RULE_MARK,
  renderWorkingLine,
} from './editor-frame.js';
import { PromptEditor } from './editor-view.js';
import { spinnerFrame } from './theme.js';
import { CURSOR_MARKER, visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

// Pi's shape: rule, content lines padded to the width, rule, autocomplete.
function piLines(width: number, content: string[], below: string[] = []) {
  const rule = `${RULE_MARK}${'─'.repeat(width)}`;
  return [
    rule,
    ...content.map((line) => `${line}${' '.repeat(width - line.length)}`),
    rule,
    ...below,
  ];
}

const idle = { busy: false, empty: false, hint: '@ file  / cmd' } as const;

describe('editor frame', () => {
  it('closes the box with the caret and the hint on the first line', () => {
    const width = 40;
    const inner = width - EDITOR_FRAME_CELLS;
    const lines = frameEditorLines(
      plain,
      piLines(inner, ['round total()']),
      width,
      idle,
    );
    expect(lines).toEqual([
      ` ┌${'─'.repeat(width - 4)}┐ `,
      ` │ › round total()${' '.repeat(inner - 13 - 13)}@ file  / cmd │ `,
      ` └${'─'.repeat(width - 4)}┘ `,
    ]);
    for (const line of lines) expect(visibleWidth(line)).toBe(width);
  });

  it('grows with the draft and indents continuation lines', () => {
    const lines = frameEditorLines(
      plain,
      piLines(72, ['first line', 'second line']),
      80,
      idle,
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]?.startsWith(' │ › first line')).toBe(true);
    expect(lines[2]?.startsWith(' │   second line')).toBe(true);
    expect(lines[2]).not.toContain('@ file');
  });

  it('drops the hint rather than crowd the text', () => {
    const inner = 40 - EDITOR_FRAME_CELLS;
    const long = 'x'.repeat(inner - 5);
    const lines = frameEditorLines(plain, piLines(inner, [long]), 40, idle);
    expect(lines[1]).not.toContain('@ file');
    expect(visibleWidth(lines[1] ?? '')).toBe(40);
  });

  it('turns into a queue box mid-turn: fg2 caret and the placeholder', () => {
    const lines = frameEditorLines(plain, piLines(72, ['']), 80, {
      busy: true,
      empty: true,
      placeholder: 'type to queue — sent when this turn ends',
    });
    expect(lines[1]).toBe(
      ` │ ›  type to queue — sent when this turn ends${' '.repeat(72 - 41)} │ `,
    );
    const painted = frameEditorLines(rich, piLines(72, ['']), 80, {
      busy: true,
      empty: true,
      placeholder: 'type to queue',
    });
    expect(painted[1]).toContain(rich.fg('fg2')(' › '));
    expect(painted[1]).toContain(
      rich.style({ fg: 'fg2', italic: true })('type to queue'),
    );
    const caret = frameEditorLines(rich, piLines(72, ['x']), 80, idle);
    expect(caret[1]).toContain(rich.style({ fg: 'accent', bold: true })(' › '));
    expect(caret[0]?.startsWith(` ${rich.open({ fg: 'fg3' })}┌`)).toBe(true);
  });

  it('keeps the autocomplete rows below the box, aligned with the text', () => {
    const lines = frameEditorLines(
      plain,
      piLines(32, ['/he'], ['→ /help  list the commands']),
      40,
      idle,
    );
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('     → /help  list the commands');
  });

  it('passes the lines through unframed below the minimum width', () => {
    const lines = frameEditorLines(plain, piLines(1, ['']), 8, idle);
    expect(lines.join('')).not.toContain(RULE_MARK);
    expect(lines.join('')).not.toContain('┌');
  });

  it('frames the real editor: scroll indicators and the cursor marker', () => {
    const editor = new PromptEditor();
    editor.focused = true;
    editor.setText(
      Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'),
    );
    const width = 60;
    const framed = frameEditorLines(
      plain,
      editor.render(width - EDITOR_FRAME_CELLS),
      width,
      idle,
    );
    expect(framed[0]?.startsWith(' ┌')).toBe(true);
    expect(framed[0]).toContain('↑');
    expect(framed[0]).toContain('more');
    expect(framed.at(-1)?.startsWith(' └')).toBe(true);
    expect(framed.join('\n')).toContain(CURSOR_MARKER);
    expect(framed.join('\n')).not.toContain(RULE_MARK);
    for (const line of framed) expect(visibleWidth(line)).toBe(width);
    // A draft line of rule characters is text, not a rule.
    editor.setText('────');
    const ruleText = frameEditorLines(
      plain,
      editor.render(width - EDITOR_FRAME_CELLS),
      width,
      idle,
    );
    expect(ruleText).toHaveLength(3);
    expect(ruleText[1]).toContain(' │ › ────');
  });
});

describe('working line (mid-turn frame)', () => {
  it('names the clock, tokens, tools and the keys that act', () => {
    const line = renderWorkingLine(
      plain,
      {
        elapsedMs: 12_000,
        input: 9200,
        output: 640,
        tools: 3,
        interruptKey: 'esc',
      },
      120,
    );
    expect(
      line.startsWith(
        ` ${spinnerFrame(12_000)} Working · 0:12 · ↑ 9.2k ↓ 640 tok · 3 tools`,
      ),
    ).toBe(true);
    expect(line.endsWith('esc interrupt   ⏎ queue a message ')).toBe(true);
    expect(visibleWidth(line)).toBe(120);
  });

  it('leaves tokens out until usage is known', () => {
    const line = renderWorkingLine(plain, { elapsedMs: 3000, tools: 0 }, 80);
    expect(line).toContain('Working · 0:03');
    expect(line).not.toContain('tok');
    expect(line).not.toContain('tools');
  });

  it('drops the keys before the facts when narrow', () => {
    const info = { elapsedMs: 72_000, tools: 1 } as const;
    expect(renderWorkingLine(plain, info, 60)).toContain('esc interrupt');
    expect(renderWorkingLine(plain, info, 60)).not.toContain('queue');
    const narrow = renderWorkingLine(plain, info, 30);
    expect(narrow).not.toContain('interrupt');
    expect(narrow).toContain('Working · 1:12');
    expect(renderWorkingLine(rich, info, 80)).toContain(
      rich.fg('accent')(` ${spinnerFrame(72_000)} `),
    );
  });

  it('formats the turn clock', () => {
    expect(formatTurnClock(0)).toBe('0:00');
    expect(formatTurnClock(65_000)).toBe('1:05');
    expect(formatTurnClock(3_725_000)).toBe('1:02:05');
  });
});
