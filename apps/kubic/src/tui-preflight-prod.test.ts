// The first screen on the real `kubic tui` path (issue #462; docs/ui 05):
// the preflight from the boot's facts, the recent sessions read after the
// screen opens, and the no-key block printed before exit 6.
import { describe, expect, it } from 'vitest';
import { RUN_EXIT_PROVIDER_PROBE_FAILED } from '../../../packages/host/src/run-cli.js';
import { NoModelAvailableError } from '../../../packages/worker/src/model-select.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { runTuiCommand } from './tui-run.js';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('the first screen on kubic tui (issue #462)', () => {
  it('opens on the preflight with the version, trust and recent sessions', async () => {
    const fake = terminalRig(140, 40);
    const pending = runTuiCommand(
      {},
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        version: '9.9.9',
        projectTrust: 'loaded',
        bootLane: async (sessionId?: string) => ({
          sessionId: sessionId ?? 's1',
          model: 'anthropic/sonnet',
          keySourceOf: (provider: string) =>
            provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined,
          summarizeSessions: async () => [
            {
              id: 'older',
              title: 'fix the cart',
              turns: 4,
              costUsd: 0.03,
              createdAt: new Date(Date.now() - 120_000).toISOString(),
              state: 'ready' as const,
            },
          ],
        }),
      },
    );
    await waitFor(() => fake.frame.includes('RECENT IN THIS PROJECT'));
    const frame = fake.frame;
    expect(frame).toContain('9.9.9 · terminal coding agent by Konic');
    expect(frame).toContain(
      'provider     anthropic/sonnet  key from ANTHROPIC_API_KEY',
    );
    expect(frame).toContain('trust        .kubic/config.toml loaded');
    expect(frame).toMatch(/2m ago {3}fix the cart +4 turns · \$0\.03/u);
    fake.feed('\x04');
    expect(await pending).toBe(0);
  });

  it('prints the no-key block and exits 6 without opening the screen', async () => {
    const errors: string[] = [];
    let created = 0;
    const exit = await runTuiCommand(
      {},
      {
        out: () => {},
        err: (line: string) => errors.push(line),
        createTerminal: () => {
          created += 1;
          return terminalRig().terminal;
        },
        colorLevel: 'none',
        readWorkspace: async () => ({
          project: 'proj',
          branch: 'main',
          dirty: 0,
        }),
        bootLane: async () => {
          throw new NoModelAvailableError('no models available');
        },
      },
    );
    expect(exit).toBe(RUN_EXIT_PROVIDER_PROBE_FAILED);
    expect(exit).toBe(6);
    expect(created).toBe(0);
    const text = errors.join('\n');
    expect(text).toContain('✕ provider     no model provider has a key');
    expect(text).toContain('export ANTHROPIC_API_KEY=…     anthropic');
    expect(text).toContain(
      'or try it without a model: KUBIC_PROVIDER=faux kubic',
    );
    expect(text).toMatch(/✓ project {6}~?\/?.*git main · clean/u);
    expect(text).toContain('exit 6 · provider_probe_failed');
    expect(text).not.toContain('error:');
  });
});
