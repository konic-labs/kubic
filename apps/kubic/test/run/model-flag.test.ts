// `kubic run --model provider/id`. The flag is
// the `cli` config layer: it beats `KUBIC_MODEL` and `[model]`, never a
// frozen enterprise key, and the projection (`runtimeModelPin`) is the same
// one the lane boots from — so these tests go through the REAL load and the
// REAL headless boot on faux models. Zero network, zero paid tokens.
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import {
  effectiveConfigView,
  loadRuntimeConfig,
  renderEffectiveConfig,
} from '@kubic/host/config';
import { mapTerminusToExitCode } from '@kubic/host/run';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { loadCliConfig } from '../../src/config/load.js';
import { runtimeModelPin } from '../../src/config/model-selection.js';
import { runHeadlessPrompt } from '../../src/run/command.js';

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Two faux models; the default (unpinned) pick is the first, `big`.
function catalog(texts: string[]): MutableModels {
  const faux = fauxProvider({
    provider: 'faux',
    models: [
      { id: 'big', contextWindow: 200000 },
      { id: 'small', contextWindow: 120000 },
    ],
  });
  faux.setResponses(texts.map((text) => fauxAssistantMessage(text)));
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

describe('kubic run --model', () => {
  it('selects the model the flag names, over the first provider', async () => {
    const config = loadCliConfig({
      cwd: tempDir('run-model-override-cwd-'),
      home: tempDir('run-model-override-home-'),
      env: {},
      model: { provider: 'faux', id: 'small' },
    });
    const pin = runtimeModelPin(config);
    expect(pin).toEqual({ provider: 'faux', id: 'small' });

    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tempDir('run-model-override-sessions-'),
        env: new FakeExecutionEnv({}),
        models: catalog(['answered']),
        ...(pin === undefined ? {} : { model: pin }),
      },
    );
    expect(result.terminus).toBe('completed');
    expect(result.model).toBe('faux/small');
  });

  it('beats the KUBIC_MODEL env pin, as the cli layer', () => {
    const config = loadCliConfig({
      cwd: tempDir('run-model-override-cwd2-'),
      home: tempDir('run-model-override-home2-'),
      env: { KUBIC_MODEL: 'faux/big' },
      model: { provider: 'faux', id: 'small' },
    });
    expect(runtimeModelPin(config)).toEqual({ provider: 'faux', id: 'small' });
  });

  it('an unknown model fails closed by name with exit 6', async () => {
    const config = loadCliConfig({
      cwd: tempDir('run-model-override-cwd3-'),
      home: tempDir('run-model-override-home3-'),
      env: {},
      model: { provider: 'faux', id: 'nope' },
    });
    const pin = runtimeModelPin(config);
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tempDir('run-model-override-sessions3-'),
        env: new FakeExecutionEnv({}),
        models: catalog([]),
        ...(pin === undefined ? {} : { model: pin }),
      },
    );
    expect(result.terminus).toBe('provider_probe_failed');
    expect(mapTerminusToExitCode(result.terminus)).toBe(6);
    expect(result.error?.message).toContain(
      "unknown model 'nope' on provider 'faux' (--model)",
    );
  });

  it('a frozen enterprise model rejects the flag, which stays named enterprise', () => {
    const files = new Map([
      ['/etc/kubic/config.toml', '[model]\nprovider = "ent"\nid = "m"\n'],
    ]);
    const runtime = loadRuntimeConfig({
      bridge: {
        exists: (path: string) => files.has(path),
        readTextFile: (path: string) => files.get(path) as string,
      },
      home: tempDir('run-model-override-home4-'),
      cwd: tempDir('run-model-override-cwd4-'),
      env: {},
      cli: { model: { provider: 'faux', id: 'small' } },
    });
    // The flag is rejected: the frozen pin is the selection, and the view
    // names it as the enterprise value it is.
    expect(runtime.model).toEqual({ provider: 'ent', id: 'm' });
    expect(runtime.modelSource).toBe('enterprise');
    expect(renderEffectiveConfig(effectiveConfigView(runtime))).toContain(
      'selected model: ent/m (enterprise)',
    );
  });
});
