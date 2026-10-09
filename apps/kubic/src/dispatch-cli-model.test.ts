// The `--model` flag as an input to the ONE config load.
// Dispatch loads the config before commander parses, so the session
// override has to be read from the raw argv exactly once and handed to
// `loadConfig` — the commands' own commander definitions then re-parse the
// same token for help/validation, never as a second application point.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigCommandOptions } from '@kubic/host/config';
import { afterAll, describe, expect, it } from 'vitest';
import type { DispatchRunners } from './cli/context.js';
import {
  type CliConfigResult,
  loadCliConfig,
  runtimeModelPin,
} from './config-runtime.js';
import {
  cliModelFromArgs,
  type DispatchDeps,
  dispatchCommand,
} from './dispatch.js';

const fixture = mkdtempSync(join(tmpdir(), 'kubic-dispatch-model-'));
afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('cliModelFromArgs', () => {
  it('reads both spellings for the commands that own the flag', () => {
    expect(
      cliModelFromArgs('run', ['--model', 'faux/small', '-p', 'hi']),
    ).toEqual({ provider: 'faux', id: 'small' });
    expect(cliModelFromArgs('tui', ['--model=faux/big'])).toEqual({
      provider: 'faux',
      id: 'big',
    });
    expect(cliModelFromArgs('config', ['--model', 'faux/x'])).toEqual({
      provider: 'faux',
      id: 'x',
    });
  });

  it('ignores commands that do not own the flag', () => {
    expect(cliModelFromArgs('doctor', ['--model', 'faux/x'])).toBeUndefined();
    expect(cliModelFromArgs(undefined, ['--model', 'faux/x'])).toBeUndefined();
  });

  it('ignores malformed values: commander reports those (exit 2)', () => {
    expect(cliModelFromArgs('run', ['--model', 'nope'])).toBeUndefined();
    expect(cliModelFromArgs('run', ['--model'])).toBeUndefined();
    expect(cliModelFromArgs('run', ['--model='])).toBeUndefined();
  });

  it('ignores tokens after the -- terminator', () => {
    expect(
      cliModelFromArgs('run', ['-p', 'hi', '--', '--model', 'faux/x']),
    ).toBeUndefined();
  });

  it('takes the last occurrence, matching commander', () => {
    expect(
      cliModelFromArgs('run', ['--model', 'faux/a', '--model', 'faux/b']),
    ).toEqual({ provider: 'faux', id: 'b' });
  });
});

describe('the --model flag feeds the one config load', () => {
  it('kubic config --model shows the cli layer', async () => {
    let seen: string | undefined;
    const deps: DispatchDeps = {
      out: () => {},
      loadConfig: (input) =>
        loadCliConfig({
          cwd: fixture,
          home: fixture,
          env: {},
          ...(input?.model === undefined ? {} : { model: input.model }),
        }),
      version: () => '9.9.9',
      ensureRuntimeExclude: () => {},
      runners: {
        config: (_options: ConfigCommandOptions, config: CliConfigResult) => {
          const pin = runtimeModelPin(config);
          seen = pin === undefined ? undefined : `${pin.provider}/${pin.id}`;
          return { exitCode: 0 };
        },
      } as unknown as DispatchRunners,
    };
    const code = await dispatchCommand(
      'config',
      ['--model', 'faux/small'],
      deps,
    );
    expect(code).toBe(0);
    expect(seen).toBe('faux/small');
  });
});

// On a terminal the bare `kubic --model p/id` IS `kubic tui --model
// p/id`. The pre-scan must read the SAME argv the runner receives — for the bare
// form the flag is the requested "command" token, not part of `rest` — or the
// interactive session boots the default model with no error and no note (the
// TUI does not patch the flag over the loaded config).
describe('the bare `kubic --model` form feeds the one config load', () => {
  async function bareLoad(
    requested: string,
    rest: string[],
    interactive: boolean,
  ): Promise<string | undefined> {
    let seen: string | undefined;
    const deps: DispatchDeps = {
      out: () => {},
      err: () => {},
      loadConfig: (input) =>
        loadCliConfig({
          cwd: fixture,
          home: fixture,
          env: {},
          ...(input?.model === undefined ? {} : { model: input.model }),
        }),
      version: () => '9.9.9',
      ensureRuntimeExclude: () => {},
      isInteractive: () => interactive,
      runners: {
        tui: (_options: unknown, config: CliConfigResult) => {
          const pin = runtimeModelPin(config);
          seen = pin === undefined ? undefined : `${pin.provider}/${pin.id}`;
          return { exitCode: 0 };
        },
      } as unknown as DispatchRunners,
    };
    await dispatchCommand(requested, rest, deps);
    return seen;
  }

  it('`kubic --model faux/small` on a terminal reaches the config load', async () => {
    expect(await bareLoad('--model', ['faux/small'], true)).toBe('faux/small');
  });

  it('`kubic --model=faux/big` on a terminal reaches the config load', async () => {
    expect(await bareLoad('--model=faux/big', [], true)).toBe('faux/big');
  });

  it('the explicit `kubic tui --model` control agrees', async () => {
    expect(await bareLoad('tui', ['--model', 'faux/small'], true)).toBe(
      'faux/small',
    );
  });
});
