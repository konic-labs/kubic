// The confirmation dialog: a closed heavy box whose title asks the
// question, whose body wraps the consequences and whose last row offers the
// two answers as key caps. Plain text at depth none reads like the design.
import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import { renderConfirm } from './confirm-view.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const OPTIONS = {
  title: 'Turn approvals off?',
  body: ['Every challenged call runs without asking.'],
  confirmKey: '^S',
  confirmAction: 'turn off',
  cancelAction: 'keep on',
};

describe('the confirmation dialog', () => {
  it('asks in the title, explains in the body and answers with key caps', () => {
    expect(renderConfirm(plain, OPTIONS, 48)).toEqual([
      '┏━ Turn approvals off? ━━━━━━━━━━━━━━━━━━━━━━━━┓',
      '┃                                              ┃',
      '┃  Every challenged call runs without asking.  ┃',
      '┃                                              ┃',
      '┃  [^S] turn off    [esc] keep on              ┃',
      '┃                                              ┃',
      '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
    ]);
  });

  it('wraps a long consequence inside the box instead of cutting it', () => {
    const lines = renderConfirm(
      plain,
      { ...OPTIONS, body: ['one two three four five six seven eight nine'] },
      24,
    );
    expect(lines.slice(2, 5)).toEqual([
      '┃  one two three four  ┃',
      '┃  five six seven      ┃',
      '┃  eight nine          ┃',
    ]);
  });

  it('is exactly its width on every row, painted, so nothing shows through', () => {
    const lines = renderConfirm(rich, OPTIONS, 48);
    for (const line of lines) expect(visibleWidth(line)).toBe(48);
    expect(lines[2]).toContain(rich.open({ bg: 'bg1' }));
  });
});
