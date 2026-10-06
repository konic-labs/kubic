// A steady-state frame rebuilds no cached row (issue #298, after #455 and
// #468). A committed prompt's block is drawn once per text, stamp, width and
// theme, like prose, and the rows of both are closed (#468) once, when they
// are cached. Redrawing every prompt and re-scanning every row each frame
// made a coloured 400-turn frame about six times slower. Counted, not
// timed: the helpers are wrapped so the test reads how often they ran.
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ close: 0, fill: 0 }));

vi.mock('./ui/line.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/line.js')>();
  return {
    ...actual,
    closeOpenStyles: (line: string): string => {
      calls.close += 1;
      return actual.closeOpenStyles(line);
    },
  };
});

vi.mock('./ui/surface.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui/surface.js')>();
  return {
    ...actual,
    fillLine: (...args: Parameters<typeof actual.fillLine>): string => {
      calls.fill += 1;
      return actual.fillLine(...args);
    },
  };
});

const { createTuiTheme, setTuiTheme } = await import('./theme.js');
const { createTranscriptView } = await import('./transcript.js');

afterEach(() => {
  setTuiTheme(createTuiTheme('none'));
});

function session(turns: number) {
  const view = createTranscriptView();
  const cells: Array<{
    id: string;
    kind: 'prompt' | 'text';
    markdown: string;
    timestamp?: number;
  }> = [];
  for (let i = 0; i < turns; i += 1) {
    cells.push({
      id: `p${i}`,
      kind: 'prompt',
      markdown: `› prompt ${i}`,
      timestamp: 1_700_000_000_000 + i,
    });
    cells.push({
      id: `a${i}`,
      kind: 'text',
      markdown: `answer ${i}\n\n- a **bold** point with \`code\``,
    });
  }
  view.applyLaneSnapshot({ laneId: 'l' }, cells, 1);
  return view;
}

describe('a steady-state transcript frame (issue #298)', () => {
  it('draws no prompt block and closes no row it already cached', () => {
    setTuiTheme(createTuiTheme('truecolor'));
    const view = session(20);
    const first = view.render(100);
    calls.close = 0;
    calls.fill = 0;
    expect(view.render(100)).toEqual(first);
    expect(calls.fill).toBe(0);
    expect(calls.close).toBe(0);
  });

  it('redraws a prompt when its width, theme or stamp changes', () => {
    setTuiTheme(createTuiTheme('truecolor'));
    const view = session(2);
    view.render(100);
    calls.fill = 0;
    view.render(90);
    expect(calls.fill).toBeGreaterThan(0);
    calls.fill = 0;
    setTuiTheme(createTuiTheme('256'));
    view.render(90);
    expect(calls.fill).toBeGreaterThan(0);
    calls.fill = 0;
    view.applyLaneSnapshot(
      { laneId: 'l' },
      [
        {
          id: 'p0',
          kind: 'prompt',
          markdown: '› prompt 0',
          timestamp: 1_800_000_000_000,
        },
      ],
      2,
    );
    view.render(90);
    expect(calls.fill).toBeGreaterThan(0);
  });
});
