// The TUI chrome: the one-row header and the context-aware key-hint row. The
// status line is status-bar.ts. Pure renders over a UiTheme — plain text at
// colour depth none, so snapshots read like the design.
//
// Header: `■ KUBIC │ <project> ⎇ <branch> ●<dirty>` on the left, `session
// <title> │ approvals on │ HH:MM` on the right, on bg1. As the width shrinks
// the parts drop right to left — clock, session, approvals, branch — and the
// project name is cut last. The brand never drops, and neither does
// `approvals OFF`: full access must stay unmissable.

import { BRANCH, BRAND } from '@kubic/core/ui/glyphs';
import type { UiTheme } from '@kubic/core/ui/style';
import type { KeyAction, KeyRegistry } from './keybindings.js';
import { visibleWidth } from './tui-boundary.js';
import type { KeyHint } from './ui/key-hints.js';
import { fitLine, leftRight } from './ui/line.js';
import { badge } from './ui/marks.js';
import { fillLine } from './ui/surface.js';

export interface HeaderInfo {
  readonly approvalsSkipped: boolean;
  /** Basename of the project root. */
  readonly project?: string;
  /** Current branch; absent outside a repository. */
  readonly branch?: string;
  /** Changed files in the working tree (the `●N` dot when above zero). */
  readonly dirty?: number;
  /** The session title (first prompt) or the short session id. */
  readonly session?: string;
  /** Local `HH:MM`. */
  readonly clock?: string;
  /** Approvals waiting for the operator (the amber badge). */
  readonly waiting?: number;
}

interface HeaderRung {
  readonly clock: boolean;
  readonly session: boolean;
  readonly approvals: boolean;
  readonly branch: boolean;
}

export function renderHeader(
  ui: UiTheme,
  info: HeaderInfo,
  width: number,
): string {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (w === 0) return '';
  const sep = ui.fg('fg3')(' │ ');
  const brand = ui.style({ fg: 'accent', bold: true })(` ${BRAND} KUBIC `);
  const project =
    info.project === undefined || info.project === ''
      ? ''
      : `${ui.fg('fg3')('│ ')}${ui.fg('fg0')(info.project)}`;
  const dirty =
    info.dirty !== undefined && info.dirty > 0
      ? ui.fg('warn')(` ●${info.dirty}`)
      : '';
  const branch =
    info.branch === undefined || info.branch === ''
      ? ''
      : `${ui.fg('fg2')(`  ${BRANCH} `)}${ui.fg('fg1')(info.branch)}${dirty}`;
  const approvals = `${ui.fg('fg2')('approvals ')}${
    info.approvalsSkipped
      ? ui.style({ fg: 'err', bold: true })('OFF (full-access)')
      : ui.fg('ok')('on')
  }`;
  const session =
    info.session === undefined || info.session === ''
      ? ''
      : `${ui.fg('fg2')('session ')}${ui.fg('fg1')(info.session)}`;
  const clock =
    info.clock === undefined || info.clock === ''
      ? ''
      : ui.fg('fg2')(info.clock);
  // What waits for the operator outranks the session name.
  const waiting =
    info.waiting !== undefined && info.waiting > 0
      ? badge(ui, `${info.waiting} WAITING`, 'waiting')
      : '';
  const right = (rung: HeaderRung): string => {
    const parts = [
      waiting,
      rung.session ? session : '',
      rung.approvals ? approvals : '',
      rung.clock ? clock : '',
    ].filter((part) => part !== '');
    return `${parts.join(sep)} `;
  };
  const left = (rung: HeaderRung): string =>
    `${brand}${project}${rung.branch ? branch : ''}`;
  const keepOff = info.approvalsSkipped;
  const ladder: readonly HeaderRung[] = [
    { clock: true, session: true, approvals: true, branch: true },
    { clock: false, session: true, approvals: true, branch: true },
    { clock: false, session: false, approvals: true, branch: true },
    { clock: false, session: false, approvals: keepOff, branch: true },
    { clock: false, session: false, approvals: keepOff, branch: false },
  ];
  const fill = (text: string): string => fillLine(ui, text, w, 'bg1');
  for (const rung of ladder) {
    const l = left(rung);
    const r = right(rung);
    if (visibleWidth(l) + 1 + visibleWidth(r) <= w) {
      return fill(leftRight(l, r, w));
    }
  }
  // Too narrow for the whole project name: cut it, keep brand and posture.
  const last = ladder[ladder.length - 1] as HeaderRung;
  const r = right(last);
  if (visibleWidth(brand) + 2 + visibleWidth(r) <= w) {
    return fill(leftRight(left(last), r, w));
  }
  return fill(fitLine(keepOff ? `${brand}${approvals}` : brand, w));
}

/** At most this many cells of the first prompt name the session. */
const SESSION_TITLE_CELLS = 24;

