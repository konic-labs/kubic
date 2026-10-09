// The inline approval card.
//
// An approval does not open a centered modal over the transcript: it takes
// the editor's slot as a blocking card, so the conversation above stays
// readable (PgUp scrolls it). Heavy warn frame with the APPROVAL badge, the
// tool and `i of n`; on warnBg behind a warn `┃` edge: what will run (the
// command, paged, with its destructive words bold — or the file change's
// diff preview), one row for the reason the policy flagged, the working
// directory and what the journal covers, the model's explanation on `?`,
// the next queued ask, and the keys that answer it. Pure over a UiTheme.

import type { UiTheme } from '@kubic/core/ui/style';
import type { ApprovalAction, ApprovalViewRequest } from './approval-view.js';
import { keyCap } from './chrome.js';
import type { CellDisplay } from './transcript-entry.js';
import { visibleWidth } from './tui-boundary.js';
import {
  type DiffRow,
  parseDisplayDiff,
  renderDiffRows,
} from './ui/diff-block.js';
import { frameLines } from './ui/frame.js';
import { fitLine, leftRight, wrapStyled } from './ui/line.js';
import { badge } from './ui/marks.js';

/** Diff rows a collapsed preview shows (the page key shows all). */
const APPROVAL_PREVIEW_ROWS = 12;

const LABEL_WIDTH = 13;

// What each capability means, in the operator's words. An unknown
// capability shows its own name.
const REASONS: Readonly<Record<string, readonly [string, string]>> = {
  network: ['network', 'it can reach the network'],
  credentials: ['credentials', 'it can read or use credentials'],
  'git-push': ['git push', 'it publishes commits to a remote'],
  'destructive-shell': ['destructive', 'it can delete or overwrite files'],
  install: ['install', 'it installs packages'],
  deploy: ['deploy', 'it deploys'],
  'outside-write': ['outside', 'it writes outside the workspace'],
  'privilege-escalation': ['privilege', 'it runs with elevated privileges'],
  'kubic-state-write': [
    'kubic state',
    "it writes Kubic's own state (.kubic/) — this always asks",
  ],
};

/** @internal */
export function approvalReason(capability: string): readonly [string, string] {
  return REASONS[capability] ?? [capability, ''];
}

// Words that make a shell command destructive, shown bold in the card.
const DESTRUCTIVE =
  /(\brm\b(?:\s+-[A-Za-z]+)*|\bsudo\b|\bdd\b|\bmkfs\S*|\bchmod\s+-R\b|\bchown\s+-R\b|--force\b|\s-f\b|\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bdrop\b|\btruncate\b|>\s*\/dev\/\S+)/giu;

function emphasize(ui: UiTheme, text: string): string {
  let out = '';
  let last = 0;
  for (const hit of text.matchAll(DESTRUCTIVE)) {
    const at = hit.index ?? 0;
    out += ui.fg('fg0')(text.slice(last, at));
    out += ui.style({ fg: 'warn', bold: true })(hit[0]);
    last = at + hit[0].length;
  }
  return out + ui.fg('fg0')(text.slice(last));
}

export interface ApprovalCardOptions {
  /** False during the arming window: only Esc (deny) acts. */
  readonly armed: boolean;
  /** False while the card cannot show the whole command. */
  readonly allowable: boolean;
  readonly keys: Record<ApprovalAction, readonly string[]>;
  /** The page of a long command (or the open full diff). */
  readonly commandPage: number;
  /** 1-based place of the shown ask, and how many are waiting in all. */
  readonly position: number;
  readonly total: number;
  /** The ask after this one, when one is queued. */
  readonly next?: ApprovalViewRequest;
  /** `?` opened the model's explanation. */
  readonly explain: boolean;
  /** The workspace, already shortened for display (`~/proj`). */
  readonly cwd?: string;
  readonly pageKey: string;
  readonly explainKey: string;
  /** The open comment or command input, if any. */
  readonly input?: { readonly kind: 'comment' | 'edit'; readonly text: string };
}

