// The ^P palette in the app (EPIC N, issue #460; docs/ui 03-A … C): the
// command, model, session and file rows, what ⏎ does for each, Esc, the
// palette's own hint row and the dimmed screen behind it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUiTheme } from '../../core/src/ui/style.js';
import { DARK_PALETTE } from '../../core/src/ui/tokens.js';
import { createApprovalSurface } from './approval-surface.js';
import type {
  ApprovalOverlayOptions,
  ApprovalOverlayTui,
} from './approval-view.js';
import { createTuiApp, type TuiPaletteSources } from './tui-app.js';
import type { Component } from './tui-boundary.js';

afterEach(() => {
  vi.useRealTimers();
});

interface Shown {
  readonly component: Component;
  readonly options: ApprovalOverlayOptions | undefined;
  hidden: boolean;
}

function setup(listFiles?: () => readonly string[]) {
  const surface = createApprovalSurface({ armingMs: 0 });
  const app = createTuiApp({
    sessionId: 'sess-460',
    model: 'faux/m',
    mode: 'solo',
    approvalsSkipped: false,
    approvalSurface: surface,
    ...(listFiles === undefined ? {} : { listFiles }),
  });
  const shown: Shown[] = [];
  const host: ApprovalOverlayTui = {
    terminal: { columns: 120, rows: 40 },
    showOverlay: (component, options) => {
      const entry: Shown = { component, options, hidden: false };
      shown.push(entry);
      return {
        unfocus: () => {},
        hide: () => {
          entry.hidden = true;
        },
      };
    },
  };
  app.attachApprovalOverlay(host);
  const ran: string[] = [];
  const sources: TuiPaletteSources = {
    runCommand: (command) => ran.push(`run ${command}`),
    switchModel: (provider, id) => ran.push(`model ${provider}/${id}`),
    resumeSession: (id) => ran.push(`resume ${id}`),
    onCancel: () => ran.push('cancel'),
    models: async () => [
      {
        provider: 'faux',
        id: 'small',
        current: true,
        contextWindow: 200_000,
        reasoning: true,
      },
      { provider: 'faux', id: 'large', current: false, contextWindow: 1e6 },
    ],
    sessions: async () => [
      {
        id: 'sess-older',
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      },
    ],
  };
  const open = (): Shown | undefined => shown.find((entry) => !entry.hidden);
  const frame = (): string => {
    const entry = open();
    if (entry === undefined) return '';
    const width = entry.options?.width;
    return entry.component
      .render(typeof width === 'number' ? width : 80)
      .join('\n');
  };
  const type = (text: string): void => {
    for (const ch of text) app.handleInput(ch);
  };
  return { app, surface, host, shown, ran, sources, open, frame, type };
}

// Lets the async model and session rows (and the deferred file rows) land.
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 5));

describe('the ^P palette (issue #460)', () => {
  it('Ctrl-P asks the loop for the palette', () => {
    const { app } = setup();
    expect(app.handleInput('\x10')).toMatchObject({ palette: true });
  });

  it('opens over the screen with the commands and the current model', async () => {
    const { app, sources, open, frame } = setup();
    expect(app.openPalette(sources)).toBe(true);
    expect(app.isPaletteOpen()).toBe(true);
    // 80 cells on a 120-column terminal, 70% of the rows at most.
    expect(open()?.options).toMatchObject({ width: 80, maxHeight: '70%' });
    expect(frame()).toContain('┌─ ^P ─');
    expect(frame()).toContain('COMMANDS');
    expect(frame()).toContain('/help');
    await settle();
    expect(frame()).toContain('● faux/small  current');
    expect(frame()).toContain('200k  yes');
    expect(frame()).not.toContain('faux/large');
  });

  it('types into the query and runs a command as if typed', async () => {
    const { app, sources, frame, type, ran } = setup();
    app.openPalette(sources);
    type('undo');
    expect(frame()).toContain('› undo');
    app.handleInput('\r');
    expect(ran).toEqual(['run /undo']);
    expect(app.isPaletteOpen()).toBe(false);
  });

  it('leaves a command that needs its argument in the editor', () => {
    const { app, sources, type, ran } = setup();
    app.openPalette(sources);
    type('inspect');
    app.handleInput('\r');
    expect(ran).toEqual([]);
    expect(app.editor.getText()).toBe('/inspect ');
  });

  it('switches the model and resumes a session through the loop', async () => {
    const { app, sources, frame, type, ran } = setup();
    app.openPalette(sources);
    await settle();
    type('large');
    expect(frame()).toContain('MODELS');
    app.handleInput('\r');
    app.openPalette(sources);
    await settle();
    type('older');
    expect(frame()).toContain('SESSIONS');
    expect(frame()).toContain('2m ago');
    app.handleInput('\r');
    expect(ran).toEqual(['model faux/large', 'resume sess-older']);
  });

  it('inserts a file as an @ mention', async () => {
    const { app, sources, frame, type } = setup(() => [
      'src/cart.js',
      'README.md',
    ]);
    app.editor.setText('look at ');
    app.openPalette(sources);
    await settle();
    type('cart');
    expect(frame()).toContain('FILES');
    expect(frame()).toContain('@ insert');
    app.handleInput('\r');
    expect(app.editor.getText()).toBe('look at @src/cart.js ');
  });

  it('Esc closes it and the loop hears the cancel', () => {
    const { app, sources, ran } = setup();
    app.openPalette(sources);
    app.handleInput('\x1b');
    expect(app.isPaletteOpen()).toBe(false);
    expect(ran).toEqual(['cancel']);
  });

  it('a stray global key never acts behind it', () => {
    const { app, sources } = setup();
    app.openPalette(sources);
    // Ctrl-O would open the diff panel; here it is the palette's (ignored).
    expect(app.handleInput('\x0f')).toMatchObject({ consumed: true });
    expect(app.isPaletteOpen()).toBe(true);
  });

  it('names its own keys and dims the screen behind it', () => {
    const { app, host, sources } = setup();
    const lit = createUiTheme(DARK_PALETTE, 'truecolor');
    const base = [lit.fg('fg0')('header'), lit.fg('fg1')('hints')];
    expect(host.baseFilter?.(base)).toEqual(base);
    app.openPalette(sources);
    const rows = app.render(100);
    expect(rows.at(-1)).toContain('tab next group');
    expect(rows.at(-1)).toContain('esc close');
    // Dimmed: colours gone (depth none here) — the hint row kept as it was.
    expect(host.baseFilter?.(base)).toEqual(['header', base[1]]);
    app.handleInput('\x1b');
    expect(host.baseFilter?.(base)).toEqual(base);
  });

  it('offers the commands this session ran first', () => {
    const { app, sources, frame } = setup();
    app.onSubmit(() => 'command');
    app.editor.setText('/session');
    app.handleInput('\r');
    app.openPalette(sources);
    const rows = frame().split('\n');
    const commands = rows.findIndex((row) => row.includes('COMMANDS'));
    expect(rows[commands + 1]).toContain('/session');
  });

  it('closes when an approval needs the keys', async () => {
    const { app, sources, ran } = setup();
    app.openPalette(sources);
    const pending = app.requestApproval({
      key: 'k',
      capability: 'network',
      toolName: 'bash',
      command: 'curl https://example.com',
    });
    expect(app.isPaletteOpen()).toBe(false);
    expect(ran).toEqual(['cancel']);
    app.handleInput('\x1b');
    await pending;
  });

  it('refuses a terminal too narrow for it', () => {
    const { app, host, sources } = setup();
    (host.terminal as { columns: number }).columns = 50;
    expect(app.openPalette(sources)).toBe(false);
  });
});
