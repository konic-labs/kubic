// `kubic tui` wiring over the solo lane (issue #75).
//
// Headless snapshots through the real TuiAltScreen + a fake Terminal
// (same pattern as screen.test.ts): alt-screen open/restore asserted on
// captured writes. Faux lane boot only — zero network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootTuiLane,
  runTuiCommand,
  type TuiRunDeps,
} from '../../../apps/kubic/src/tui-run.js';
import { fakeTerminal as sharedFakeTerminal } from '../../../test/fake-terminal.js';
import { tuiTheme } from './theme.js';
import type { Terminal } from './tui-boundary.js';

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

describe('kubic tui (issue #75)', () => {
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
    // Issue #302: with the draft on screen the first Ctrl-C clears it and
    // the second one quits.
    input('\x03');
    input('\x03');
    const code = await pending;
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
    const order = [
      '◌ solo',
      'Kubic — terminal coding agent',
      'approvals:on',
    ].map((m) => doc.indexOf(m));
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
    expect(await pending).toBe(0);
    expect(seen).toEqual(['abc']);
  });

  it('hides the tree only on narrow terminals', async () => {
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
    expect(await pending).toBe(0);
    const doc = lines.join('\n');
    expect(doc).not.toMatch(/[✓●◌]/);
    expect(doc).toContain('session s1');
    expect(doc).toContain('approvals:on');
  });

  it('rejects path-unsafe --session ids before the lane boots', async () => {
    let booted = 0;
    const terminal = fakeTerminal(100);
    const code = await runTuiCommand(
      { session: '../evil' },
      deps(terminal, {
        bootLane: async (sessionId?: string) => {
          booted++;
          return { sessionId: sessionId ?? 's1', model: 'faux/test' };
        },
      }),
    );
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
    const code = await runTuiCommand(
      {},
      deps(terminal, {
        out: (l) => lines.push(l),
        bootLane: async () => {
          throw new Error('nope');
        },
      }),
    );
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
    const boom = await runTuiCommand(
      {},
      deps(fakeTerminal(100), {
        ...channels,
        bootLane: async () => {
          throw new Error('unknown session: nope');
        },
      }),
    );
    expect(boom).toBe(1);
    const bad = await runTuiCommand(
      { session: '../evil' },
      deps(fakeTerminal(100), channels),
    );
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

// Issue #319: the suite must not depend on the shell's colour variables, and
// a run must not leave its colour theme behind for the next test.
describe('kubic tui colour isolation (issue #319)', () => {
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
    expect(await pending).toBe(0);
    expect(lines.join('\n')).toContain('◌ solo');
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
    expect(await pending).toBe(0);
    expect(tuiTheme().level).toBe('none');
  });
});
