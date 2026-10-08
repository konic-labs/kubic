// The context gauge's production wiring: the boot hands
// the status bar the running model's context window and the compaction
// threshold derived from it, and a `/model` switch moves both. Faux
// provider only: zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
} from '../../../packages/agent/src/compaction.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from '../../../packages/agent/src/pi-boundary.js';
import { FakeExecutionEnv } from '../../../packages/exec/src/env.js';
import { createTuiApp } from '../../../packages/tui/src/tui-app.js';
import {
  bootTuiLane,
  contextLimitsOf,
  type TuiLaneLoop,
  TuiTurnRunner,
} from './tui-run.js';

const made: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-tui-context-'));
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

function fauxModels(): ReturnType<typeof createModels> {
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage('ok')]);
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

describe('context gauge wiring', () => {
  it('derives the window and the compaction threshold from the catalog', () => {
    const models = fauxModels();
    const limits = contextLimitsOf(models, 'faux', 'faux-1');
    expect(limits.contextWindow).toBe(128000);
    expect(limits.compactionThreshold).toBe(
      128000 - effectiveReserveTokens(128000, DEFAULT_RESERVE_TOKENS),
    );
    // An unknown model (or provider) yields no limits: no made-up gauge.
    expect(contextLimitsOf(models, 'faux', 'nope')).toEqual({});
    expect(contextLimitsOf(models, 'nope', 'nope')).toEqual({});
  });

  it('hands the running model limits to the boot', async () => {
    const root = tmpRoot();
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: root,
      models: fauxModels(),
      env: new FakeExecutionEnv({}),
    });
    try {
      expect(boot.contextLimits?.contextWindow).toBe(128000);
      expect(boot.contextLimits?.compactionThreshold).toBe(
        128000 - effectiveReserveTokens(128000, DEFAULT_RESERVE_TOKENS),
      );
    } finally {
      await boot.close?.();
    }
  });

  it('moves the gauge on a /model switch through the loop lookup', async () => {
    const app = createTuiApp({
      sessionId: 's1',
      model: 'a/small',
      approvalsSkipped: false,
      contextWindow: 1000,
      compactionThreshold: 500,
    });
    const loop = {
      context: undefined,
      switchModel: async (): Promise<string> => 'b/big',
      contextLimits: (): {
        contextWindow: number;
        compactionThreshold: number;
      } => ({
        contextWindow: 8000,
        compactionThreshold: 7000,
      }),
    } as unknown as TuiLaneLoop;
    const runner = new TuiTurnRunner(app, loop, 'a/small');
    expect(await runner.switchModel({ provider: 'b', id: 'big' })).toBe(
      'b/big',
    );
    expect(app.status.getState().contextWindow).toBe(8000);
    expect(app.status.getState().compactionThreshold).toBe(7000);
  });

  it('leaves the seeded limits alone when the loop has no lookup', async () => {
    const app = createTuiApp({
      sessionId: 's1',
      model: 'a/small',
      approvalsSkipped: false,
      contextWindow: 1000,
      compactionThreshold: 500,
    });
    const loop = {
      context: undefined,
      switchModel: async (): Promise<string> => 'b/big',
    } as unknown as TuiLaneLoop;
    const runner = new TuiTurnRunner(app, loop, 'a/small');
    await runner.switchModel({ provider: 'b', id: 'big' });
    expect(app.status.getState().contextWindow).toBe(1000);
  });
});
