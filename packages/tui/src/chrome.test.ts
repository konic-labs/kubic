// The one-row header and the key-hint sets. Pure renders: plain text at
// depth none reads like the design.

import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import {
  formatClock,
  type HeaderInfo,
  keyCap,
  keyHintSet,
  renderHeader,
  sessionTitle,
  shortSessionId,
} from './chrome.js';
import { createKeyRegistry, DEFAULT_KEY_REGISTRY } from './keybindings.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');
const rich = createUiTheme(DARK_PALETTE, 'truecolor');

const playground: HeaderInfo = {
  approvalsSkipped: false,
  project: 'kubic-playground',
  branch: 'main',
  dirty: 1,
  session: 'cart-fix',
  clock: '14:02',
};

const between = (left: string, right: string, width: number): string =>
  `${left}${' '.repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

describe('header', () => {
  it('carries project, branch, session, posture and clock at 120 columns', () => {
    expect(renderHeader(plain, playground, 120)).toBe(
      between(
        ' ■ KUBIC │ kubic-playground  ⎇ main ●1',
        'session cart-fix │ approvals on │ 14:02 ',
        120,
      ),
    );
  });

  it('drops the clock, the session, the posture and the branch in turn, never the brand', () => {
    expect(renderHeader(plain, playground, 75)).toBe(
      between(
        ' ■ KUBIC │ kubic-playground  ⎇ main ●1',
        'session cart-fix │ approvals on ',
        75,
      ),
    );
    expect(renderHeader(plain, playground, 70)).toBe(
      between(' ■ KUBIC │ kubic-playground  ⎇ main ●1', 'approvals on ', 70),
    );
    expect(renderHeader(plain, playground, 40)).toBe(
      between(' ■ KUBIC │ kubic-playground  ⎇ main ●1', ' ', 40),
    );
    expect(renderHeader(plain, playground, 35)).toBe(
      between(' ■ KUBIC │ kubic-playground', ' ', 35),
    );
  });

  it('omits the branch outside a repository and the dot on a clean tree', () => {
    const outside = renderHeader(
      plain,
      { ...playground, branch: undefined, dirty: undefined },
      120,
    );
    expect(outside).not.toContain('⎇');
    expect(outside.startsWith(' ■ KUBIC │ kubic-playground ')).toBe(true);
    const clean = renderHeader(plain, { ...playground, dirty: 0 }, 120);
    expect(clean).toContain('⎇ main ');
    expect(clean).not.toContain('●');
  });

  it('keeps full access unmissable at every width', () => {
    const off = { ...playground, approvalsSkipped: true };
    expect(renderHeader(plain, off, 120)).toContain(
      'approvals OFF (full-access) │ 14:02 ',
    );
    for (const width of [80, 60, 50]) {
      expect(renderHeader(plain, off, width)).toContain(
        'approvals OFF (full-access)',
      );
    }
    // At 50 the project name is cut to make room for the posture.
    expect(renderHeader(plain, off, 50)).toBe(
      ' ■ KUBIC │ kubic-pla… approvals OFF (full-access) ',
    );
    expect(renderHeader(rich, off, 120)).toContain(
      rich.style({ fg: 'err', bold: true })('OFF (full-access)'),
    );
  });

  it('paints bg1 edge to edge at every width', () => {
    const open = rich.open({ bg: 'bg1' });
    for (const width of [40, 60, 80, 100, 120, 160]) {
      const line = renderHeader(rich, playground, width);
      expect(line.startsWith(open)).toBe(true);
      expect(visibleWidth(line)).toBe(width);
      expect(visibleWidth(renderHeader(plain, playground, width))).toBe(width);
    }
    expect(renderHeader(plain, playground, 0)).toBe('');
    expect(renderHeader(plain, playground, Number.NaN)).toBe('');
  });
});

describe('header facts', () => {
  it('titles a session by its first prompt, cut to 24 cells on one line', () => {
    expect(sessionTitle('run npm test and fix the failing test')).toBe(
      'run npm test and fix th…',
    );
    expect(sessionTitle('  fix\n  the cart  ')).toBe('fix the cart');
    expect(shortSessionId('01a1c0de-7a6b-4c1e-9f00-3d2a5e9cb6b8')).toBe(
      '01a1…b6b8',
    );
    expect(shortSessionId('s1')).toBe('s1');
  });

  it('formats the local clock as HH:MM', () => {
    expect(formatClock(new Date(2026, 9, 6, 9, 5))).toBe('09:05');
    expect(formatClock(new Date(2026, 9, 6, 23, 59))).toBe('23:59');
  });
});

describe('key caps', () => {
  it('turns registry labels into compact caps', () => {
    expect(keyCap('ctrl+p')).toBe('^P');
    expect(keyCap('ctrl+up')).toBe('^↑');
    expect(keyCap('esc')).toBe('esc');
    expect(keyCap('escape')).toBe('esc');
    expect(keyCap('enter')).toBe('⏎');
    expect(keyCap('shift+enter')).toBe('⇧⏎');
    expect(keyCap('alt+enter')).toBe('alt+⏎');
    expect(keyCap('alt+m')).toBe('alt+m');
    expect(keyCap('ctrl+shift+f')).toBe('ctrl+shift+f');
    expect(keyCap('pagedown')).toBe('pgdn');
    expect(keyCap('')).toBe('');
  });
});

describe('key-hint sets', () => {
  it('idle: send, newline, commands, palette, panels; quit on the right', () => {
    expect(keyHintSet('idle', DEFAULT_KEY_REGISTRY)).toEqual({
      hints: [
        ['⏎', 'send'],
        ['^J', 'newline'],
        ['/', 'commands'],
        ['^P', 'palette'],
        ['^O', 'diff'],
        ['^R', 'journal'],
      ],
      right: ['^C ^C', 'quit'],
    });
    const rich = keyHintSet('idle', DEFAULT_KEY_REGISTRY, {
      files: true,
      newline: '⇧⏎',
    });
    expect(rich.hints.slice(0, 4)).toEqual([
      ['⏎', 'send'],
      ['⇧⏎', 'newline'],
      ['/', 'commands'],
      ['@', 'file'],
    ]);
  });

  it('working: interrupt, queue and steer', () => {
    expect(keyHintSet('working', DEFAULT_KEY_REGISTRY)).toEqual({
      hints: [
        ['esc', 'interrupt'],
        ['⏎', 'queue'],
        ['alt+⏎', 'steer'],
        ['^X', 'expand output'],
        ['^P', 'palette'],
      ],
      right: ['^C ^C', 'quit'],
    });
  });

  it('approval and overlay contexts show the keys that act there', () => {
    // The card's keys, its explanation and the way back up.
    expect(keyHintSet('approval', DEFAULT_KEY_REGISTRY)).toEqual({
      hints: [
        ['a', 'allow once'],
        ['^S', 'allow for session'],
        ['d', 'deny'],
        ['c', 'deny + comment'],
        ['?', 'explain'],
        ['PgUp', 'read transcript'],
      ],
      right: ['^C ^C', 'quit'],
    });
    expect(keyHintSet('overlay', DEFAULT_KEY_REGISTRY)).toEqual({
      hints: [
        ['↑↓', 'move'],
        ['⏎', 'select'],
        ['esc', 'cancel'],
      ],
    });
    expect(keyHintSet('model', DEFAULT_KEY_REGISTRY)).toEqual({
      hints: [
        ['↑↓', 'move'],
        ['⏎', 'switch'],
        ['→', 'expand provider'],
      ],
      right: ['esc', 'keep current'],
    });
    expect(keyHintSet('blocks', DEFAULT_KEY_REGISTRY)).toEqual({
      hints: [
        ['↑↓', 'move'],
        ['⏎', 'view'],
        ['y', 'copy'],
        ['Y', 'copy command'],
        ['x', 'expand'],
      ],
      right: ['esc', 'back'],
    });
    // The palette's own keys.
    expect(keyHintSet('palette', DEFAULT_KEY_REGISTRY)).toEqual({
      hints: [
        ['↑↓', 'move'],
        ['⏎', 'run'],
        ['tab', 'next group'],
        ['→', 'details'],
      ],
      right: ['esc', 'close'],
    });
  });

  it('an open panel shows its own keys, and Esc closes it', () => {
    expect(
      keyHintSet('panel', DEFAULT_KEY_REGISTRY, { panel: 'diff' }),
    ).toEqual({
      hints: [
        ['alt+↓', 'next file'],
        ['alt+↑', 'previous file'],
        ['^O', 'close'],
        ['^R', 'journal'],
      ],
      right: ['esc', 'close'],
    });
    expect(
      keyHintSet('panel', DEFAULT_KEY_REGISTRY, { panel: 'journal' }).hints,
    ).toEqual([
      ['alt+↓', 'next page'],
      ['alt+↑', 'previous page'],
      ['^O', 'diff'],
      ['^R', 'close'],
    ]);
  });

  it('a confirmation shows its accept key and what it does', () => {
    expect(
      keyHintSet('confirm', DEFAULT_KEY_REGISTRY, {
        confirm: { key: '^S', label: 'turn off' },
      }),
    ).toEqual({ hints: [['^S', 'turn off']], right: ['esc', 'cancel'] });
  });

  it('follows a rebind and hides an unbound action', () => {
    const keys = createKeyRegistry({
      'app.palette': ['ctrl+k'],
      'panel.diff': [],
    });
    const idle = keyHintSet('idle', keys);
    expect(idle.hints).toContainEqual(['^K', 'palette']);
    expect(idle.hints.map(([, label]) => label)).not.toContain('diff');
  });
});
