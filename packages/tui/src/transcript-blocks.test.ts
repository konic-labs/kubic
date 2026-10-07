// The transcript's blocks: what
// block mode navigates — one block per prompt, answer, thinking, tool card
// and receipt, with real row offsets, the text a copy takes, the selected
// block's edge and a per-block expand.
import { afterEach, describe, expect, it } from 'vitest';
import { createTuiTheme, setTuiTheme } from './theme.js';
import { createTranscriptView, type TranscriptEntry } from './transcript.js';

afterEach(() => {
  setTuiTheme(createTuiTheme('none'));
});

const OUTPUT = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');

const CELLS: TranscriptEntry[] = [
  { id: 'p1', kind: 'prompt', markdown: '› run the tests' },
  { id: 'a1', kind: 'text', markdown: 'Running **them** now.' },
  {
    id: 't1',
    kind: 'tool',
    markdown: 'tool bash',
    detail: 'npm test',
    toolCallId: 'c1',
  },
  { id: 'o1', kind: 'output', markdown: OUTPUT, toolCallId: 'c1' },
  { id: 'h1', kind: 'thinking', markdown: 'The cart adds. Then it checks.' },
  { id: 'a2', kind: 'text', markdown: 'Done.' },
];

function view() {
  setTuiTheme(createTuiTheme('none'));
  const transcript = createTranscriptView();
  transcript.applyLaneSnapshot({ laneId: 'l' }, CELLS, 1);
  return transcript;
}

describe('transcript blocks', () => {
  it('lists one block per prompt, answer, thinking and tool card, in order', () => {
    const transcript = view();
    transcript.render(80);
    expect(transcript.blocks().map((block) => [block.id, block.kind])).toEqual([
      ['p1', 'prompt'],
      ['a1', 'prose'],
      ['t1', 'tool'],
      ['h1', 'thinking'],
      ['a2', 'prose'],
    ]);
  });

  it('points each block at its rows, at any width', () => {
    for (const width of [60, 120]) {
      const transcript = view();
      const lines = transcript.render(width);
      const [prompt, prose, tool, thinking, done] = transcript.blocks();
      expect(lines[prompt?.firstRow ?? -1]).toContain('run the tests');
      expect(lines[prose?.firstRow ?? -1]).toContain('Running');
      expect(lines[tool?.firstRow ?? -1]).toContain('bash');
      expect(lines[thinking?.firstRow ?? -1]).toContain('thinking');
      expect(lines[done?.firstRow ?? -1]).toContain('Done.');
      // A collapsed card: its rows end before the next block's gap.
      const after = (tool?.firstRow ?? 0) + (tool?.rowCount ?? 0);
      expect(lines[after]).toBe('');
    }
  });

  it('carries what a copy takes', () => {
    const transcript = view();
    transcript.render(80);
    const [prompt, prose, tool, thinking] = transcript.blocks();
    expect(prompt?.copyText).toBe('run the tests');
    expect(prose?.copyText).toBe('Running **them** now.');
    expect(tool?.copyText).toBe(OUTPUT);
    expect(tool?.metaText).toBe('bash npm test');
    expect(thinking?.copyText).toBe('The cart adds. Then it checks.');
    expect(prose?.metaText).toBe(prose?.copyText);
  });

  it('draws the selected block with an edge on every row', () => {
    const transcript = view();
    transcript.select('t1');
    const lines = transcript.render(80);
    const tool = transcript.blocks()[2];
    for (let row = 0; row < (tool?.rowCount ?? 0); row += 1) {
      expect(lines[(tool?.firstRow ?? 0) + row]?.startsWith('▌')).toBe(true);
    }
    const prose = transcript.blocks()[1];
    expect(lines[prose?.firstRow ?? 0]?.startsWith('▌')).toBe(false);
    transcript.select(undefined);
    expect(transcript.render(80)[tool?.firstRow ?? 0]?.startsWith('▌')).toBe(
      false,
    );
  });

  it('expands one block alone, and renders it whole for the viewer', () => {
    const transcript = view();
    transcript.render(80);
    const collapsed = transcript.blocks()[2]?.rowCount ?? 0;
    const thinkingRows = transcript.blocks()[3]?.rowCount ?? 0;
    expect(transcript.toggleBlock('t1')).toBe(true);
    transcript.render(80);
    expect(transcript.blocks()[2]?.rowCount ?? 0).toBeGreaterThan(collapsed);
    expect(transcript.blocks()[3]?.rowCount).toBe(thinkingRows);
    expect(transcript.toggleBlock('t1')).toBe(false);
    const whole = transcript.blockLines('t1', 80).join('\n');
    expect(whole).toContain('line 12');
    expect(transcript.blockLines('h1', 80).join('\n')).toContain(
      'Then it checks.',
    );
    expect(transcript.blockLines('nope', 80)).toEqual([]);
  });
});