/** The header's session title: the first prompt on one line, cut to 24 cells. */
export function sessionTitle(prompt: string): string {
  return fitLine(prompt.replace(/\s+/g, ' ').trim(), SESSION_TITLE_CELLS);
}

/** `01a1…b6b8` — enough of a UUID to tell sessions apart in the header. */
export function shortSessionId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/** Local wall-clock `HH:MM`. */
export function formatClock(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: '⏎',
  escape: 'esc',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageup: 'pgup',
  pagedown: 'pgdn',
};

/**
 * A registry label as a key cap: `ctrl+p` → `^P`, `escape` → `esc`,
 * `shift+enter` → `⇧⏎`, `alt+enter` → `alt+⏎`, `alt+m` stays `alt+m`.
 */
export function keyCap(label: string): string {
  if (label === '') return '';
  const parts = label.split('+');
  const key = parts[parts.length - 1] ?? '';
  const mods = parts.slice(0, -1);
  const base = NAMED_KEYS[key] ?? key;
  if (mods.length === 0) return base;
  if (mods.length === 1 && mods[0] === 'ctrl') {
    return key.length === 1 ? `^${key.toUpperCase()}` : `^${base}`;
  }
  if (mods.length === 1 && mods[0] === 'shift') return `⇧${base}`;
  return [...mods, base].join('+');
}

/** Which keys act right now, and so which hints the row shows. */
export type HintContext =
  | 'idle'
  | 'working'
  | 'approval'
  // The approval card's comment or command input is open.
  | 'approvalInput'
  | 'overlay'
  | 'palette'
  | 'model'
  | 'blocks';

export interface HintSetOptions {
  /** Whether `@` completes files (a file source exists). */
  readonly files?: boolean;
  /** The newline key that works on this terminal (`⇧⏎` or `^J`). */
  readonly newline?: string;
}

export interface HintSet {
  readonly hints: readonly KeyHint[];
  readonly right?: KeyHint;
}

/**
 * The hint row for a context, read from the key registry so a rebound
 * action is hinted under its real key and an unbound one is not hinted.
 */
export function keyHintSet(
  context: HintContext,
  keys: KeyRegistry,
  options: HintSetOptions = {},
): HintSet {
  const bound = (action: KeyAction, label: string): KeyHint[] => {
    const cap = keyCap(keys.label(action));
    return cap === '' ? [] : [[cap, label]];
  };
  // Quitting is a double press of the interrupt key.
  const quitHint = (): { right?: KeyHint } => {
    const cap = keyCap(keys.label('app.interrupt'));
    return cap === '' ? {} : { right: [`${cap} ${cap}`, 'quit'] };
  };
  if (context === 'approval') {
    return {
      hints: [
        ...bound('approval.allowOnce', 'allow once'),
        ...bound('approval.allowSession', 'allow for session'),
        ...bound('approval.deny', 'deny'),
        ...bound('approval.comment', 'deny + comment'),
        ...bound('approval.explain', 'explain'),
        ['PgUp', 'read transcript'],
      ],
      ...quitHint(),
    };
  }
  if (context === 'approvalInput') {
    return {
      hints: [
        ['⏎', 'send'],
        ['^U', 'clear'],
      ],
      right: ['esc', 'back to the card'],
    };
  }
  // The palette names its own keys.
  if (context === 'palette') {
    return {
      hints: [
        ['↑↓', 'move'],
        ['⏎', 'run'],
        ['tab', 'next group'],
        ['→', 'details'],
      ],
      right: ['esc', 'close'],
    };
  }
  // Block mode.
  if (context === 'blocks') {
    return {
      hints: [
        ['↑↓', 'move'],
        ['⏎', 'view'],
        ['y', 'copy'],
        ['Y', 'copy command'],
        ['x', 'expand'],
      ],
      right: ['esc', 'back'],
    };
  }
  // The model picker.
  if (context === 'model') {
    return {
      hints: [
        ['↑↓', 'move'],
        ['⏎', 'switch'],
        ['→', 'expand provider'],
      ],
      right: ['esc', 'keep current'],
    };
  }
  if (context === 'overlay') {
    return {
      hints: [
        ['↑↓', 'move'],
        ['⏎', 'select'],
        ['esc', 'cancel'],
      ],
    };
  }
  if (context === 'working') {
    return {
      hints: [
        ...bound('app.cancel', 'interrupt'),
        ['⏎', 'queue'],
        ...bound('prompt.steer', 'steer'),
        ...bound('transcript.expand', 'expand output'),
        ...bound('app.palette', 'palette'),
      ],
      ...quitHint(),
    };
  }
  return {
    hints: [
      ['⏎', 'send'],
      [options.newline ?? '^J', 'newline'],
      ['/', 'commands'],
      ...(options.files === true ? [['@', 'file'] as const] : []),
      ...bound('app.palette', 'palette'),
      ...bound('panel.diff', 'diff'),
      ...bound('panel.journal', 'journal'),
    ],
    ...quitHint(),
  };
}
