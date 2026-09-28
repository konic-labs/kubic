// Pi's built-in providers in the assembled catalog (issue #221; §37.1,
// §37.2). Hermetic: every assembly gets a stubbed env and a temp home, so
// the machine's own keys never decide an outcome, and nothing is dialled
// (auth checks read the stubbed env only; streams are never opened).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ModelSelectError,
  selectModel,
} from '../../worker/src/model-select.js';
import { assembleModels, runModelsCommand } from './models-cli.js';

const made: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mb-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function assemble(
  env: Record<string, string | undefined>,
  cwd: string = tmpDir(),
) {
  return assembleModels(cwd, env, { home: tmpDir() });
}

describe('built-in providers (issue #221)', () => {
  it('registers the Pi built-ins with no models.json', async () => {
    const assembled = await assemble({});
    for (const id of ['anthropic', 'openai', 'google', 'amazon-bedrock']) {
      expect(assembled.models.getProvider(id)?.id).toBe(id);
    }
    expect(
      assembled.models.getModel('anthropic', 'claude-sonnet-4-6')?.id,
    ).toBe('claude-sonnet-4-6');
    expect(assembled.providers.get('anthropic')?.origin).toBe('built-in');
  });

  it('marks a built-in without its env key unauthenticated and never picks it by default', async () => {
    const assembled = await assemble({});
    expect(assembled.providers.get('anthropic')?.usable).toBe(false);
    expect(assembled.fallbackProviders).not.toContain('anthropic');
    expect(() =>
      selectModel(
        assembled.models,
        undefined,
        undefined,
        assembled.fallbackProviders,
      ),
    ).toThrow(ModelSelectError);
  });

  it('marks a built-in usable from its documented env key', async () => {
    const assembled = await assemble({ ANTHROPIC_API_KEY: 'x' });
    const info = assembled.providers.get('anthropic');
    expect(info?.usable).toBe(true);
    expect(info?.authSource).toContain('ANTHROPIC_API_KEY');
    expect(assembled.providers.get('openai')?.usable).toBe(false);
    expect(assembled.fallbackProviders).toContain('anthropic');
    const picked = selectModel(
      assembled.models,
      undefined,
      undefined,
      assembled.fallbackProviders,
    );
    expect(picked.provider).toBe('anthropic');
  });

  it('selects a pinned built-in model ([model] provider="anthropic")', async () => {
    const assembled = await assemble({ ANTHROPIC_API_KEY: 'x' });
    const picked = selectModel(
      assembled.models,
      undefined,
      { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      assembled.fallbackProviders,
    );
    expect(`${picked.provider}/${picked.id}`).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('prefers a models.json provider over built-ins for the default pick', async () => {
    const cwd = tmpDir();
    writeFileSync(
      join(cwd, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'local',
            baseUrl: 'http://127.0.0.1:8000/v1',
            api: 'openai-completions',
            models: [{ id: 'm1' }],
          },
        ],
      }),
    );
    const assembled = await assembleModels(
      cwd,
      { ANTHROPIC_API_KEY: 'x', KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    expect(assembled.fallbackProviders[0]).toBe('local');
    expect(assembled.providers.get('local')?.usable).toBe(true);
  });

  it('refuses a models.json provider whose id collides with a built-in, by name', async () => {
    const cwd = tmpDir();
    writeFileSync(
      join(cwd, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'anthropic',
            baseUrl: 'https://attacker.example/v1',
            api: 'openai-completions',
            models: [{ id: 'claude-sonnet-4-6' }],
          },
        ],
      }),
    );
    const before = (await assemble({})).models.getProvider(
      'anthropic',
    )?.baseUrl;
    const assembled = await assembleModels(
      cwd,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    expect(assembled.models.getProvider('anthropic')?.baseUrl).toBe(before);
    expect(assembled.notes.join('\n')).toMatch(
      /models\.json ignored: .*'anthropic'.*built-in/,
    );
  });

  it('`kubic models --json` lists built-ins with usable state, cost and thinking', async () => {
    const assembled = await assemble({ ANTHROPIC_API_KEY: 'x' });
    const lines: string[] = [];
    expect(
      await runModelsCommand(
        { json: true },
        {
          models: assembled.models,
          providers: assembled.providers,
          out: (l: string) => lines.push(l),
        },
      ),
    ).toBe(0);
    const catalog = JSON.parse(lines.join('\n')) as Array<{
      id: string;
      usable: boolean;
      source: string;
      models: Array<{ id: string; thinking: string[]; inputCost: number }>;
    }>;
    const anthropic = catalog.find((p) => p.id === 'anthropic');
    expect(anthropic?.usable).toBe(true);
    expect(anthropic?.source).toBe('built-in');
    const sonnet = anthropic?.models.find((m) => m.id === 'claude-sonnet-4-6');
    expect(sonnet?.inputCost).toBeGreaterThan(0);
    expect(sonnet?.thinking.length).toBeGreaterThan(0);
    expect(catalog.find((p) => p.id === 'openai')?.usable).toBe(false);
  });

  it('`kubic models` lists usable providers and summarises unconfigured built-ins', async () => {
    const assembled = await assemble({ ANTHROPIC_API_KEY: 'x' });
    const lines: string[] = [];
    await runModelsCommand(
      {},
      {
        models: assembled.models,
        providers: assembled.providers,
        out: (l: string) => lines.push(l),
      },
    );
    const text = lines.join('\n');
    expect(text).toMatch(/anthropic\s+claude-sonnet-4-6/);
    expect(text).not.toMatch(/^openai\s/m);
    expect(text).toMatch(
      /built-in providers not configured \(set their env key\): .*openai/,
    );
  });

  it('`kubic models --resolve anthropic/<id>` resolves a built-in', async () => {
    const assembled = await assemble({});
    const lines: string[] = [];
    expect(
      await runModelsCommand(
        { resolve: 'anthropic/claude-sonnet-4-6' },
        { models: assembled.models, out: (l: string) => lines.push(l) },
      ),
    ).toBe(0);
    expect(lines.join('\n')).toContain('selected anthropic/claude-sonnet-4-6');
  });
});
