// The dimmed background behind the palette and pickers: base rows lose every
// colour, link and marker and are drawn in fg3; the key-hint row (the last)
// stays lit.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../../core/src/ui/tokens.js';
import { CURSOR_MARKER } from '../tui-boundary.js';
import { dimFrame, dimLine } from './dim.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const ESC = '\u001b';
const BEL = '\u0007';

describe('dim', () => {
  it('strips colours, links and markers and paints fg3', () => {
    const styled = `${rich.style({ fg: 'accent', bold: true })('■ KUBIC')} ${ESC}]8;;file:///x${BEL}src/x.ts${ESC}]8;;${BEL}${CURSOR_MARKER}${ESC}_kubic:rule${BEL}`;
    expect(dimLine(plain, styled)).toBe('■ KUBIC src/x.ts');
    expect(dimLine(rich, styled)).toBe(rich.fg('fg3')('■ KUBIC src/x.ts'));
    // A blank row stays as it is (no styled spaces).
    expect(dimLine(rich, '   ')).toBe('   ');
  });

  it('dims every row but the key hints at the bottom', () => {
    const hints = rich.fg('fg1')('↑↓ move');
    const frame = [
      rich.fg('fg0')('header'),
      '',
      rich.fg('add')('+1 ok'),
      hints,
    ];
    expect(dimFrame(rich, frame)).toEqual([
      rich.fg('fg3')('header'),
      '',
      rich.fg('fg3')('+1 ok'),
      hints,
    ]);
  });
});
