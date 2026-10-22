// The approval card shows the whole command (carried onto the
// inline card): a long command wraps by terminal columns, a
// taller one pages with an explicit `… lines a–b of n` marker — never a
// silent cut — and a terminal too short to show it cannot approve it.
// Headless renders only.

import { createUiTheme } from '@kubic/core/ui/style';
import { DARK_PALETTE } from '@kubic/core/ui/tokens';
import { describe, expect, it } from 'vitest';
import { CARD_CHROME_ROWS } from './app/approvals.js';
import {
  APPROVAL_COMMAND_PAGE_LINES,
  type ApprovalCardOptions,
  renderApprovalCard,
  wrapByColumns,
} from './approval-card.js';
import { createApprovalSurface } from './approval-surface.js';
import {
  APPROVAL_ARMING_MS,
  APPROVAL_DEFAULT_KEYS,
  APPROVAL_QUIET_MS,
  type ApprovalViewRequest,
} from './approval-view.js';
import { createTuiApp } from './tui-app.js';
import { visibleWidth } from './tui-boundary.js';

const plain = createUiTheme(DARK_PALETTE, 'none');

const OPTIONS: ApprovalCardOptions = {
  armed: true,
  allowable: true,
  keys: APPROVAL_DEFAULT_KEYS,
  commandPage: 0,
  position: 1,
  total: 1,
  explain: false,
  pageKey: 'v',
  explainKey: '?',
};

function card(
  request: ApprovalViewRequest,
  width: number,
  commandPage = 0,
): string[] {
  return renderApprovalCard(plain, request, width, {
    ...OPTIONS,
    commandPage,
  });
}

// The command rows back out of a plain card: the `$ ` row (or, past the
// first page, its indented twin) and the indented rows under it.
function commandRows(lines: readonly string[]): string[] {
  const rows: string[] = [];
  for (const line of lines.slice(1)) {
    const hit = /^ ┃ {3}(?:\$ | {2})(.*)$/u.exec(line);
    if (hit === null) break;
    rows.push(hit[1] ?? '');
  }
  return rows;
}

function request(command: string): ApprovalViewRequest {
  return {
    key: 'k-command',
    capability: 'destructive-shell',
    toolName: 'bash',
    summary: `destructive-shell: ${command.slice(0, 120)}… (+${command.length - 120} chars)`,
    command,
  };
}

const PADDED = `echo 'running formatter' ${'x'.repeat(360)}; rm -rf ~/work`;

describe('approval card command display', () => {
  it('a 400-char command renders in full, wrapped, with its tail visible', () => {
    expect(PADDED.length).toBeGreaterThan(390);
    const lines = card(request(PADDED), 80);
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    expect(commandRows(lines).join('')).toBe(PADDED);
    expect(lines.join('\n')).toContain('rm -rf ~/work');
    // No silent cut anywhere, and no second, truncated copy of the command.
    expect(lines.join('\n')).not.toMatch(/\(\+\d+ chars\)/);
    expect(lines.join('\n')).not.toContain('next page');
  });

  it('keeps the lines of a multi-line command', () => {
    const lines = card(request('cd build\nrm -rf out'), 80);
    expect(commandRows(lines)).toEqual(['cd build', 'rm -rf out']);
  });

  it('pages a command taller than a page with an explicit marker', () => {
    const long = Array.from({ length: 40 }, (_, i) => `step-${i}`).join('\n');
    const first = card(request(long), 80);
    expect(commandRows(first)).toHaveLength(APPROVAL_COMMAND_PAGE_LINES);
    expect(first.map((line) => line.trimEnd())).toContain(
      ` ┃   … lines 1–${APPROVAL_COMMAND_PAGE_LINES} of 40`,
    );
    expect(first.join('\n')).toContain('v  next page');
    const second = card(request(long), 80, 1);
    expect(commandRows(second)[0]).toBe(`step-${APPROVAL_COMMAND_PAGE_LINES}`);
    const last = card(request(long), 80, 4);
    expect(commandRows(last).at(-1)).toBe('step-39');
    // Paging wraps back to the start.
    expect(commandRows(card(request(long), 80, 5))).toEqual(commandRows(first));
  });

  it('paging through every page shows each command row exactly once', () => {
    // 72 columns a row at 80: twenty rows make pages of 8, 8 and 4.
    const command = 'a'.repeat(72 * 20);
    const seen: string[] = [];
    for (let page = 0; page < 3; page++) {
      const rows = commandRows(card(request(command), 80, page));
      expect(rows).toHaveLength(page < 2 ? 8 : 4);
      seen.push(...rows);
    }
    expect(seen.join('')).toBe(command);
  });

  it('shows the summary when the request carries no command', () => {
    const lines = card(
      {
        key: 'k',
        capability: 'outside-write',
        toolName: 'write',
        summary: 'outside-write: write /etc/hosts',
      },
      80,
    );
    expect(lines.join('\n')).toContain('outside-write: write /etc/hosts');
  });

  it('control characters in the command are sanitized in the card', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    const pending = app.requestApproval(
      request('echo \u001b[2Jhi\u0007; rm -rf x'),
    );
    const body = app.render(80).join('\n');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
    expect(body).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(body).toContain('rm -rf x');
    surface.cancelPending();
    await pending;
  });

  it('the v key pages the shown command and never decides', async () => {
    const long = Array.from({ length: 20 }, (_, i) => `step-${i}`).join('\n');
    const surface = createApprovalSurface({ armingMs: 0 });
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    const pending = app.requestApproval(request(long));
    expect(app.render(80).join('\n')).toMatch(/\bstep-0(?!\d)/);
    expect(app.handleInput('v').consumed).toBe(true);
    expect(app.hasPendingApproval()).toBe(true);
    const paged = app.render(80).join('\n');
    expect(paged).toContain(`step-${APPROVAL_COMMAND_PAGE_LINES}`);
    expect(paged).not.toMatch(/\bstep-0(?!\d)/);
    expect(app.editor.getText()).toBe('');
    surface.cancelPending();
    await pending;
  });
});