// The card shows what will actually run. A command wraps across
// rows; one page holds this many, and a taller command says which rows are
// shown (`… lines a–b of n`) — the height is capped honestly, never by a
// silent cut.
/** @internal */
export const APPROVAL_COMMAND_PAGE_LINES = 8;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// One command line as rows of at most `room` terminal COLUMNS,
// cut exactly where the room ends — never at a space, so a row break never
// hides one (`rm -rf /` + `tmp` reads the same as `rm -rf /tmp` under word
// wrap). The unit is the grapheme cluster (a combining or emoji ZWJ sequence
// is one unit) measured with pi-tui's own width; a unit wider than the room
// still gets a row of its own — nothing is skipped.
/** @internal */
export function wrapByColumns(line: string, room: number): string[] {
  const rows: string[] = [];
  let row = '';
  let used = 0;
  for (const { segment } of graphemes.segment(line)) {
    const cells = visibleWidth(segment);
    if (used > 0 && used + cells > room) {
      rows.push(row);
      row = '';
      used = 0;
    }
    row += segment;
    used += cells;
  }
  rows.push(row);
  return rows;
}

function commandRows(command: string, room: number): string[] {
  const rows: string[] = [];
  for (const line of command.split('\n')) {
    rows.push(...(line === '' ? [''] : wrapByColumns(line, Math.max(1, room))));
  }
  return rows;
}

function previewRows(preview: CellDisplay): DiffRow[] {
  if (preview.kind === 'diff') return parseDisplayDiff(preview.text);
  return (preview.preview === '' ? [] : preview.preview.split('\n')).map(
    (text, index) => ({
      kind: 'add' as const,
      number: String(index + 1),
      text,
    }),
  );
}

function previewCounts(ui: UiTheme, preview: CellDisplay): string {
  if (preview.kind === 'diff') {
    return `${ui.fg('add')(`+${preview.added}`)} ${ui.fg('del')(`−${preview.removed}`)}`;
  }
  const added = ui.fg('add')(`+${preview.lines}`);
  return preview.newFile ? `${ui.fg('fg2')('new file')} ${added}` : added;
}

/** What the request will do, in one line (the `next:` row). */
function oneLine(request: ApprovalViewRequest): string {
  const what =
    request.command ??
    request.paths?.join(', ') ??
    request.summary ??
    request.capability;
  return `${request.toolName} ${what}`.replace(/\s+/g, ' ').trim();
}

const INDENT = '  ';
const KEY_GAP = '    ';

// What will run: the edit/write diff preview, else the command (paged by
// lines), else the paths or the summary. `paged` says whether the page key
// shows more.
function whatRows(
  ui: UiTheme,
  request: ApprovalViewRequest,
  room: number,
  commandPage: number,
): { rows: string[]; paged: boolean } {
  const preview = request.preview;
  const rows: string[] = [];
  if (preview !== undefined) {
    const all = previewRows(preview);
    const full = commandPage % 2 === 1;
    const shown = full ? all : all.slice(0, APPROVAL_PREVIEW_ROWS);
    const digits = Math.max(1, ...all.map((row) => row.number.length));
    for (const line of renderDiffRows(ui, shown, room, {
      numberWidth: digits,
    })) {
      rows.push(`${INDENT}${line}`);
    }
    if (all.length <= shown.length) return { rows, paged: false };
    rows.push(
      `${INDENT}${ui.fg('fg2')(`… ${all.length - shown.length} more lines`)}`,
    );
    return { rows, paged: true };
  }
  if (request.command !== undefined && request.command !== '') {
    const all = commandRows(request.command, room - 2);
    const pages = Math.max(
      1,
      Math.ceil(all.length / APPROVAL_COMMAND_PAGE_LINES),
    );
    const page = ((commandPage % pages) + pages) % pages;
    const from = page * APPROVAL_COMMAND_PAGE_LINES;
    const shown = all.slice(from, from + APPROVAL_COMMAND_PAGE_LINES);
    shown.forEach((row, index) => {
      rows.push(
        `${INDENT}${index === 0 && page === 0 ? ui.fg('fg2')('$ ') : '  '}${emphasize(ui, row)}`,
      );
    });
    if (pages <= 1) return { rows, paged: false };
    rows.push(
      `${INDENT}${ui.fg('fg2')(`… lines ${from + 1}–${from + shown.length} of ${all.length}`)}`,
    );
    return { rows, paged: true };
  }
  const what =
    request.paths !== undefined && request.paths.length > 0
      ? request.paths.join(', ')
      : (request.summary ?? '');
  rows.push(`${INDENT}${ui.fg('fg0')(what)}`);
  return { rows, paged: false };
}

