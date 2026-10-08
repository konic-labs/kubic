// `kubic models` catalog CLI.
// Lists providers/models with thinking support + pricing; --resolve
// proves the selection chain end-to-end. Zero network: catalog reads are
// local (refresh is an explicit, separate concern).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createModels, fauxProvider } from '../../worker/src/pi-boundary.js';
import { LOCAL_MODELS_EXAMPLE } from '../../worker/src/test-support/models-fixtures.js';
import {
  assembleModels,
  contextRoomProbeOf,
  runModelsCommand,
} from './models-cli.js';

const made: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('kubic models', () => {
  it('lists providers, models, and thinking support', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const lines: string[] = [];
    expect(
      (
        await runModelsCommand(
          {},
          { models, out: (l: string) => lines.push(l) },
        )
      ).exitCode,
    ).toBe(0);
    // A plain (non-TTY) table: header row, then one row per model.
    expect(lines).toHaveLength(1);
    const rows = (lines[0] ?? '').split('\n');
    expect(rows[0]).toMatch(
      /^PROVIDER\s+MODEL\s+THINKING\s+IN \$\/1M\s+OUT \$\/1M$/,
    );
    expect(rows[1]).toMatch(/^faux\s+faux-1\s+/);
    expect(lines[0]).not.toMatch(/[│┌]/);
  });

  it('draws the kit table (header rule) only in fancy mode', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const lines: string[] = [];
    await runModelsCommand(
      {},
      { models, fancy: true, out: (l: string) => lines.push(l) },
    );
    expect(lines.join('\n')).toMatch(/\n─+\n/);
    expect(lines.join('\n')).not.toMatch(/┌/);
  });

  it('reports an empty catalog on the diagnostics channel, not stdout', async () => {
    const out: string[] = [];
    const info: string[] = [];
    const code = (
      await runModelsCommand(
        {},
        {
          models: createModels(),
          out: (l: string) => out.push(l),
          logger: {
            error: () => undefined,
            warn: () => undefined,
            success: () => undefined,
            info: (message: string) => info.push(message),
          },
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(info.join('\n')).toContain('no usable providers');
  });

  it('resolves --model provider/id through the selection chain', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const fauxId = models.getModels('faux')[0]?.id ?? 'x';
    const lines: string[] = [];
    expect(
      (
        await runModelsCommand(
          { resolve: `faux/${fauxId}` },
          {
            models,
            out: (l: string) => lines.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    expect(lines.join('\n')).toContain(`selected faux/${fauxId}`);
    const bad: string[] = [];
    expect(
      (
        await runModelsCommand(
          { resolve: 'nope/x' },
          {
            models,
            out: (l: string) => bad.push(l),
          },
        )
      ).exitCode,
    ).toBe(1);
    expect(bad.join('\n')).toContain('unknown provider');
  });

  it('--json parses', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const lines: string[] = [];
    expect(
      (
        await runModelsCommand(
          { json: true },
          {
            models,
            out: (l: string) => lines.push(l),
          },
        )
      ).exitCode,
    ).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as Array<{ id: string }>;
    expect(parsed[0]?.id).toBe('faux');
  });

  it('assembles models.json customs from cwd, reporting invalid files', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify(LOCAL_MODELS_EXAMPLE),
    );
    const env = { KUBIC_TRUST_PROJECT: '1' };
    const home = tmpDir();
    const ok = await assembleModels(dir, env, { home });
    expect(ok.models.getProvider('local')?.id).toBe('local');
    expect(ok.notes.join('\n')).toContain('local');
    const empty = await assembleModels(tmpDir(), env, { home });
    expect(empty.notes).toEqual([]);
    const badDir = tmpDir();
    writeFileSync(join(badDir, 'models.json'), '{nope');
    const bad = await assembleModels(badDir, env, { home });
    expect(bad.notes.join('\n')).toContain('ignored');
  });

  it('adds the faux testing provider only under KUBIC_PROVIDER=faux', async () => {
    const dir = tmpDir();
    const home = tmpDir();
    expect(
      (await assembleModels(dir, {}, { home })).models.getProvider('faux'),
    ).toBe(undefined);
    const faux = await assembleModels(
      dir,
      { KUBIC_PROVIDER: 'faux' },
      { home },
    );
    expect(faux.models.getModel('faux', 'echo')?.id).toBe('echo');
  });
});

// `kubic models <provider>` and `--all`.
describe('a models.json model whose contextWindow was defaulted', () => {
  // `llama3` declares no window, so Kubic gives it the 8192 fallback; `qwen`
  // declares its window and must not be flagged.
  const DEFAULTED = {
    providers: [
      {
        id: 'local',
        name: 'Local',
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
        models: [{ id: 'llama3' }, { id: 'qwen', contextWindow: 32768 }],
      },
    ],
  };

  it('is recorded with the fallback window it was given, and only that model', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'models.json'), JSON.stringify(DEFAULTED));
    const assembled = await assembleModels(
      dir,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    expect(assembled.defaultedWindows).toEqual([
      { provider: 'local', model: 'llama3', contextWindow: 8192 },
    ]);
  });

  it('marks the model in the --json catalogue, and only that model', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'models.json'), JSON.stringify(DEFAULTED));
    const assembled = await assembleModels(
      dir,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    const lines: string[] = [];
    const code = (
      await runModelsCommand(
        { json: true },
        {
          models: assembled.models,
          providers: assembled.providers,
          defaultedWindows: assembled.defaultedWindows,
          out: (line: string) => lines.push(line),
        },
      )
    ).exitCode;
    expect(code).toBe(0);
    const catalogue = JSON.parse(lines.join('\n')) as Array<{
      id: string;
      models: Array<{ id: string; contextWindowDefaulted?: boolean }>;
    }>;
    const local = catalogue.find((provider) => provider.id === 'local');
    expect(
      local?.models.find((model) => model.id === 'llama3')
        ?.contextWindowDefaulted,
    ).toBe(true);
    expect(
      local?.models.find((model) => model.id === 'qwen')
        ?.contextWindowDefaulted,
    ).toBeUndefined();
  });
});

