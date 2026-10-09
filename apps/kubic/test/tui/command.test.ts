// `kubic tui` wiring over the lane.
//
// Headless snapshots through the real TuiAltScreen + a fake Terminal
// (same pattern as screen.test.ts): alt-screen open/restore asserted on
// captured writes. Faux lane boot only — zero network.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tuiTheme } from '@kubic/tui/theme';
import type { Terminal } from '@kubic/tui/tui-boundary';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeTerminal as sharedFakeTerminal } from '../../../../test/fake-terminal.js';
import { bootTuiLane } from '../../src/tui/boot.js';
import type { TuiRunDeps } from '../../src/tui/options.js';
import { runTuiCommand } from '../../src/tui/run.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeTerminal(
  width: number,
  onStart?: (input: (data: string) => void) => void,
): Terminal & {
  writes: string[];
  started: number;
  stopped: number;
} {
  return sharedFakeTerminal(width, 30, { onStart });
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

function deps(
  terminal: Terminal,
  overrides: Partial<TuiRunDeps> = {},
): TuiRunDeps {
  return {
    out: () => {},
    createTerminal: () => terminal,
    colorLevel: 'none',
    bootLane: async (sessionId?: string) => ({
      sessionId: sessionId ?? 's1',
      model: 'faux/test',
    }),
    ...overrides,
  };
}

describe('kubic tui', () => {
  it('opens the alt-screen, shows rows in root order, restores on Ctrl-C', async () => {
    const lines: string[] = [];
    let input!: (data: string) => void;
    const terminal = fakeTerminal(100, (cb) => {
      input = cb;
    });
    const pending = runTuiCommand(
      {},
      deps(terminal, { out: (l) => lines.push(l) }),
    );
    await waitFor(() => terminal.started === 1);
    input('T');
    // With the draft on screen the first Ctrl-C clears it;
    // the double press after it quits.
    input('\x03');
    input('\x03');
    input('\x03');
    const code = (await pending).exitCode;
    expect(code).toBe(0);
    const frames = terminal.writes.join('');
    // Alt-screen entered, at least one atomic frame drawn, then restored.
    const enter = frames.indexOf('?1049h');
    expect(enter).toBeGreaterThanOrEqual(0);
    expect(frames.indexOf('?2026h', enter)).toBeGreaterThan(enter);
    expect(frames.lastIndexOf('?1049l')).toBeGreaterThan(
      frames.lastIndexOf('?2026h'),
    );
    expect(terminal.stopped).toBe(1);
    const doc = lines.join('\n');
    // Header, transcript, status line, key hints.
    const order = ['approvals on', 'PREFLIGHT', ' ready ', '⏎ send'].map((m) =>
      doc.indexOf(m),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('passes --session through to the lane boot', async () => {
    const seen: Array<string | undefined> = [];
    let input!: (data: string) => void;
    const terminal = fakeTerminal(100, (cb) => {
      input = cb;
    });
    const pending = runTuiCommand(
      { session: 'abc' },
      deps(terminal, {
        bootLane: async (sessionId?: string) => {
          seen.push(sessionId);
          return { sessionId: sessionId ?? 's1', model: 'faux/test' };
        },
      }),
    );
    await waitFor(() => terminal.started === 1);
    input('\x03');
    input('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(seen).toEqual(['abc']);
  });

  it('keeps the chrome on narrow terminals with the tree hidden', async () => {
    const lines: string[] = [];
    let input!: (data: string) => void;
    const terminal = fakeTerminal(70, (cb) => {
      input = cb;
    });
    const pending = runTuiCommand(
      {},
      deps(terminal, { out: (l) => lines.push(l) }),
    );
    await waitFor(() => terminal.started === 1);
    input('\x03');
    input('\x03');
    expect((await pending).exitCode).toBe(0);
    const doc = lines.join('\n');
    expect(doc).not.toMatch(/[✓●◌] default/);
    expect(doc).toContain('approvals on');
    expect(doc).toContain(' ready ');
  });

  it('rejects path-unsafe --session ids before the lane boots', async () => {
    let booted = 0;
    const terminal = fakeTerminal(100);
    const code = (
      await runTuiCommand(
        { session: '../evil' },
        deps(terminal, {
          bootLane: async (sessionId?: string) => {
            booted++;
            return { sessionId: sessionId ?? 's1', model: 'faux/test' };
          },
        }),
      )
    ).exitCode;
    expect(code).toBe(2);
    expect(booted).toBe(0);
    expect(terminal.started).toBe(0);
  });

  it('rejects path-unsafe ids inside bootTuiLane too (direct callers)', async () => {
    await expect(bootTuiLane('../evil')).rejects.toThrow('invalid --session');
  });

  it('reports lane boot failure without opening the screen', async () => {
    const lines: string[] = [];
    const terminal = fakeTerminal(100);
    const code = (
      await runTuiCommand(
        {},
        deps(terminal, {
          out: (l) => lines.push(l),
          bootLane: async () => {
            throw new Error('nope');
          },
        }),
      )
    ).exitCode;
    expect(code).toBe(1);
    expect(terminal.started).toBe(0);
    expect(lines.join('\n')).toContain('error: nope');
  });

  it('puts the boot and session-id errors on stderr when given one', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const channels = {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
    };
    const boom = (
      await runTuiCommand(
        {},
        deps(fakeTerminal(100), {
          ...channels,
          bootLane: async () => {
            throw new Error('unknown session: nope');
          },
        }),
      )
    ).exitCode;
    expect(boom).toBe(1);
    const bad = (
      await runTuiCommand(
        { session: '../evil' },
        deps(fakeTerminal(100), channels),
      )
    ).exitCode;
    expect(bad).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual([
      'error: unknown session: nope',
      'error: invalid --session id "../evil" (use [A-Za-z0-9_-])',
    ]);
  });

  it('restores the screen and closes the lane when setup throws after start', async () => {
    let closed = 0;
    const terminal = fakeTerminal(100);
    terminal.hideCursor = () => {
      throw new Error('setup boom');
    };
    await expect(
      runTuiCommand(
        {},
        deps(terminal, {
          bootLane: async (sessionId?: string) => ({
            sessionId: sessionId ?? 's1',
            model: 'faux/test',
            close: () => {
              closed += 1;
            },
          }),
        }),
      ),
    ).rejects.toThrow('setup boom');
    expect(terminal.started).toBe(1);
    expect(terminal.stopped).toBe(1);
    expect(closed).toBe(1);
  });
});

// The suite must not depend on the shell's colour variables, and
// a run must not leave its colour theme behind for the next test.
describe('kubic tui colour isolation', () => {
  it('passes under FORCE_COLOR=3 with the injected colour level', async () => {
    vi.stubEnv('FORCE_COLOR', '3');
    const lines: string[] = [];
    let input!: (data: string) => void;
    const terminal = fakeTerminal(100, (cb) => {
      input = cb;
    });
    const pending = runTuiCommand(
      {},
      deps(terminal, { out: (l) => lines.push(l) }),
    );
    await waitFor(() => terminal.started === 1);
    input('\x03');
    input('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(lines.join('\n')).toContain('approvals on');
    // No Konic palette colour reached the document (truecolor SGR 38;2).
    expect(lines.join('\n')).not.toContain('38;2;');
  });

  it('restores the previous theme when the run ends', async () => {
    let input!: (data: string) => void;
    const terminal = fakeTerminal(100, (cb) => {
      input = cb;
    });
    const pending = runTuiCommand(
      {},
      deps(terminal, { colorLevel: 'truecolor' }),
    );
    await waitFor(() => terminal.started === 1);
    expect(tuiTheme().level).toBe('truecolor');
    input('\x03');
    input('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(tuiTheme().level).toBe('none');
  });
});

// ~/.kubic/keybindings.json is read at boot. Conflicting
// overrides are reported before the screen opens (and the TUI still runs);
// a broken file refuses the boot by name.
describe('kubic tui keybindings file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
  const keybindingsFile = (json: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'kubic-tui-command-'));
    dirs.push(dir);
    const file = join(dir, 'keybindings.json');
    writeFileSync(file, json);
    return file;
  };

  it('reports conflicting overrides at boot and still opens the TUI', async () => {
    const errors: string[] = [];
    let input!: (data: string) => void;
    const terminal = fakeTerminal(100, (cb) => {
      input = cb;
    });
    const pending = runTuiCommand(
      {},
      deps(terminal, {
        err: (line) => errors.push(line),
        keybindingsFile: keybindingsFile(
          '{"panel.diff": "ctrl+y", "panel.journal": "ctrl+y"}',
        ),
      }),
    );
    await waitFor(() => terminal.started === 1);
    input('\x03');
    input('\x03');
    expect((await pending).exitCode).toBe(0);
    expect(errors).toContain(
      'warning: keybinding conflict: ctrl+y is bound to both panel.diff and panel.journal — panel.diff keeps it',
    );
  });

  it('refuses a keybindings file with an unknown action (exit 2, nothing opens)', async () => {
    const errors: string[] = [];
    const terminal = fakeTerminal(100);
    const code = (
      await runTuiCommand(
        {},
        deps(terminal, {
          err: (line) => errors.push(line),
          keybindingsFile: keybindingsFile('{"panel.dif": "ctrl+g"}'),
        }),
      )
    ).exitCode;
    expect(code).toBe(2);
    expect(terminal.started).toBe(0);
    expect(errors.join('\n')).toMatch(
      /error: keybindings '.*': unknown action 'panel\.dif'/,
    );
  });
});