// Why it asks: the capability's reason, the working directory, the model's
// explanation when asked for, and the next queued ask.
function whyRows(
  ui: UiTheme,
  request: ApprovalViewRequest,
  options: ApprovalCardOptions,
  narrow: boolean,
): string[] {
  const rows: string[] = [];
  const [label, sentence] = approvalReason(request.capability);
  rows.push(
    `${INDENT}${ui.fg('warn')('▲')} ${ui.fg('fg0')(label.padEnd(LABEL_WIDTH))}${narrow || sentence === '' ? '' : ` ${ui.fg('fg1')(sentence)}`}`,
  );
  if (options.cwd !== undefined && options.cwd !== '') {
    const journaled =
      request.toolName === 'edit' || request.toolName === 'write'
        ? ' · the journal keeps the old file, /undo restores it'
        : '';
    rows.push(
      `${INDENT}${ui.fg('fg2')('○')} ${ui.fg('fg0')('cwd'.padEnd(LABEL_WIDTH))} ${ui.fg('fg2')(`${options.cwd}${narrow ? '' : journaled}`)}`,
    );
  }
  if (options.explain) {
    const why = request.justification ?? request.summary ?? '';
    rows.push(
      `${INDENT}${ui.fg('info')('ℹ')} ${ui.fg('fg0')('why'.padEnd(LABEL_WIDTH))} ${ui.fg('fg1')(why === '' ? 'the model gave no reason' : why)}`,
    );
  }
  if (options.next !== undefined) {
    rows.push('');
    rows.push(
      `${INDENT}${ui.fg('fg2')('next:')} ${ui.fg('fg1')(oneLine(options.next))}${options.next.preview === undefined ? '' : ` ${previewCounts(ui, options.next.preview)}`}`,
    );
  }
  return rows;
}

// The keys that answer it: `shown` is what the card shows now (the open
// input, the too-short refusal, the locked hint, or the keys), `armed` the
// keys once the card is armed.
function keyParts(
  ui: UiTheme,
  request: ApprovalViewRequest,
  options: ApprovalCardOptions,
  pageable: boolean,
): { shown: string[]; armed: string[] } {
  const cap = (action: ApprovalAction): string =>
    options.keys[action]
      .filter((key) => key !== 'escape')
      .map((key) => keyCap(key))
      .join('/');
  const key = (k: string, what: string): string =>
    k === ''
      ? ''
      : `${ui.style({ fg: 'fg0', bold: true })(k)}  ${ui.fg('fg1')(what)}`;
  const armed = [
    key(cap('allow-once'), 'allow once'),
    key(cap('allow-session'), 'allow for session'),
    key(cap('deny'), 'deny'),
    // Steering — only where the host offered it.
    key(cap('comment'), 'deny + comment'),
    request.editable === true ? key(cap('edit'), 'edit command') : '',
    request.batchable === true
      ? key(cap('allow-edits'), 'allow all edits this turn')
      : '',
    pageable
      ? key(
          options.pageKey,
          request.preview === undefined ? 'next page' : 'full diff',
        )
      : '',
    key(options.explainKey, 'explain'),
  ].filter((part) => part !== '');
  if (options.input !== undefined) {
    // The open input stands where the keys were.
    const editing = options.input.kind === 'edit';
    return {
      shown: [
        `${ui.fg('fg2')(editing ? 'edit the command ›' : 'deny with a comment ›')} ${ui.fg('fg0')(options.input.text)}${ui.fg('accent')('▏')}`,
        key('⏎', editing ? 'allow as edited' : 'deny with it'),
        key('esc', 'back'),
      ],
      armed,
    };
  }
  if (!options.allowable) {
    return {
      shown: [
        ui.fg('warn')(
          'the terminal is too short to show this command — enlarge it',
        ),
        key(cap('deny'), 'deny'),
      ],
      armed,
    };
  }
  if (!options.armed) {
    return { shown: [ui.fg('fg2')('… keys unlock in a moment')], armed };
  }
  return { shown: armed, armed };
}

