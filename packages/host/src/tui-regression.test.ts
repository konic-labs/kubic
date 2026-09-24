// `kubic tui` host-side regression (issue #75).
// The tui entry lives in apps/kubic (the composition root: the only
// owner allowed to wire host + tui together), so the cross-cutting
// proof lives here next to run-prod-path.test.ts. This file never
// imports @kubic/tui (dep-lint): the fake terminal satisfies the seam
// structurally. Faux lane boot only — zero network.
import { describe, expect, it } from 'vitest';
import { runTuiCommand } from '../../../apps/kubic/src/tui-run.js';
import { runRunCommand } from './run-cli.js';

function fakeTerminal(width: number) {
  const writes: string[] = [];
  const counts = { started: 0, stopped: 0 };
  let onInput: ((data: string) => void) | undefined;
  return {
    writes,
    terminal: {
      start: (input: (data: string) => void) => {
        counts.started += 1;
        onInput = input;
      },
      stop: () => {
        counts.stopped += 1;
      },
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return width;
      },
      get rows(): number {
        return 30;
      },
      get kittyProtocolActive(): boolean {
        return false;
      },
      moveBy: () => {},
      hideCursor: () => {},
      showCursor: () => {},
      clearLine: () => {},
      clearFromCursor: () => {},
      clearScreen: () => {},
      setTitle: () => {},
      setProgress: () => {},
    },
    counts,
    feed: (data: string): void => {
      onInput?.(data);
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

describe('tui entry regression (issue #75)', () => {
  it('routes input and restores the main screen on quit', async () => {
    const lines: string[] = [];
    const fake = fakeTerminal(100);
    const pending = runTuiCommand([], {
      out: (line: string) => lines.push(line),
      createTerminal: () => fake.terminal,
      bootLane: async (sessionId?: string) => ({
        sessionId: sessionId ?? 's1',
        model: 'faux/test',
      }),
    });
    await waitFor(() => fake.counts.started === 1);
    fake.feed('\x03');
    expect(await pending).toBe(0);
    expect(fake.counts.stopped).toBe(1);
    expect(fake.writes.join('')).toContain('?1049l');
    expect(lines.join('\n')).toContain('session s1');
  });

  it('headless `kubic run` mounts no screen beside the tui entry', async () => {
    const lines: string[] = [];
    const code = await runRunCommand(['-p', 'hi'], {
      out: (line: string) => lines.push(line),
      run: async () => ({
        terminus: 'completed' as const,
        summary: 'hi',
        sessionId: 's',
        journalRef: 'journal:s',
        usageRef: 'usage:s',
        trajectoryRef: 'trajectory:s',
      }),
      onScreenMount: () => {
        throw new Error('alt-screen mounted on the headless path');
      },
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('result: hi');
  });
});
