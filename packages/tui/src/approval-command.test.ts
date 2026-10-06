// The approval dialog shows the whole command (issue #316; §41.2, §16.4): a
// long command wraps across lines, and when it needs more rows than a page
// the dialog says exactly what is hidden and how to see it — never a silent
// cut. Headless renders only.
import { describe, expect, it } from 'vitest';
import { createApprovalSurface } from './approval-surface.js';
import {
  APPROVAL_ARMING_MS,
  APPROVAL_COMMAND_PAGE_LINES,
  APPROVAL_QUIET_MS,
  ApprovalView,
  type ApprovalViewRequest,
  approvalFitsOverlay,
  approvalOverlayOptions,
  approvalOverlayRows,
  approvalOverlayWidth,
  renderApprovalLines,
} from './approval-view.js';
import { CARD_CHROME_ROWS, createTuiApp } from './tui-app.js';
import { visibleWidth } from './tui-boundary.js';

const PREFIX = 'command: ';
const INDENT = ' '.repeat(PREFIX.length);

// The command text back out of the rendered rows (prefix/indent removed).
function commandRows(lines: string[]): string[] {
  const start = lines.findIndex((line) => line.startsWith(PREFIX));
  if (start < 0) return [];
  const rows = [lines[start]?.slice(PREFIX.length) ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(INDENT)) break;
    rows.push(line.slice(INDENT.length));
  }
  return rows;
}

function request(command: string): ApprovalViewRequest {
  return {
    key: 'k-316',
    capability: 'destructive-shell',
    toolName: 'bash',
    summary: `destructive-shell: ${command.slice(0, 120)}… (+${command.length - 120} chars)`,
    command,
  };
}

const PADDED = `echo 'running formatter' ${'x'.repeat(360)}; rm -rf ~/work`;

