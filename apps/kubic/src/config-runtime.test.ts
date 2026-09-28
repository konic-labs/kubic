// The `cli` config layer on the composition root's own load (issue #227,
// §35.1): `kubic run --model`, `kubic tui --model` and `kubic config
// --model` are one input to the ONE load dispatch performs, so the model
// the projection hands the lane is the same model `kubic config` reports —
// never two derivations that can drift.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  effectiveConfigView,
  renderEffectiveConfig,
} from '../../../packages/host/src/config/runtime.js';
import {
  loadCliConfig,
  requireRuntimeConfig,
  runtimeModelPin,
} from './config-runtime.js';

const made: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('cli model layer (issue #227)', () => {
  it('projects --model as the cli layer, above the file pin', () => {
    const home = tmp('cli-model-home-');
    const cwd = tmp('cli-model-cwd-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[model]\nprovider = "g"\nid = "file"\n',
    );

    const result = loadCliConfig({
      cwd,
      home,
      env: {},
      model: { provider: 'faux', id: 'small' },
    });
    expect(result.error).toBeUndefined();
    expect(runtimeModelPin(result)).toEqual({
      provider: 'faux',
      id: 'small',
    });
    const view = effectiveConfigView(requireRuntimeConfig(result));
    expect(view.modelSource).toBe('cli');
    expect(renderEffectiveConfig(view)).toContain(
      'selected model: faux/small (cli)',
    );
  });

  it('without the flag the file pin stays in force', () => {
    const home = tmp('cli-model-home2-');
    const cwd = tmp('cli-model-cwd2-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[model]\nprovider = "g"\nid = "file"\n',
    );

    const result = loadCliConfig({ cwd, home, env: {} });
    expect(runtimeModelPin(result)).toEqual({ provider: 'g', id: 'file' });
    const view = effectiveConfigView(requireRuntimeConfig(result));
    expect(renderEffectiveConfig(view)).toContain(
      'selected model: g/file (global)',
    );
  });
});
