// The inline approval card (EPIC N, issue #459; docs/ui/02-approval.html).
//
// An approval no longer opens a centered modal over the transcript: it takes
// the editor's slot as a blocking card, so the conversation above stays
// readable (PgUp scrolls it). Heavy warn frame with the APPROVAL badge, the
// tool and `i of n`; on warnBg behind a warn `┃` edge: what will run (the
// command, paged, with its destructive words bold — or the file change's
// diff preview), one row for the reason the policy flagged, the working
// directory and what the journal covers, the model's explanation on `?`,
// the next queued ask, and the keys that answer it. Pure over a UiTheme.

import type { UiTheme } from '../../core/src/ui/style.js';
import {
  APPROVAL_COMMAND_PAGE_LINES,
  type ApprovalAction,
  type ApprovalViewRequest,
} from './approval-view.js';
import { keyCap } from './chrome.js';
import type { CellDisplay } from './transcript.js';
import { wrapTextWithAnsi } from './tui-boundary.js';
import {
  type DiffRow,
  parseDisplayDiff,
  renderDiffRows,
} from './ui/diff-block.js';
import { frameLines } from './ui/frame.js';
import { fitLine, leftRight } from './ui/line.js';
import { badge } from './ui/marks.js';

/** Diff rows a collapsed preview shows (the page key shows all). */
const APPROVAL_PREVIEW_ROWS = 12;

const LABEL_WIDTH = 13;

// What each capability means, in the operator's words (02-C). An unknown
// capability shows its own name.
const REASONS: Readonly<Record<string, readonly [string, string]>> = {
  network: ['network', 'it can reach the network'],
  credentials: ['credentials', 'it can read or use credentials'],
  'git-push': ['git push', 'it publishes commits to a remote'],
  'destructive-shell': ['destructive', 'it can delete or overwrite files'],
  install: ['install', 'it installs packages'],
  deploy: ['deploy', 'it deploys'],
  'outside-write': ['outside', 'it writes outside the workspace'],
  'budget-overrun': ['budget', 'it goes past the session budget'],
  'spawn-agents': ['agents', 'it starts more agents'],
  'privilege-escalation': ['privilege', 'it runs with elevated privileges'],
  'kubic-state-write': [
    'kubic state',
    "it writes Kubic's own state (.kubic/) — this always asks",
  ],
};

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
  /** False while the card cannot show the whole command (#316). */
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
}

function commandRows(command: string, room: number): string[] {
  const rows: string[] = [];
  for (const line of command.split('\n')) {
    if (line === '') {
      rows.push('');
      continue;
    }
    rows.push(...wrapTextWithAnsi(line, Math.max(1, room)));
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
  const body: string[] = [];
  const indent = '  ';
  // What will run.
  const preview = request.preview;
  let paged = false;
  if (preview !== undefined) {
    const rows = previewRows(preview);
    const full = options.commandPage % 2 === 1;
    const shown = full ? rows : rows.slice(0, APPROVAL_PREVIEW_ROWS);
    const digits = Math.max(1, ...rows.map((row) => row.number.length));
    for (const line of renderDiffRows(ui, shown, room, {
      numberWidth: digits,
    })) {
      body.push(`${indent}${line}`);
    }
    if (rows.length > shown.length) {
      paged = true;
      body.push(
        `${indent}${ui.fg('fg2')(`… ${rows.length - shown.length} more lines`)}`,
      );
    }
  } else if (request.command !== undefined && request.command !== '') {
    const rows = commandRows(request.command, room - 2);
    const pages = Math.max(
      1,
      Math.ceil(rows.length / APPROVAL_COMMAND_PAGE_LINES),
    );
    const page = ((options.commandPage % pages) + pages) % pages;
    const from = page * APPROVAL_COMMAND_PAGE_LINES;
    const shown = rows.slice(from, from + APPROVAL_COMMAND_PAGE_LINES);
    shown.forEach((row, index) => {
      body.push(
        `${indent}${index === 0 && page === 0 ? ui.fg('fg2')('$ ') : '  '}${emphasize(ui, row)}`,
      );
    });
    if (pages > 1) {
      paged = true;
      body.push(
        `${indent}${ui.fg('fg2')(`… lines ${from + 1}–${from + shown.length} of ${rows.length}`)}`,
      );
    }
  } else {
    const what =
      request.paths !== undefined && request.paths.length > 0
        ? request.paths.join(', ')
        : (request.summary ?? '');
    body.push(`${indent}${ui.fg('fg0')(what)}`);
  }
  body.push('');
  // Why it asks.
  const [label, sentence] = approvalReason(request.capability);
  const narrow = w < 60;
  body.push(
    `${indent}${ui.fg('warn')('▲')} ${ui.fg('fg0')(label.padEnd(LABEL_WIDTH))}${narrow || sentence === '' ? '' : ` ${ui.fg('fg1')(sentence)}`}`,
  );
  if (options.cwd !== undefined && options.cwd !== '') {
    const journaled =
      request.toolName === 'edit' || request.toolName === 'write'
        ? ' · the journal keeps the old file, /undo restores it'
        : '';
    body.push(
      `${indent}${ui.fg('fg2')('○')} ${ui.fg('fg0')('cwd'.padEnd(LABEL_WIDTH))} ${ui.fg('fg2')(`${options.cwd}${narrow ? '' : journaled}`)}`,
    );
  }
  if (options.explain) {
    const why = request.justification ?? request.summary ?? '';
    body.push(
      `${indent}${ui.fg('info')('ℹ')} ${ui.fg('fg0')('why'.padEnd(LABEL_WIDTH))} ${ui.fg('fg1')(why === '' ? 'the model gave no reason' : why)}`,
    );
  }
  if (options.next !== undefined) {
    body.push('');
    body.push(
      `${indent}${ui.fg('fg2')('next:')} ${ui.fg('fg1')(oneLine(options.next))}${options.next.preview === undefined ? '' : ` ${previewCounts(ui, options.next.preview)}`}`,
    );
  }
  body.push('');
  // The keys that answer it.
  const cap = (action: ApprovalAction): string =>
    options.keys[action]
      .filter((key) => key !== 'escape')
      .map((key) => keyCap(key))
      .join('/');
  const key = (k: string, what: string): string =>
    k === ''
      ? ''
      : `${ui.style({ fg: 'fg0', bold: true })(k)}  ${ui.fg('fg1')(what)}`;
  const escDeny = options.keys.deny.includes('escape')
    ? `${ui.fg('fg2')('esc = deny')} `
    : '';
  let actions: string;
  if (!options.allowable) {
    actions = `${ui.fg('warn')('the terminal is too short to show this command — enlarge it')}   ${key(cap('deny'), 'deny')}`;
  } else if (!options.armed) {
    actions = ui.fg('fg2')('… keys unlock in a moment');
  } else {
    actions = [
      key(cap('allow-once'), 'allow once'),
      key(cap('allow-session'), 'allow for session'),
      key(cap('deny'), 'deny'),
      paged || preview !== undefined
        ? key(
            options.pageKey,
            preview === undefined ? 'next page' : 'full diff',
          )
        : '',
      key(options.explainKey, 'explain'),
    ]
      .filter((part) => part !== '')
      .join('    ');
  }
  if (narrow) {
    body.push(`${indent}${actions}`);
    if (escDeny !== '') body.push(`${indent}${escDeny}`);
  } else {
    body.push(leftRight(`${indent}${actions}`, escDeny, inner));
  }
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
