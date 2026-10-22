// `[policy] allowed_regions` and `[model] fallback` on `kubic run`: a model
// outside the regions is refused before any request; a selected model that
// cannot be used gives way to the first usable rung; a turn whose model
// fails with a provider error runs again on the next rung — each move named
// and recorded. Faux providers only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { resolveEffectivePolicy } from '@kubic/host/policy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../../src/run/command.js';
import type { HeadlessRunDeps } from '../../src/run/options.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function catalog(): {
  models: MutableModels;
  primary: ReturnType<typeof fauxProvider>;
  backup: ReturnType<typeof fauxProvider>;
} {
  const primary = fauxProvider({
    provider: 'primary',
    models: [{ id: 'big', contextWindow: 120000 }],
  });
  const backup = fauxProvider({
    provider: 'backup',
    models: [{ id: 'small', contextWindow: 120000 }],
  });
  const models = createModels();
  models.setProvider(primary.provider);
  models.setProvider(backup.provider);
  return { models, primary, backup };
}

async function run(deps: Partial<HeadlessRunDeps>) {
  const warnings: string[] = [];
  const sessionsRoot = tempDir('regions-sessions-');
  const result = await runHeadlessPrompt('hello', {}, {
    sessionsRoot,
    env: new NodeExecutionEnv(tempDir('regions-ws-')),
    warn: (line: string) => warnings.push(line),
    ...deps,
  } as HeadlessRunDeps);
  return { result, warnings, sessionsRoot };
}

describe('kubic run under [policy] allowed_regions', () => {
  it('refuses a model outside the regions before any request', async () => {
    const { models, primary } = catalog();
    primary.setResponses([fauxAssistantMessage('should not answer')]);
    const { result } = await run({
      models,
      model: { provider: 'primary', id: 'big' },
      modelPolicy: resolveEffectivePolicy([
        {
          layer: 'enterprise',
          policy: { models: { regions: ['eu-*'] } },
        },
      ]).policy,
      providerRegions: { primary: 'us-east-1' },
    });
    expect(result.terminus).toBe('provider_probe_failed');
    expect(result.error?.message).toContain(
      "provider 'primary' runs in us-east-1, outside [policy] allowed_regions (eu-*)",
    );
    expect(primary.state.callCount).toBe(0);
  });

  it('runs a model whose declared region is listed', async () => {
    const { models, primary } = catalog();
    primary.setResponses([fauxAssistantMessage('from the eu')]);
    const { result } = await run({
      models,
      model: { provider: 'primary', id: 'big' },
      modelPolicy: resolveEffectivePolicy([
        { layer: 'enterprise', policy: { models: { regions: ['eu-*'] } } },
      ]).policy,
      providerRegions: { primary: 'eu-west-1' },
    });
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('from the eu');
  });
});

describe('kubic run with [model] fallback', () => {
  it('selects the first usable rung when the selected model cannot be used', async () => {
    const { models, backup } = catalog();
    backup.setResponses([fauxAssistantMessage('the backup answered')]);
    const { result, warnings } = await run({
      models,
      model: { provider: 'gone', id: 'model' },
      modelFallback: ['backup/small'],
    });
    expect(result.terminus).toBe('completed');
    expect(result.model).toBe('backup/small');
    expect(result.fallbacks).toEqual([
      expect.objectContaining({ from: 'gone/model', to: 'backup/small' }),
    ]);
    expect(warnings.join('\n')).toContain('model: gone/model is unavailable');
  });

  it('runs a turn again on the next rung after a provider failure, and records it', async () => {
    const { models, primary, backup } = catalog();
    primary.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'insufficient_quota: the quota for this key is exhausted',
      }),
    ]);
    backup.setResponses([fauxAssistantMessage('the backup answered')]);
    const { result, warnings, sessionsRoot } = await run({
      models,
      model: { provider: 'primary', id: 'big' },
      modelFallback: ['backup/small'],
    });
    expect(result.terminus).toBe('completed');
    expect(result.summary).toBe('the backup answered');
    expect(result.model).toBe('backup/small');
    expect(result.fallbacks).toEqual([
      {
        from: 'primary/big',
        to: 'backup/small',
        reason: expect.stringContaining('insufficient_quota'),
      },
    ]);
    expect(warnings.join('\n')).toContain('model: primary/big is unavailable');
    const trajectory = JSON.parse(
      readFileSync(
        join(sessionsRoot, result.sessionId, 'trajectory.json'),
        'utf8',
      ),
    );
    expect(JSON.stringify(trajectory)).toContain(
      'fallback: insufficient_quota',
    );
  });

  it('reports the failure when no rung is left', async () => {
    const { models, primary } = catalog();
    primary.setResponses([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'insufficient_quota: exhausted',
      }),
    ]);
    const { result } = await run({
      models,
      model: { provider: 'primary', id: 'big' },
      modelFallback: ['gone/model'],
    });
    expect(result.terminus).not.toBe('completed');
    expect(result.fallbacks).toBeUndefined();
  });
});
