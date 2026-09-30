// `kubic run --json` carries the run's real usage (issue #185; §39, §68):
// the orchestrator builds each worker's §68 metrics from the child's own
// report, so the report must carry the numbers — the SAME ones `kubic cost`
// reads from the session — never zeros and never a bare ref.
//
// Faux provider only: the faux model's usage is deterministic, zero
// network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '../../worker/src/pi-boundary.js';
import { loadSessionCostRows } from './ops/cost/cost-cli.js';
import { buildRunEnvelope } from './run-cli.js';

const made: string[] = [];

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('run envelope usage (issue #185)', () => {
  it('reports the session usage rows, the tool calls and the model it ran', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kubic-185-sessions-'));
    made.push(root);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('ls', { path: '.' })]),
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
