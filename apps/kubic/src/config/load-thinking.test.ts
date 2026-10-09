// Composition-root trust wiring: the persisted
// decision under `~/.kubic/trust.json` is what makes a committed
// `.kubic/config.toml` usable, with no env var exported per invocation.
//
// These tests drive the real `loadCliConfig` over temp home/project dirs
// (no network, no paid tokens) and clean every temp dir up in `afterEach`.

// The `cli` config layer on the composition root's own load: `kubic run
// --model`, `kubic tui --model` and `kubic config --model` are one input to the
// ONE load dispatch performs, so the model the projection hands the lane is the
// same model `kubic config` reports — never two derivations that can drift.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { loadCliConfig } from './load.js';
import { runtimeLaneDeps } from './projections.js';

describe('cli thinking layer', () => {
  function homeWithThinking(thinking: string): { home: string; cwd: string } {
    const home = tempDir('cli-thinking-home-');
    const cwd = tempDir('cli-thinking-cwd-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      `[model]\nprovider = "g"\nid = "file"\nthinking = "${thinking}"\n`,
    );
    return { home, cwd };
  }

  it('projects the file default with its source', () => {
    const { home, cwd } = homeWithThinking('high');
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(runtimeLaneDeps(result).thinking).toEqual({
      level: 'high',
      source: 'global',
    });
  });

  it('orders --thinking > env > file', () => {
    const { home, cwd } = homeWithThinking('high');
    const env = loadCliConfig({
      cwd,
      home,
      env: { KUBIC_MODEL_THINKING: 'low' },
    });
    expect(runtimeLaneDeps(env).thinking).toEqual({
      level: 'low',
      source: 'env',
    });
    const cli = loadCliConfig({
      cwd,
      home,
      env: { KUBIC_MODEL_THINKING: 'low' },
      thinking: 'minimal',
    });
    expect(runtimeLaneDeps(cli).thinking).toEqual({
      level: 'minimal',
      source: 'cli',
    });
  });

  it('fails closed on a malformed env value, naming the variable', () => {
    const { home, cwd } = homeWithThinking('high');
    const result = loadCliConfig({
      cwd,
      home,
      env: { KUBIC_MODEL_THINKING: 'banana' },
    });
    expect(result.runtime).toBeUndefined();
    expect(result.error).toMatch(/KUBIC_MODEL_THINKING.*banana/);
  });

  it('carries the role thinking default in the lane layers', () => {
    const home = tempDir('cli-thinking-roles-home-');
    const cwd = tempDir('cli-thinking-roles-cwd-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[roles.reviewer]\nthinking = "low"\n',
    );
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(runtimeLaneDeps(result).roles?.layers).toEqual([
      { layer: 'global', roles: { reviewer: { thinking: 'low' } } },
    ]);
  });
  it('carries the role model sets in the lane layers', () => {
    const home = tempDir('cli-models-roles-home-');
    const cwd = tempDir('cli-models-roles-cwd-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[roles.reviewer]\nmodels = ["local/*"]\n',
    );
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(runtimeLaneDeps(result).roles?.layers).toEqual([
      { layer: 'global', roles: { reviewer: { models: [{ id: 'local/*' }] } } },
    ]);
  });
});
