// `kubic run --model provider/id` (issue #227; §38.1, §35.1). The flag is
// the `cli` config layer: it beats `KUBIC_MODEL` and `[model]`, never a
// frozen enterprise key, and the projection (`runtimeModelPin`) is the same
// one the lane boots from — so these tests go through the REAL load and the
// REAL headless boot on faux models. Zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadCliConfig,
  runtimeModelPin,
} from '../../../apps/kubic/src/config-runtime.js';
import { runHeadlessPrompt } from '../../../apps/kubic/src/headless-run.js';
import { FakeExecutionEnv } from '../../exec/src/env.js';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '../../worker/src/pi-boundary.js';
import {
  effectiveConfigView,
  loadRuntimeConfig,
  renderEffectiveConfig,
} from './config/runtime.js';
import { mapTerminusToExitCode } from './run-cli.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  vi.stubEnv('KUBIC_PROVIDER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
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

describe('kubic run --model (issue #227)', () => {
  it('selects the model the flag names, over the first provider', async () => {
    const config = loadCliConfig({
      cwd: tmpRoot('run-227-cwd-'),
      home: tmpRoot('run-227-home-'),
      env: {},
      model: { provider: 'faux', id: 'small' },
    });
    const pin = runtimeModelPin(config);
    expect(pin).toEqual({ provider: 'faux', id: 'small' });

    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tmpRoot('run-227-sessions-'),
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
      cwd: tmpRoot('run-227-cwd2-'),
      home: tmpRoot('run-227-home2-'),
      env: { KUBIC_MODEL: 'faux/big' },
      model: { provider: 'faux', id: 'small' },
    });
    expect(runtimeModelPin(config)).toEqual({ provider: 'faux', id: 'small' });
  });

  it('an unknown model fails closed by name with exit 6', async () => {
    const config = loadCliConfig({
      cwd: tmpRoot('run-227-cwd3-'),
      home: tmpRoot('run-227-home3-'),
      env: {},
      model: { provider: 'faux', id: 'nope' },
    });
    const pin = runtimeModelPin(config);
    const result = await runHeadlessPrompt(
      'hello',
      {},
      {
        sessionsRoot: tmpRoot('run-227-sessions3-'),
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
      home: tmpRoot('run-227-home4-'),
      cwd: tmpRoot('run-227-cwd4-'),
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