// The rows a set of keys takes: one row when it fits beside `esc = deny`,
// else whole keys per row (a key is never cut off; a part wider than a row
// wraps on its own) with `esc = deny` on the last row.
function keyRows(
  set: readonly string[],
  inner: number,
  narrow: boolean,
  escDeny: string,
): string[] {
  const oneRow = `${INDENT}${set.join(KEY_GAP)}`;
  if (!narrow && visibleWidth(oneRow) + visibleWidth(escDeny) + 1 <= inner) {
    return [leftRight(oneRow, escDeny, inner)];
  }
  const rows: string[] = [];
  const keyRoom = Math.max(1, inner - INDENT.length);
  let row = '';
  for (const part of set) {
    const pieces =
      visibleWidth(part) > keyRoom ? wrapStyled(part, keyRoom) : [part];
    for (const piece of pieces) {
      if (row === '') {
        row = piece;
      } else if (
        visibleWidth(row) + KEY_GAP.length + visibleWidth(piece) <=
        keyRoom
      ) {
        row += `${KEY_GAP}${piece}`;
      } else {
        rows.push(`${INDENT}${row}`);
        row = piece;
      }
    }
  }
  if (row !== '') rows.push(`${INDENT}${row}`);
  if (escDeny !== '') rows.push(`${INDENT}${escDeny}`);
  return rows;
}

export function renderApprovalCard(
  ui: UiTheme,
  request: ApprovalViewRequest,
  width: number,
  options: ApprovalCardOptions,
): string[] {
  const w = Math.max(1, Math.floor(width) - 1);
  // The frame's inner width (a left edge only) minus the body's indent.
  const inner = Math.max(1, w - 2);
  const room = Math.max(1, inner - 3);
  const narrow = w < 60;
  const what = whatRows(ui, request, room, options.commandPage);
  const keys = keyParts(
    ui,
    request,
    options,
    what.paged || request.preview !== undefined,
  );
  const escDeny =
    options.input === undefined && options.keys.deny.includes('escape')
      ? `${ui.fg('fg2')('esc = deny')} `
      : '';
  const shownRows = keyRows(keys.shown, inner, narrow, escDeny);
  // A locked card keeps the height it will have once armed, so arming never
  // moves the frame (nor changes whether the card fits).
  if (options.input === undefined && options.allowable && !options.armed) {
    const armedHeight = keyRows(keys.armed, inner, narrow, escDeny).length;
    while (shownRows.length < armedHeight) shownRows.push('');
  }
  const body = [
    ...what.rows,
    '',
    ...whyRows(ui, request, options, narrow),
    '',
    ...shownRows,
  ];
  const preview = request.preview;
  const title = `${badge(ui, 'APPROVAL', 'waiting')}${ui.fg('warn')(' ━ ')}${ui.style({ fg: 'fg0', bold: true })(request.toolName)}${
    preview === undefined ? '' : ` ${previewCounts(ui, preview)}`
  }`;
  const lines = frameLines(ui, body, w, {
    weight: 'heavy',
    sides: 'left',
    color: 'warn',
    title,
    rightLabel: ui.fg('fg1')(`${options.position} of ${options.total}`),
    bodyBg: 'warnBg',
  });
  return lines.map((line) => fitLine(` ${line}`, w + 1));
}