describe('approval dialog command display (issue #316)', () => {
  it('a 400-char command renders in full, wrapped, with its tail visible', () => {
    expect(PADDED.length).toBeGreaterThan(390);
    const lines = renderApprovalLines(request(PADDED), 80);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    expect(commandRows(lines).join('')).toBe(PADDED);
    expect(lines.join('\n')).toContain('rm -rf ~/work');
    // No silent cut anywhere, and no second, truncated copy of the command.
    expect(lines.some((line) => line.startsWith('summary:'))).toBe(false);
    expect(lines.join('\n')).not.toContain('next page');
  });

  it('keeps the lines of a multi-line command', () => {
    const lines = renderApprovalLines(request('cd build\nrm -rf out'), 80);
    expect(commandRows(lines)).toEqual(['cd build', 'rm -rf out']);
  });

  it('pages a command taller than a page with an explicit marker', () => {
    const long = Array.from({ length: 40 }, (_, i) => `step-${i}`).join('\n');
    const first = renderApprovalLines(request(long), 80);
    expect(commandRows(first)).toHaveLength(APPROVAL_COMMAND_PAGE_LINES);
    const marker = first.find((line) => line.startsWith('… command lines'));
    expect(marker).toBe(
      `… command lines 1–${APPROVAL_COMMAND_PAGE_LINES} of 40 · [v] next page`,
    );
    const second = renderApprovalLines(request(long), 80, { commandPage: 1 });
    expect(commandRows(second)[0]).toBe(`step-${APPROVAL_COMMAND_PAGE_LINES}`);
    const last = renderApprovalLines(request(long), 80, { commandPage: 4 });
    expect(commandRows(last).at(-1)).toBe('step-39');
    // Paging wraps back to the start.
    const wrapped = renderApprovalLines(request(long), 80, { commandPage: 5 });
    expect(commandRows(wrapped)).toEqual(commandRows(first));
  });

  it('shows the summary when the request carries no command', () => {
    const lines = renderApprovalLines(
      {
        key: 'k',
        capability: 'outside-write',
        toolName: 'write',
        summary: 'outside-write: write /etc/hosts',
      },
      80,
    );
    expect(lines).toContain('summary: outside-write: write /etc/hosts');
  });

  it('control characters in the command are sanitized in the card', async () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
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
      mode: 'solo',
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

// Issue #316 (re-audit): the command wraps by terminal COLUMNS, not UTF-16
// length. The overlay compositor cuts every row at the overlay width, so a
// row wider than that hides its tail with no marker — behind wide characters
// a destructive command can vanish from the dialog.
describe('approval dialog wraps by display width (issue #316)', () => {
  // A 100x30 terminal composites the overlay at 70% width.
  const OVERLAY_WIDTH = 70;
  const room = OVERLAY_WIDTH - PREFIX.length;
  const WIDE = `echo ${'日'.repeat(30)}; rm -rf ~/precious; ${'日'.repeat(5)}`;

  it('a command padded with wide characters keeps the destructive tail on screen', () => {
    const lines = renderApprovalLines(request(WIDE), OVERLAY_WIDTH);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(OVERLAY_WIDTH);
    }
    expect(commandRows(lines).join('')).toBe(WIDE);
    expect(lines.join('\n')).toContain('rm -rf ~/precious');
  });

  it('every wide-character row fills the room without passing it', () => {
    const rows = commandRows(
      renderApprovalLines(request('日'.repeat(100)), OVERLAY_WIDTH),
    );
    // 61 columns hold 30 wide characters; the 31st would overflow the row.
    expect(rows.map((row) => [...row].length)).toEqual([30, 30, 30, 10]);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(room);
    expect(rows.join('')).toBe('日'.repeat(100));
  });

  it('never splits a combining sequence across rows', () => {
    const cluster = 'e\u0301';
    const command = cluster.repeat(200);
    const rows = commandRows(renderApprovalLines(request(command), 40));
    expect(rows.join('')).toBe(command);
    for (const row of rows) {
      expect(row.startsWith('\u0301')).toBe(false);
      expect(row.length % cluster.length).toBe(0);
      expect(visibleWidth(row)).toBeLessThanOrEqual(40 - PREFIX.length);
    }
  });

  it('never splits an emoji ZWJ sequence across rows', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    const command = `x${family.repeat(40)}`;
    const rows = commandRows(renderApprovalLines(request(command), 40));
    expect(rows.join('')).toBe(command);
    for (const row of rows) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(40 - PREFIX.length);
      // A split family would leave a row starting with a ZWJ or a lone member.
      expect(row.startsWith('\u200D')).toBe(false);
      expect(row.replaceAll(family, '').replace(/^x/, '')).toBe('');
    }
  });

  it('ASCII still fills each row to the exact room', () => {
    const rows = commandRows(
      renderApprovalLines(request('a'.repeat(130)), OVERLAY_WIDTH),
    );
    expect(rows.map((row) => row.length)).toEqual([room, room, 130 - 2 * room]);
  });

  it('a wide character that does not fit the last column starts the next row', () => {
    // room is 5 columns: two wide characters (4) fit, the third would pass 5.
    const rows = commandRows(
      renderApprovalLines(request('日日日日日'), PREFIX.length + 5),
    );
    expect(rows).toEqual(['日日', '日日', '日']);
  });

  it('a wide character in a room narrower than itself still gets a row of its own', () => {
    // No empty spacer row is emitted before it, and none is dropped.
    const rows = commandRows(
      renderApprovalLines(request('日日'), PREFIX.length + 1),
    );
    expect(rows).toHaveLength(2);
  });

  it('wraps each line of a multi-line command by width', () => {
    const rows = commandRows(
      renderApprovalLines(
        request(`${'日'.repeat(40)}\n\nrm -rf x`),
        OVERLAY_WIDTH,
      ),
    );
    expect(rows).toEqual(['日'.repeat(30), '日'.repeat(10), '', 'rm -rf x']);
  });

  it('truncates the other rows by columns too, with the … marker', () => {
    const lines = renderApprovalLines(
      { ...request('ls'), paths: ['日'.repeat(60)] },
      OVERLAY_WIDTH,
    );
    const paths = lines.find((line) => line.startsWith('paths: '));
    expect(paths).toBe(`paths: ${'日'.repeat(31)}…`);
    expect(visibleWidth(paths ?? '')).toBeLessThanOrEqual(OVERLAY_WIDTH);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(OVERLAY_WIDTH);
    }
  });

  it('a zero-width render draws empty rows, not stray markers', () => {
    const lines = renderApprovalLines({ ...request('ls'), paths: ['/x'] }, 0);
    expect(lines.every((line) => line === '')).toBe(true);
  });

  it('keeps the … cut for an ASCII line that is too long', () => {
    const lines = renderApprovalLines(
      { ...request('ls'), justification: 'y'.repeat(200) },
      OVERLAY_WIDTH,
    );
    expect(lines.find((line) => line.startsWith('justification: '))).toBe(
      `justification: ${'y'.repeat(OVERLAY_WIDTH - 'justification: '.length - 1)}…`,
    );
  });
});

