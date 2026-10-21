// `[policy]` spend caps on the live path: a day whose cap is spent refuses the
// run before a session exists, and a run that reaches its own cap stops with
// the `spend_limit` status (exit 3). Faux responses cost nothing, so the caps
// here are zero. Faux provider only.
import { readdirSync } from 'node:fs';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@kubic/agent/pi-boundary';
import { fauxToolUse } from '@kubic/agent/test-support/lane-harness';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { buildRunEnvelope, mapTerminusToExitCode } from '@kubic/host/run';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import { fauxModels } from '../fixtures/faux-models.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('spend caps', () => {
  it('refuses a run on a day whose cap is spent, before any session exists', async () => {
    const sessionsRoot = tempDir('spend-run-');
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot,
        models: fauxModels(['never sent']),
        env: new FakeExecutionEnv({}),
        spend: { daily: { usd: 0, layer: 'enterprise' } },
      },
    );
    expect(result.terminus).toBe('spend_limit');
    expect(mapTerminusToExitCode(result.terminus)).toBe(3);
    expect(result.summary).toBe(
      'daily spend limit reached: this machine spent $0.0000 today (UTC), and [policy] max_daily_cost_usd allows $0.0000 (set by the enterprise layer)',
    );
    expect(buildRunEnvelope(result, 3).failure?.code).toBe('run_limit');
    expect(readdirSync(sessionsRoot)).toEqual([]);
  });

  it('stops a run at its own cap after the response that reached it', async () => {
    const sessionsRoot = tempDir('spend-run-');
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    // The first response asks for a tool; the cap stops the run before the
    // second is requested.
    faux.setResponses([
      fauxToolUse([fauxToolCall('ls', { path: '.' })]),
      fauxAssistantMessage('never requested'),
    ]);
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot,
        models,
        env: new FakeExecutionEnv({}),
        spend: { run: { usd: 0, layer: 'project' } },
      },
    );
    expect(result.terminus).toBe('spend_limit');
    expect(result.summary).toContain(
      'spend limit reached: this run cost $0.0000, and [policy] max_run_cost_usd allows $0.0000 (set by the project layer)',
    );
    expect(result.sessionId).not.toBe('unassigned');
  });
});
