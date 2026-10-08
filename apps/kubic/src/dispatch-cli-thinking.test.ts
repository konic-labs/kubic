// The `--thinking` flag as an input to the ONE config load.
// Dispatch loads the config before commander parses, so the session
// override has to be read from the raw argv exactly once and handed to
// `loadConfig` — the commands' own commander definitions then re-parse the
// same token for help/validation, never as a second application point.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DispatchRunners } from './cli/context.js';
import { type CliConfigResult, loadCliConfig } from './config-runtime.js';
import {
  cliThinkingFromArgs,
  type DispatchDeps,
  dispatchCommand,
} from './dispatch.js';

const fixture = mkdtempSync(join(tmpdir(), 'kubic-225-dispatch-'));
afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('cliThinkingFromArgs', () => {
  it('reads both spellings for the commands that own the flag', () => {
    expect(cliThinkingFromArgs('run', ['--thinking', 'high', '-p', 'hi'])).toBe(
      'high',
    );
    expect(cliThinkingFromArgs('tui', ['--thinking=low'])).toBe('low');
    expect(cliThinkingFromArgs('config', ['--thinking', 'medium'])).toBe(
      'medium',
    );
  });

  it('ignores commands that do not own the flag', () => {
    expect(
      cliThinkingFromArgs('doctor', ['--thinking', 'high']),
    ).toBeUndefined();
    expect(
      cliThinkingFromArgs(undefined, ['--thinking', 'high']),
    ).toBeUndefined();
  });

  it('ignores unknown levels: commander reports those (exit 2)', () => {
    expect(
      cliThinkingFromArgs('run', ['--thinking', 'banana']),
    ).toBeUndefined();
    expect(cliThinkingFromArgs('run', ['--thinking'])).toBeUndefined();
    expect(cliThinkingFromArgs('run', ['--thinking='])).toBeUndefined();
  });

  it('ignores tokens after the -- terminator', () => {
    expect(
      cliThinkingFromArgs('run', ['-p', 'hi', '--', '--thinking', 'high']),
    ).toBeUndefined();
  });

  it('takes the last occurrence, matching commander', () => {
    expect(
      cliThinkingFromArgs('run', ['--thinking', 'low', '--thinking', 'high']),
    ).toBe('high');
  });
});

describe('the --thinking flag feeds the one config load', () => {
  it('kubic config --thinking shows the cli layer', async () => {
    const seen: string[] = [];
    const deps: DispatchDeps = {
      out: (line) => seen.push(line),
      loadConfig: (input) =>
        loadCliConfig({
          cwd: fixture,
          home: fixture,
          env: {},
          ...(input?.thinking === undefined
            ? {}
            : { thinking: input.thinking }),
        }),
      version: () => '9.9.9',
      ensureRuntimeExclude: () => {},
      runners: {
        config: (_options: unknown, cliConfig: CliConfigResult) => {
          seen.push(`thinking=${cliConfig.runtime?.thinking?.level ?? 'none'}`);
          return { exitCode: 0 };
        },
      } as unknown as DispatchRunners,
    };
    const exit = await dispatchCommand('config', ['--thinking', 'high'], deps);
    expect(exit).toBe(0);
    expect(seen).toContain('thinking=high');
  });

  // The fail-closed env path ends here, not in the loader
  // unit test — a banana `KUBIC_MODEL_THINKING` stops `kubic run` (exit 1)
  // with the variable named, before any runner is reached.
  it('a banana KUBIC_MODEL_THINKING fails kubic run naming the variable', async () => {
    const errs: string[] = [];
    const deps: DispatchDeps = {
      out: () => {},
      err: (line) => errs.push(line),
      loadConfig: () =>
        loadCliConfig({
          cwd: fixture,
          home: fixture,
          env: { KUBIC_MODEL_THINKING: 'banana' },
        }),
      version: () => '9.9.9',
      ensureRuntimeExclude: () => {},
      runners: {} as unknown as DispatchRunners,
    };
    const exit = await dispatchCommand('run', ['-p', 'hi'], deps);
    expect(exit).toBe(1);
    expect(errs.join('\n')).toMatch(/KUBIC_MODEL_THINKING/);
  });
});