// The command wraps by terminal COLUMNS, not UTF-16
// length, and exactly where the room ends — a row of wide characters is
// twice as wide as it is long, and a word wrap would hide which row breaks
// were spaces.
describe('approval card wraps by display width', () => {
  const WIDE = `echo ${'日'.repeat(30)}; rm -rf ~/precious; ${'日'.repeat(5)}`;

  it('a command padded with wide characters keeps the destructive tail on screen', () => {
    const lines = card(request(WIDE), 70);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(70);
    }
    expect(commandRows(lines).join('')).toBe(WIDE);
    expect(lines.join('\n')).toContain('rm -rf ~/precious');
  });

  it('every wide-character row fills the room without passing it', () => {
    const rows = wrapByColumns('日'.repeat(100), 61);
    // 61 columns hold 30 wide characters; the 31st would overflow the row.
    expect(rows.map((row) => [...row].length)).toEqual([30, 30, 30, 10]);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(61);
    expect(rows.join('')).toBe('日'.repeat(100));
  });

  it('never splits a combining sequence across rows', () => {
    const cluster = 'é';
    const command = cluster.repeat(200);
    const rows = wrapByColumns(command, 31);
    expect(rows.join('')).toBe(command);
    for (const row of rows) {
      expect(row.startsWith('́')).toBe(false);
      expect(row.length % cluster.length).toBe(0);
      expect(visibleWidth(row)).toBeLessThanOrEqual(31);
    }
  });

  it('never splits an emoji ZWJ sequence across rows', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const command = `x${family.repeat(40)}`;
    const rows = wrapByColumns(command, 31);
    expect(rows.join('')).toBe(command);
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(31);
      // A split family would leave a row starting with a ZWJ or a lone member.
      expect(row.startsWith('‍')).toBe(false);
      expect(row.replaceAll(family, '').replace(/^x/, '')).toBe('');
    }
  });

  it('cuts exactly at the room, never at a space', () => {
    expect(wrapByColumns('a'.repeat(130), 61).map((row) => row.length)).toEqual(
      [61, 61, 8],
    );
    // A space stays where it was: on the row it belongs to, as that row's
    // last column or the next row's first.
    expect(wrapByColumns('rm -rf / tmp', 9)).toEqual(['rm -rf / ', 'tmp']);
    expect(wrapByColumns('rm -rf /tmp', 9)).toEqual(['rm -rf /t', 'mp']);
  });

  it('a wide character that does not fit the last column starts the next row', () => {
    // Two wide characters (4) fit 5 columns, the third would pass them.
    expect(wrapByColumns('日日日日日', 5)).toEqual(['日日', '日日', '日']);
  });

  it('a wide character in a room narrower than itself still gets a row of its own', () => {
    // No empty spacer row is emitted before it, and none is dropped.
    expect(wrapByColumns('日日', 1)).toEqual(['日', '日']);
  });

  it('wraps each line of a multi-line command by width', () => {
    // 62 columns a row at 70.
    const rows = commandRows(
      card(request(`${'日'.repeat(40)}\n\nrm -rf x`), 70),
    );
    expect(rows).toEqual(['日'.repeat(31), '日'.repeat(9), '', 'rm -rf x']);
  });
});

