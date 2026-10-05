// The `[ui] theme` boot path (issue #304; §16.9 "Themes are JSON with a
// schema"): a built-in name, a JSON theme file, and the named refusal for a
// file that is missing or invalid — before the alt-screen opens.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createNodeFileBridge } from '../../../packages/exec/src/file-bridge.js';
import {
  createTuiTheme,
  ThemeError,
  tuiTheme,
} from '../../../packages/tui/src/theme.js';
import type { Terminal } from '../../../packages/tui/src/tui-boundary.js';
import {
  createModels,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import {
  bootTuiLane,
  resolveTuiTheme,
  runTuiCommand,
  THEME_MAX_BYTES,
  type TuiRunDeps,
} from './tui-run.js';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

// A terminal that records every frame it is handed.
function recordingTerminal(): {
  writes: string[];
  feed: (data: string) => void;
  terminal: Terminal;
} {
  const writes: string[] = [];
  let handler: ((data: string) => void) | undefined;
  return {
    writes,
    feed: (data: string) => handler?.(data),
    terminal: {
      start: (input: (data: string) => void) => {
        handler = input;
      },
      stop: () => {},
      drainInput: () => Promise.resolve(),
      write: (data: string) => writes.push(data),
      get columns(): number {
        return 120;
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
    } satisfies Terminal,
  };
}

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-tui-theme-'));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const VALID_THEME = JSON.stringify({
  name: 'solarized',
  colors: {
    accent: '#268bd2',
    warm: '#b58900',
    success: '#859900',
    error: '#dc322f',
    warning: '#cb4b16',
    muted: '#93a1a1',
    prompt: '#fdf6e3',
  },
});

function bridgeFor(root: string) {
  return createNodeFileBridge(root);
}

describe('resolveTuiTheme (issue #304)', () => {
  it('defaults to the shipped brand palette', () => {
    const files = bridgeFor(tmpRoot());
    expect(resolveTuiTheme(undefined, 'truecolor', files).accent('x')).toBe(
      createTuiTheme('truecolor').accent('x'),
    );
    expect(resolveTuiTheme('dark', 'truecolor', files).accent('x')).toBe(
      createTuiTheme('truecolor').accent('x'),
    );
  });

  it('selects the built-in light palette by name', () => {
    const light = resolveTuiTheme('light', 'truecolor', bridgeFor(tmpRoot()));
    expect(light.accent('x')).toBe('\u001b[38;2;196;0;56mx\u001b[39m');
  });

  it('reads and validates a JSON theme file', () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'solarized.json'), VALID_THEME);
    const theme = resolveTuiTheme(
      'solarized.json',
      'truecolor',
      bridgeFor(root),
    );
    expect(theme.accent('x')).toBe('\u001b[38;2;38;139;210mx\u001b[39m');
    // The level still applies to a custom theme.
    expect(
      resolveTuiTheme('solarized.json', '256', bridgeFor(root)).accent('x'),
    ).toContain('38;5;');
    expect(
      resolveTuiTheme('solarized.json', 'none', bridgeFor(root)).accent('x'),
    ).toBe('x');
  });

  it('names a missing theme file', () => {
    const files = bridgeFor(tmpRoot());
    expect(() => resolveTuiTheme('nope.json', 'truecolor', files)).toThrow(
      ThemeError,
    );
    expect(() => resolveTuiTheme('nope.json', 'truecolor', files)).toThrow(
      /theme 'nope\.json': cannot read/,
    );
  });

  // Issue #304 review: `readTextFile` is an unbounded `readFileSync`, so a
  // config `[ui] theme` naming a FIFO would wedge the process before the
  // alt-screen opens and `/dev/zero` would read forever. The regular-file
  // check must come first, and a huge file is refused unread.
  it('refuses a non-regular file without reading it', () => {
    const files = {
      absolutePath: (path: string) => path,
      fileInfo: () => ({
        name: 'fifo',
        path: '/tmp/fifo',
        isDirectory: false,
        isSymbolicLink: false,
        isFile: false,
        size: 0,
        mtimeMs: 0,
      }),
      readTextFile: () => {
        throw new Error('a FIFO must never be read');
      },
    } as unknown as Parameters<typeof resolveTuiTheme>[2];
    expect(() => resolveTuiTheme('/tmp/fifo', 'truecolor', files)).toThrow(
      "theme '/tmp/fifo': not a regular file",
    );
  });

  it('refuses a theme file over the size cap without reading it', () => {
    const files = {
      absolutePath: (path: string) => path,
      fileInfo: () => ({
        name: 'huge.json',
        path: '/tmp/huge.json',
        isDirectory: false,
        isSymbolicLink: false,
        isFile: true,
        size: THEME_MAX_BYTES + 1,
        mtimeMs: 0,
      }),
      readTextFile: () => {
        throw new Error('an oversize theme must never be read');
      },
    } as unknown as Parameters<typeof resolveTuiTheme>[2];
    expect(() => resolveTuiTheme('/tmp/huge.json', 'truecolor', files)).toThrow(
      "theme '/tmp/huge.json': too large (> 64 KB)",
    );
  });

  it('names an invalid theme file', () => {
    const root = tmpRoot();
    writeFileSync(
      join(root, 'broken.json'),
      '{ "colors": { "accent": "red" } }',
    );
    expect(() =>
      resolveTuiTheme('broken.json', 'truecolor', bridgeFor(root)),
    ).toThrow(/theme 'broken\.json': 'accent' must be a #rrggbb colour/);
  });
});

describe('kubic tui rejects a bad theme at boot (issue #304)', () => {
  it('prints one named error and exits 2 before the screen opens', async () => {
    const root = tmpRoot();
    const errors: string[] = [];
    let created = 0;
    const deps: TuiRunDeps = {
      out: () => {},
      err: (line) => errors.push(line),
      createTerminal: () => {
        created += 1;
        throw new Error('the screen must not open for a bad theme');
      },
      bootLane: async () => {
        throw new Error('the lane must not boot for a bad theme');
      },
      colorLevel: 'none',
      theme: join(root, 'missing.json'),
    };
    const exit = await runTuiCommand({}, deps);
    expect(exit).toBe(2);
    expect(created).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^error: theme '.*missing\.json': cannot read \(/,
    );
    expect(errors[0]).toContain('ENOENT');
  });

  it('renders the configured theme on the first frame', async () => {
    const root = tmpRoot();
    const themePath = join(root, 'solarized.json');
    writeFileSync(themePath, VALID_THEME);
    const fake = recordingTerminal();
    const faux = fauxProvider({ models: [{ id: 'solo', input: ['text'] }] });
    const registry = createModels();
    registry.setProvider(faux.provider);
    const exit = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'truecolor',
        // The boot reads the path through the exec bridge rooted at the
        // process cwd, so the test names the file absolutely.
        theme: themePath,
        bootLane: async (sessionId) =>
          await bootTuiLane(sessionId, {
            sessionsRoot: root,
            models: registry,
            env: new FakeExecutionEnv({}),
            model: { provider: 'faux', id: 'solo' },
          }),
      },
    );
    await waitFor(() => fake.writes.join('').includes('38;2;38;139;210'));
    // The global the views read is the configured theme while the run is up.
    expect(tuiTheme().accent('x')).toBe('\u001b[38;2;38;139;210mx\u001b[39m');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });
});