describe('a later models.json that declares the window replaces the default', () => {
  const LOCAL = (models: unknown[]) => ({
    providers: [
      {
        id: 'local',
        name: 'Local',
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
        models,
      },
    ],
  });

  it('clears the earlier fallback entry, and the effective window is the declared one', async () => {
    // The global file leaves llama3 without a window; the trusted project file
    // declares 32768 for the same model. The effective window is 32768, so the
    // model is not defaulted.
    const home = tmpDir();
    mkdirSync(join(home, '.kubic', 'models'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'models', 'models.json'),
      JSON.stringify(LOCAL([{ id: 'llama3' }])),
    );
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify(LOCAL([{ id: 'llama3', contextWindow: 32768 }])),
    );
    const assembled = await assembleModels(
      dir,
      { KUBIC_TRUST_PROJECT: '1' },
      { home },
    );
    expect(assembled.defaultedWindows).toEqual([]);
    expect(
      assembled.models.getModels('local').find((model) => model.id === 'llama3')
        ?.contextWindow,
    ).toBe(32768);
  });
});

describe('the room probe measures what the user can configure', () => {
  it('takes the models.json models and the pinned default, never a model outside them', async () => {
    const dir = tmpDir();
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: [
          {
            id: 'local',
            name: 'Local',
            baseUrl: 'http://localhost:11434/v1',
            api: 'openai-completions',
            models: [{ id: 'llama3' }, { id: 'qwen', contextWindow: 32768 }],
          },
        ],
      }),
    );
    const assembled = await assembleModels(
      dir,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    // A registered model the user cannot resize: it is not in models.json.
    assembled.models.setProvider(
      fauxProvider({ models: [{ id: 'small', contextWindow: 8192 }] }).provider,
    );
    const probe = contextRoomProbeOf(assembled, {
      defaultModel: { provider: 'faux', id: 'small' },
    });
    expect(probe.customModels).toEqual([
      { provider: 'local', model: 'llama3', contextWindow: 8192 },
      { provider: 'local', model: 'qwen', contextWindow: 32768 },
    ]);
    expect(probe.defaultModel).toEqual({
      provider: 'faux',
      model: 'small',
      contextWindow: 8192,
    });
  });

  it('has no default model when none is pinned, and no custom model without a models.json', async () => {
    const assembled = await assembleModels(tmpDir(), {}, { home: tmpDir() });
    expect(contextRoomProbeOf(assembled)).toEqual({ customModels: [] });
  });
});

describe('kubic models provider filter', () => {
  function registry() {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    return models;
  }

  it('refuses an unknown provider as a usage error naming the known ones', async () => {
    const lines: string[] = [];
    const code = (
      await runModelsCommand(
        { provider: 'nope' },
        { models: registry(), out: (l: string) => lines.push(l) },
      )
    ).exitCode;
    expect(code).toBe(2);
    expect(lines.join('\n')).toMatch(/unknown provider "nope" \(known: faux/);
  });

  it('lists only the named provider, in the plain table off a terminal', async () => {
    const lines: string[] = [];
    const code = (
      await runModelsCommand(
        { provider: 'faux' },
        { models: registry(), out: (l: string) => lines.push(l) },
      )
    ).exitCode;
    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^PROVIDER\s+MODEL/);
    expect(lines.slice(1).every((line) => line.startsWith('faux'))).toBe(true);
  });

  it('scopes --json to the named provider', async () => {
    const lines: string[] = [];
    await runModelsCommand(
      { provider: 'faux', json: true },
      { models: registry(), out: (l: string) => lines.push(l) },
    );
    const doc = JSON.parse(lines.join('\n')) as { id: string }[];
    expect(doc.map((provider) => provider.id)).toEqual(['faux']);
  });

  it('renders the catalogue view when fancy and marks the pinned default', async () => {
    const lines: string[] = [];
    const models = registry();
    const first = models.getModels('faux')[0];
    await runModelsCommand(
      {},
      {
        models,
        fancy: true,
        defaultModel: `faux/${first?.id}`,
        out: (l: string) => lines.push(l),
      },
    );
    expect(lines.join('\n')).toContain(`● faux/${first?.id}  default`);
    expect(lines.at(-1)).toBe('set a default: kubic setup');
  });
});
