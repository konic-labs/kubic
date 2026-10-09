// `kubic run --json` carries the run's real usage: the report must carry
// the numbers — the SAME ones `kubic cost` reads from the session — never
// zeros and never a bare ref.
//
// Faux provider only: the faux model's usage is deterministic, zero
// network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { loadSessionCostRows } from '@kubic/host/cost';
import { buildRunEnvelope } from '@kubic/host/run';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from './run/command.js';

const made: string[] = [];

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('run envelope usage', () => {
  it('reports the session usage rows, the tool calls and the model it ran', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kubic-run-envelope-sessions-'));
    made.push(root);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('ls', { path: '.' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('did X'),
    ]);
    const result = await runHeadlessPrompt(
      'look around',
      {},
      { sessionsRoot: root, models, env: new FakeExecutionEnv({}) },
    );
    expect(result.terminus).toBe('completed');
    const envelope = buildRunEnvelope(result, 0);
    const [rows] = await loadSessionCostRows(root, result.sessionId);
    expect(rows?.input).toBeGreaterThan(0);
    expect(envelope.usage).toMatchObject({
      ref: `usage:${result.sessionId}`,
      input: rows?.input,
      output: rows?.output,
      cacheRead: rows?.cacheRead,
      cacheWrite: rows?.cacheWrite,
      costUsd: rows?.costUsd,
      toolCalls: 1,
    });
    expect(envelope.model).toMatch(/^[^/]+\/.+/);
  });
});