// Issue #316 (re-audit): the overlay is capped at 60% of the terminal height
// and Pi cuts what does not fit from the BOTTOM — on a short terminal a tall
// command used to lose its tail, the justification and the hint row with no
// marker. Given the row budget the dialog pages to fit instead, so the hint
// row and an explicit `… command lines a–b of n` marker always show.
describe('approval dialog fits the overlay height (issue #316)', () => {
  const HINT = '[a] allow once   [Ctrl-S] allow session   [d]/[Esc] deny';

  it('a 12-row terminal budget (7 rows) keeps the marker and the hint row', () => {
    const rows = approvalOverlayRows(12);
    expect(rows).toBe(7);
    const lines = renderApprovalLines(request(PADDED), 70, { maxRows: rows });
    expect(lines).toHaveLength(7);
    expect(lines.at(-1)).toBe(HINT);
    expect(lines.at(-2)).toBe('justification: (none)');
    expect(lines.at(-3)).toBe('… command lines 1–2 of 7 · [v] next page');
    expect(commandRows(lines)).toHaveLength(2);
  });

  it('a budget that holds the whole command shows it unpaged', () => {
    // 2 head + 7 command rows + justification + hint = 11 rows.
    const lines = renderApprovalLines(request(PADDED), 70, { maxRows: 11 });
    expect(lines).toHaveLength(11);
    expect(commandRows(lines).join('')).toBe(PADDED);
    expect(lines.join('\n')).not.toContain('next page');
  });

  it('one row less than that pages, and the marker takes the freed row', () => {
    const lines = renderApprovalLines(request(PADDED), 70, { maxRows: 10 });
    expect(lines).toHaveLength(10);
    expect(commandRows(lines)).toHaveLength(5);
    expect(lines.join('\n')).toContain('… command lines 1–5 of 7');
  });

  it('paging through every page shows each command row exactly once', () => {
    const seen: string[] = [];
    for (let page = 0; page < 4; page++) {
      const lines = renderApprovalLines(request(PADDED), 70, {
        maxRows: 7,
        commandPage: page,
      });
      // Three full pages of two rows; the last page holds the one row left.
      expect(lines).toHaveLength(page < 3 ? 7 : 6);
      seen.push(...commandRows(lines));
    }
    expect(seen.join('')).toBe(PADDED);
  });

  // The shape Pi gives an overlay: it cuts the rendered lines from the BOTTOM
  // at floor(0.6 * rows). Whatever the dialog renders must be safe under that
  // cut — either everything the operator needs is inside it (the marker or the
  // whole command, the justification and the hint row), or the dialog says the
  // terminal is too short and offers deny only.
  const COMMANDS: Record<string, string> = {
    padded: PADDED,
    'harmless first, rm last': `echo harmless padding ${'x'.repeat(40)}\nrm -rf ~`,
    long: Array.from({ length: 30 }, (_, i) => `step-${i}`).join('\n'),
    short: 'ls',
    'two rows': 'echo a\nrm -rf ~',
  };
  const EXTRAS: Record<string, Partial<ApprovalViewRequest>> = {
    none: {},
    paths: { paths: ['/a', '/b'] },
    justified: { justification: 'because' },
    both: { paths: ['/a'], justification: 'because' },
  };

  it('at every terminal height the dialog is complete inside the overlay, or fails closed', () => {
    let full = 0;
    let closed = 0;
    for (let height = 1; height <= 30; height++) {
      const maxRows = approvalOverlayRows(height);
      for (const [name, command] of Object.entries(COMMANDS)) {
        for (const [extraName, extra] of Object.entries(EXTRAS)) {
          const label = `h=${height} ${name} ${extraName}`;
          const req = { ...request(command), ...extra };
          const lines = renderApprovalLines(req, 70, { maxRows });
          const visible = lines.slice(0, maxRows);
          // Nothing Pi would cut is ever rendered.
          expect(lines.length, label).toBeLessThanOrEqual(maxRows);
          const fits = approvalFitsOverlay(req, 70, maxRows);
          if (fits) {
            full++;
            expect(visible.at(-1), label).toBe(HINT);
            expect(visible.join('\n'), label).toContain('justification: ');
            const rows = commandRows(visible);
            const marker = visible.some((line) =>
              line.startsWith('… command lines'),
            );
            // Either the marker says what is hidden, or every row is shown.
            expect(
              marker || rows.join('') === command.replaceAll('\n', ''),
              label,
            ).toBe(true);
            expect(visible.join('\n'), label).not.toContain('Too short');
          } else {
            closed++;
            const text = visible.join('\n');
            expect(text, label).toContain('Too short');
            expect(text, label).toContain('[d]/[Esc] deny');
            // No allow key is advertised, and no half-command is shown.
            expect(text, label).not.toContain('allow');
            expect(visible.some((line) => line.startsWith('command: '))).toBe(
              false,
            );
          }
        }
      }
    }
    // The sweep really covered both outcomes.
    expect(full).toBeGreaterThan(100);
    expect(closed).toBeGreaterThan(100);
  });

  it('fits exactly when the fixed rows, the marker and one command row fit', () => {
    // 2 head + justification + hint = 4 fixed rows.
    expect(approvalFitsOverlay(request(PADDED), 70, 5)).toBe(false);
    expect(approvalFitsOverlay(request(PADDED), 70, 6)).toBe(true);
    // A one-row command needs no marker: 4 + 1.
    expect(approvalFitsOverlay(request('ls'), 70, 4)).toBe(false);
    expect(approvalFitsOverlay(request('ls'), 70, 5)).toBe(true);
    // Two rows: both shown at 6, or one row + marker at 6 — but not at 5.
    expect(approvalFitsOverlay(request('echo a\nrm -rf ~'), 70, 5)).toBe(false);
    expect(approvalFitsOverlay(request('echo a\nrm -rf ~'), 70, 6)).toBe(true);
    // A paths row is one more fixed row.
    const withPaths = { ...request(PADDED), paths: ['/a'] };
    expect(approvalFitsOverlay(withPaths, 70, 6)).toBe(false);
    expect(approvalFitsOverlay(withPaths, 70, 7)).toBe(true);
    // No overlay height limit means it always fits.
    expect(approvalFitsOverlay(request(PADDED), 70, undefined)).toBe(true);
  });

  it('the reviewer case: a 6-row terminal never shows only the first command row', () => {
    const command = `echo harmless padding ${'x'.repeat(40)}\nrm -rf ~`;
    const maxRows = approvalOverlayRows(6);
    expect(maxRows).toBe(3);
    const lines = renderApprovalLines(request(command), 70, { maxRows });
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('echo harmless');
    expect(lines[0]).toBe('Too short to show this command — [d]/[Esc] deny');
  });

  it('the fail-closed block is one deny line on a one-row overlay and grows with the budget', () => {
    expect(renderApprovalLines(request(PADDED), 70, { maxRows: 1 })).toEqual([
      'Too short to show this command — [d]/[Esc] deny',
    ]);
    const two = renderApprovalLines(request(PADDED), 70, { maxRows: 2 });
    expect(two).toEqual([
      'Too short to show this command — [d]/[Esc] deny',
      'Approval required: destructive-shell',
    ]);
    const three = renderApprovalLines(request(PADDED), 70, { maxRows: 3 });
    expect(three.at(-1)).toBe('tool: bash');
    const four = renderApprovalLines(request(PADDED), 70, { maxRows: 4 });
    expect(four).toHaveLength(4);
    expect(four.at(-1)).toBe(
      'Enlarge the terminal to review the whole command.',
    );
    // Nothing beyond the block: a 5-row budget that cannot fit still shows 4.
    expect(renderApprovalLines(request(PADDED), 70, { maxRows: 5 })).toEqual(
      four,
    );
  });

  it('the overlay width is 70% of the columns, floored, at least one', () => {
    expect(approvalOverlayWidth(100)).toBe(70);
    expect(approvalOverlayWidth(101)).toBe(70);
    expect(approvalOverlayWidth(99)).toBe(69);
    expect(approvalOverlayWidth(80)).toBe(56);
    expect(approvalOverlayWidth(1)).toBe(1);
    expect(approvalOverlayWidth(0)).toBe(1);
  });

  it('the fail-closed block names the configured deny keys and fits a narrow overlay', () => {
    const lines = renderApprovalLines(request(PADDED), 30, {
      maxRows: 2,
      keys: {
        'allow-once': ['a'],
        'allow-session': ['ctrl+s'],
        deny: ['q'],
      },
    });
    expect(lines[0]?.startsWith('Too short')).toBe(true);
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    expect(
      renderApprovalLines(request(PADDED), 70, {
        maxRows: 1,
        keys: {
          'allow-once': ['a'],
          'allow-session': ['ctrl+s'],
          deny: ['q'],
        },
      }),
    ).toEqual(['Too short to show this command — [q] deny']);
  });

  it('a budget larger than a page still pages at the documented page size', () => {
    const long = Array.from({ length: 40 }, (_, i) => `step-${i}`).join('\n');
    const lines = renderApprovalLines(request(long), 80, { maxRows: 60 });
    expect(commandRows(lines)).toHaveLength(APPROVAL_COMMAND_PAGE_LINES);
  });

  it('without a budget nothing changes', () => {
    expect(renderApprovalLines(request(PADDED), 70)).toEqual(
      renderApprovalLines(request(PADDED), 70, { maxRows: undefined }),
    );
  });

  it('the overlay row budget is 60% of the terminal, floored, at least one row', () => {
    expect(approvalOverlayOptions().maxHeight).toBe('60%');
    expect(approvalOverlayRows(30)).toBe(18);
    expect(approvalOverlayRows(29)).toBe(17);
    expect(approvalOverlayRows(28)).toBe(16);
    expect(approvalOverlayRows(1)).toBe(1);
    expect(approvalOverlayRows(0)).toBe(1);
  });

  it('the card pages the command at its fixed page size (issue #459)', () => {
    const surface = createApprovalSurface({ armingMs: 0 });
    const app = createTuiApp({
      sessionId: 's',
      model: 'm',
      mode: 'solo',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    const long = Array.from({ length: 20 }, (_, i) => `step-${i}`).join('\n');
    void app.requestApproval(request(long));
    const doc = app.render(100).join('\n');
    expect(doc).toContain('$ step-0');
    expect(doc).toContain(`… lines 1–${APPROVAL_COMMAND_PAGE_LINES} of 20`);
    expect(doc).not.toContain(`step-${APPROVAL_COMMAND_PAGE_LINES}\n`);
    surface.cancelPending();
  });
});

// Issue #316 (re-audit): a terminal too short to show the command cannot be
// used to approve it. Deny (and Esc) always work; every allow key is inert
// until the terminal is tall enough — what the operator can see is what they
// can allow.
describe('a terminal too short to show the command cannot allow it (issue #316)', () => {
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
      mode: 'solo',
      approvalsSkipped: false,
      approvalSurface: surface,
    });
    const term = { ...size };
    const shown: Array<{ render: (w: number) => string[] }> = [];
    app.attachApprovalOverlay({
      terminal: {
        get rows() {
          return term.rows;
        },
        get columns() {
          return term.columns;
        },
      },
      showOverlay: (component) => {
        shown.push(component as { render: (w: number) => string[] });
        return { unfocus: () => {}, hide: () => {} };
      },
    });
    return {
      app,
      surface,
      term,
      shown,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('a and Ctrl-S are inert on a 9-row terminal, and the card says why', async () => {
    const { app, advance } = setup({ rows: 9, columns: 100 });
    const pending = app.requestApproval(REQUEST);
    // Issue #459: the card itself says the terminal is too short.
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

  it('fit is judged at the overlay width, not the terminal width', async () => {
    // 90 characters are one row at 100 columns but two at the overlay's 70:
    // on a 9-row terminal (5 overlay rows) only the one-row form fits.
    const wide = request('x'.repeat(90));
    expect(approvalFitsOverlay(wide, 100, 5)).toBe(true);
    expect(approvalFitsOverlay(wide, approvalOverlayWidth(100), 5)).toBe(false);
    const { app, advance } = setup({ rows: 9, columns: 100 });
    const pending = app.requestApproval(wide);
    advance(APPROVAL_QUIET_MS * 2);
    app.handleInput('a');
    expect(app.hasPendingApproval()).toBe(true);
    app.handleInput('\x1b');
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it('a terminal exactly tall enough for the card allows normally', async () => {
    // Issue #459: the card and CARD_CHROME_ROWS (header, status, hints and
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

  it('the view ignores allow keys while it cannot allow, and never deny', () => {
    const decided: string[] = [];
    let can = false;
    const view = new ApprovalView({
      request: REQUEST,
      onDecision: (action) => decided.push(action),
      canAllow: () => can,
    });
    view.handleInput('a');
    view.handleInput('\x13');
    expect(decided).toEqual([]);
    view.handleInput('d');
    view.handleInput('\x1b');
    expect(decided).toEqual(['deny', 'deny']);
    can = true;
    view.handleInput('a');
    view.handleInput('\x13');
    expect(decided).toEqual(['deny', 'deny', 'allow-once', 'allow-session']);
  });
});