// A terminal too short to show the command cannot be
// used to approve it. Deny (and Esc) always work; every allow key is inert
// until the terminal is tall enough — what the operator can see is what they
// can allow.
describe('a terminal too short to show the command cannot allow it', () => {
  const REQUEST = request(PADDED);

  function setup(size: { rows: number; columns: number }) {
    let now = 1000;
    const surface = createApprovalSurface({
      now: () => now,
      setTimer: () => () => {},
    });
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    const term = { ...size };
    app.attachApprovalOverlay({
      terminal: {
        get rows() {
          return term.rows;
        },
        get columns() {
          return term.columns;
        },
      },
      showOverlay: () => ({ unfocus: () => {}, hide: () => {} }),
    });
    return {
      app,
      surface,
      term,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('a and Ctrl-S are inert on a 9-row terminal, and the card says why', async () => {
    const { app, advance } = setup({ rows: 9, columns: 100 });
    const pending = app.requestApproval(REQUEST);
    // The card itself says the terminal is too short.
    expect(app.render(100).join('\n')).toContain(
      'the terminal is too short to show this command',
    );
    advance(APPROVAL_QUIET_MS * 2);
    app.handleInput('a');
    advance(APPROVAL_QUIET_MS * 2);
    app.handleInput('\x13');
    expect(app.hasPendingApproval()).toBe(true);
    // Deny works: the armed d, and Esc at once.
    advance(APPROVAL_QUIET_MS * 2);
    app.handleInput('d');
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('Esc denies at once on a too-short terminal', async () => {
    const { app } = setup({ rows: 5, columns: 100 });
    const pending = app.requestApproval(REQUEST);
    app.handleInput('\x1b');
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('growing the terminal unlocks allow after the quiet period', async () => {
    const { app, term, advance } = setup({ rows: 9, columns: 100 });
    const pending = app.requestApproval(REQUEST);
    advance(APPROVAL_QUIET_MS * 2);
    app.handleInput('a');
    expect(app.hasPendingApproval()).toBe(true);
    term.rows = 40;
    advance(APPROVAL_QUIET_MS);
    expect(app.render(100).join('\n')).toContain('a  allow once');
    app.handleInput('a');
    await expect(pending).resolves.toEqual({
      approved: true,
      by: 'allow-once',
    });
  });

  it('fit is judged at the width the card is drawn at', async () => {
    // 200 characters are three command rows at 100 columns and four at 60,
    // where the keys wrap too: a terminal that holds the wide card exactly
    // is too short for the narrow one.
    const wide = request('x'.repeat(200));
    const rowsAt = (columns: number): number =>
      renderApprovalCard(plain, wide, columns, OPTIONS).length;
    expect(rowsAt(60)).toBeGreaterThan(rowsAt(100));
    const { app, term, advance } = setup({
      rows: rowsAt(100) + CARD_CHROME_ROWS,
      columns: 60,
    });
    const pending = app.requestApproval(wide);
    advance(APPROVAL_QUIET_MS * 2);
    app.handleInput('a');
    expect(app.hasPendingApproval()).toBe(true);
    term.columns = 100;
    advance(APPROVAL_QUIET_MS * 2);
    app.handleInput('a');
    await expect(pending).resolves.toMatchObject({ approved: true });
  });

  it('a terminal exactly tall enough for the card allows normally', async () => {
    // The card and CARD_CHROME_ROWS (header, status, hints and
    // three transcript rows) must fit; one row less keeps allow inert.
    const { app, term, advance } = setup({ rows: 60, columns: 100 });
    const pending = app.requestApproval(REQUEST);
    const frame = app.render(100);
    const top = frame.findIndex((line) => line.startsWith(' ┏'));
    const bottom = frame.findIndex((line) => line.startsWith(' ┗'));
    const cardRows = bottom - top + 1;
    term.rows = cardRows + CARD_CHROME_ROWS - 1;
    advance(APPROVAL_ARMING_MS);
    app.handleInput('a');
    expect(app.hasPendingApproval()).toBe(true);
    term.rows = cardRows + CARD_CHROME_ROWS;
    advance(APPROVAL_QUIET_MS);
    app.handleInput('a');
    await expect(pending).resolves.toMatchObject({ approved: true });
  });

  it('a narrow terminal shows the card and judges its fit the same way', async () => {
    const { app, advance } = setup({ rows: 40, columns: 60 });
    const pending = app.requestApproval(REQUEST);
    advance(APPROVAL_ARMING_MS);
    app.handleInput('a');
    await expect(pending).resolves.toMatchObject({ approved: true });
  });

  it('the surface reports what it can allow', () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    expect(surface.isAllowable()).toBe(true);
    let fits = false;
    surface.fitCheck = () => fits;
    expect(surface.isAllowable()).toBe(false);
    fits = true;
    expect(surface.isAllowable()).toBe(true);
  });
});
