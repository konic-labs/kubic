// `kubic tui` seeds the status bar's thinking indicator from the lane's
// committed level (issue #225, review cycle 2; §38.3). Before the fix the
// bar rendered the seed default (`off`) until the first turn's refresh, so
// a session booted at `high` disagreed with its own lane on the first
// frame. Faux provider only: zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import { terminalRig } from '../../../test/fake-terminal.js';
import { bootTuiLane, runTuiCommand, type TuiLaneBoot } from './tui-run.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-tui-thinking-'));
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

// A reasoning model: only a model that supports levels above `off` can show
// the seed matters (a clamp to `off` would equal the old default).
function reasoningModels(): ReturnType<typeof createModels> {
  const faux = fauxProvider({ models: [{ id: 'deep', reasoning: true }] });
  faux.setResponses([fauxAssistantMessage('ok')]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

function bootOptions(root: string) {
  return {
    sessionsRoot: root,
    models: reasoningModels(),
    model: { provider: 'faux', id: 'deep' },
    thinking: { level: 'high', source: 'cli' as const },
    env: new FakeExecutionEnv({}),
  };
}

function recordingTerminal() {
  return terminalRig(140, 30);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

describe('kubic tui seeds the thinking indicator from the boot (issue #225)', () => {
  it('exposes the committed level on the boot', async () => {
    const root = tmpRoot();
    const boot = await bootTuiLane(undefined, bootOptions(root));
    try {
      // The lane resolved the cli request against the reasoning model and
      // committed it; the boot carries exactly that level.
      expect(boot.model).toBe('faux/deep');
      expect(boot.thinking).toBe('high');
    } finally {
      await boot.close?.();
    }
  });

  it('shows the booted level on the first frame', async () => {
    const root = tmpRoot();
    const first = await bootTuiLane(undefined, bootOptions(root));
    // Release the session lock: the headless drive below attaches as the
    // second process, exactly like a reattached `kubic tui --session`.
    const id = first.sessionId;
    await first.close?.();
    const fake = recordingTerminal();
    const boots: TuiLaneBoot[] = [];
    const exit = runTuiCommand(
      { session: id },
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: async (sessionId) => {
          const boot = await bootTuiLane(sessionId, bootOptions(root));
          boots.push(boot);
          return boot;
        },
      },
    );
    await waitFor(() => fake.counts.started === 1);
    // The FIRST frame already carries the booted level — before the fix it
    // read `off` here until a turn refreshed it.
    expect(boots).toHaveLength(1);
    expect(boots[0]?.thinking).toBe('high');
    expect(fake.writes.join('')).toContain('faux/deep · high');
    fake.feed('\x03');
    fake.feed('\x03');
    expect(await exit).toBe(0);
  });
});
