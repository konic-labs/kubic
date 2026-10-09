// `kubic tui --session` seeds the status bar from the session's committed
// `pi.usage` spend ("token usage, cache hits, and cost").
// The rows are seeded from the committed usage, so a resumed session that has
// already spent money shows the spend at once, not $0.00 until its next turn.
// Faux provider only: zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
  type Usage,
  UsageDoc,
} from '@kubic/agent/pi-boundary';
import {
  bootFauxLane,
  runPrompt,
} from '@kubic/agent/test-support/lane-harness';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalRig } from '../../../../test/fake-terminal.js';
import { bootTuiLane, statusRowsFromSessionUsage } from '../../src/tui/boot.js';
import { runTuiCommand } from '../../src/tui/run.js';
import type { TuiLaneBoot } from '../../src/tui/types.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-tui-usage-'));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_PROVIDER', undefined);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A faux answer that bills real tokens: the harness records the message's
// usage into the conversation's `pi.usage` document, the same ledger
// `kubic cost` reads.
function billed(
  text: string,
  input: number,
  output: number,
  total: number,
): ReturnType<typeof fauxAssistantMessage> {
  const message = fauxAssistantMessage(text);
  message.usage = usageOf(input, output, total);
  return message;
}

// The faux provider estimates usage itself and always bills cost 0, so the
// spend the bar must show is written into the session's ledger directly:
// two committed buckets, the shape `pi.usage` really holds.
function usageOf(input: number, output: number, total: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

// A real JSONL session with two committed, billed turns, released so the TUI
// can attach it as a second process.
async function billedSession(root: string): Promise<string> {
  const lane = await bootFauxLane({
    storage: 'jsonl',
    root,
    cwd: root,
    responses: [
      billed('first', 1000, 200, 0.02),
      billed('second', 1000, 200, 0.01),
    ],
  });
  try {
    await runPrompt(lane.lane, 'first prompt', { requestId: 'u1' });
    await runPrompt(lane.lane, 'second prompt', { requestId: 'u2' });
    // Two earlier responses, two billed buckets: 0.02 + 0.01 = 0.03.
    // `harness.root()` runs OUTSIDE the commit: calling it inside the
    // transaction deadlocks on the harness's own conversation handle.
    const conversation = await lane.lane.harness.root(BACKGROUND_CONTEXT);
    await lane.lane.harness.commit(async (tx) => {
      const usage = await tx.doc(UsageDoc, conversation.id);
      usage.models = {
        'faux/first': usageOf(1000, 200, 0.02),
        'faux/second': usageOf(1000, 200, 0.01),
      };
    }, BACKGROUND_CONTEXT);
    return lane.sessionId;
  } finally {
    await lane.cleanup();
  }
}

function fauxModels(
  responses: ReadonlyArray<ReturnType<typeof billed>> = [],
): MutableModels {
  const faux = fauxProvider();
  faux.setResponses([...responses]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
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

describe('kubic tui --session seeds the committed spend', () => {
  it('maps pi.usage buckets to status rows', () => {
    const rows = statusRowsFromSessionUsage([
      // A model id may itself contain slashes: split at the FIRST one.
      {
        key: 'openrouter/anthropic/claude',
        kind: 'model',
        usage: usageOf(1, 2, 0.01),
      },
      { key: 'bash', kind: 'tool', usage: usageOf(3, 4, 0.02) },
      { key: 'nomodel', kind: 'model', usage: usageOf(5, 6, 0.03) },
    ]);
    expect(rows.map((row) => `${row.provider}|${row.model}`)).toEqual([
      'openrouter|anthropic/claude',
      'tool|bash',
      '|nomodel',
    ]);
    expect(rows.map((row) => row.usage.cost.total)).toEqual([0.01, 0.02, 0.03]);
  });

  it('boots a resumed session with its pi.usage spend as status rows', async () => {
    const root = tmpRoot();
    const id = await billedSession(root);
    const boot = await bootTuiLane(id, {
      sessionsRoot: root,
      models: fauxModels(),
      env: new FakeExecutionEnv({}),
    });
    try {
      const rows = boot.usageRows ?? [];
      // One row per billed bucket: `provider/modelId` split at the first
      // slash, the two costs summed by the bar to $0.03.
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.model)).toEqual(['first', 'second']);
      expect(rows.map((row) => row.provider)).toEqual(['faux', 'faux']);
      expect(rows.map((row) => row.usage.input)).toEqual([1000, 1000]);
      expect(rows.map((row) => row.usage.output)).toEqual([200, 200]);
      expect(
        rows.reduce((sum, row) => sum + row.usage.cost.total, 0),
      ).toBeCloseTo(0.03);
    } finally {
      await boot.close?.();
    }
  });

  it('shows the seeded spend on the first frame and keeps it through a turn', async () => {
    const root = tmpRoot();
    const id = await billedSession(root);
    const fake = recordingTerminal();
    const boots: TuiLaneBoot[] = [];
    const exit = runTuiCommand(
      { session: id },
      {
        out: () => {},
        createTerminal: () => fake.terminal,
        colorLevel: 'none',
        bootLane: async (sessionId) => {
          const boot = await bootTuiLane(sessionId, {
            sessionsRoot: root,
            models: fauxModels([billed('live answer', 500, 100, 0.04)]),
            env: new FakeExecutionEnv({}),
          });
          boots.push(boot);
          return boot;
        },
      },
    );
    await waitFor(() => fake.counts.started === 1);
    // The FIRST frame already carries the resumed session's $0.03.
    expect(fake.writes.join('')).toContain('$0.03');
    // A live turn keeps the seeded spend: the faux provider bills $0, so an
    // unseeded runner would repaint the bar as $0.00 after the usage event.
    for (const ch of 'go') fake.feed(ch);
    fake.feed('\r');
    await waitFor(() => fake.writes.join('').includes('live answer'));
    expect(fake.writes.join('')).toContain('$0.03');
    fake.feed('\x03');
    fake.feed('\x03');
    expect((await exit).exitCode).toBe(0);
    expect(boots).toHaveLength(1);
  });

  it('a fresh session still starts from zero rows', async () => {
    const root = tmpRoot();
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: root,
      models: fauxModels(),
      env: new FakeExecutionEnv({}),
    });
    try {
      expect(boot.usageRows ?? []).toEqual([]);
    } finally {
      await boot.close?.();
    }
  });
});
