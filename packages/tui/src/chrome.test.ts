// The one-row header and the key-hint sets (EPIC N, issue #453; docs/ui
// 01-A, 01-M). Pure renders: plain text at depth none reads like the design.
import { describe, expect, it } from 'vitest';
import { createUiTheme } from '../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../core/src/ui/tokens.js';
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
  mode: 'solo',
  approvalsSkipped: false,
  project: 'kubic-playground',
  branch: 'main',
  dirty: 1,
  session: 'cart-fix',
  clock: '14:02',
};

const between = (left: string, right: string, width: number): string =>
  `${left}${' '.repeat(width - visibleWidth(left) - visibleWidth(right))}${right}`;

describe('header (01-A)', () => {
  it('carries project, branch, session, posture and clock at 120 columns', () => {
    expect(renderHeader(plain, playground, 120)).toBe(
      between(
        ' ■ KUBIC │ kubic-playground  ⎇ main ●1',
        'session cart-fix │ [SOLO] approvals on │ 14:02 ',
        120,
      ),
    );
  });

  it('drops the clock at 80 and the session at 60, never the brand or mode', () => {
    expect(renderHeader(plain, playground, 80)).toBe(
      between(
        ' ■ KUBIC │ kubic-playground  ⎇ main ●1',
        'session cart-fix │ [SOLO] approvals on ',
        80,
      ),
    );
    expect(renderHeader(plain, playground, 60)).toBe(
      between(
        ' ■ KUBIC │ kubic-playground  ⎇ main ●1',
        '[SOLO] approvals on ',
        60,
      ),
    );
    expect(renderHeader(plain, playground, 40)).toBe(
      between(' ■ KUBIC │ kubic-playground', '[SOLO] ', 40),
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
      '[SOLO] approvals OFF (full-access) │ 14:02 ',
    );
    for (const width of [80, 60, 50]) {
      expect(renderHeader(plain, off, width)).toContain(
        '[SOLO] approvals OFF (full-access)',
      );
    }
    // At 50 the project name is cut to make room for the posture.
    expect(renderHeader(plain, off, 50)).toBe(
      ' ■ KUBIC │ ku… [SOLO] approvals OFF (full-access) ',
    );
    expect(renderHeader(rich, off, 120)).toContain(
      rich.style({ fg: 'err', bold: true })('OFF (full-access)'),
    );
  });

  it('names the orchestrator mode on an accent badge', () => {
    const line = renderHeader(
      plain,
      { ...playground, mode: 'orchestrator' },
      120,
    );
    expect(line).toContain('[ORCHESTRATOR] approvals on');
    expect(
      renderHeader(rich, { ...playground, mode: 'orchestrator' }, 120),
    ).toContain(
      rich.style({ fg: 'accent', inverse: true, bold: true })(' ORCHESTRATOR '),
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

describe('key-hint sets (01-M)', () => {
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

  it('working: interrupt, queue and steer on the solo lane only', () => {
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
    const orchestrator = keyHintSet('working', DEFAULT_KEY_REGISTRY, {
      queues: false,
    });
    expect(orchestrator.hints.map(([, label]) => label)).toEqual([
      'interrupt',
      'expand output',
      'palette',
    ]);
  });

  it('approval and overlay contexts show the keys that act there', () => {
    // Issue #459: the card's keys, its explanation and the way back up.
    expect(keyHintSet('approval', DEFAULT_KEY_REGISTRY)).toEqual({
      hints: [
        ['a', 'allow once'],
        ['^S', 'allow for session'],
        ['d', 'deny'],
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
    // Issue #460: the palette's own keys (03-A).
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
