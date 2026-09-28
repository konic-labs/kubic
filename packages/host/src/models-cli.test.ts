// `kubic models` catalog CLI (issue #20, slice C; §17).
// Lists providers/models with thinking support + pricing; --resolve
// proves the selection chain end-to-end. Zero network: catalog reads are
// local (refresh is an explicit, separate concern).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_MODELS_EXAMPLE } from '../../worker/src/models-config.js';
import { createModels, fauxProvider } from '../../worker/src/pi-boundary.js';
import { assembleModels, runModelsCommand } from './models-cli.js';

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

describe('kubic models (issue #20, slice C)', () => {
  it('lists providers, models, and thinking support', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const lines: string[] = [];
    expect(
      await runModelsCommand({}, { models, out: (l: string) => lines.push(l) }),
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

  it('draws a boxed table only in fancy mode', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const lines: string[] = [];
    await runModelsCommand(
      {},
      { models, fancy: true, out: (l: string) => lines.push(l) },
    );
    expect(lines.join('\n')).toMatch(/┌/);
  });

  it('reports an empty catalog on the diagnostics channel, not stdout', async () => {
    const out: string[] = [];
    const info: string[] = [];
    const code = await runModelsCommand(
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
    );
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(info.join('\n')).toContain('no providers registered');
  });

  it('resolves --model provider/id through the selection chain', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const fauxId = models.getModels('faux')[0]?.id ?? 'x';
    const lines: string[] = [];
    expect(
      await runModelsCommand(
        { resolve: `faux/${fauxId}` },
        {
          models,
          out: (l: string) => lines.push(l),
        },
      ),
    ).toBe(0);
    expect(lines.join('\n')).toContain(`selected faux/${fauxId}`);
    const bad: string[] = [];
    expect(
      await runModelsCommand(
        { resolve: 'nope/x' },
        {
          models,
          out: (l: string) => bad.push(l),
        },
      ),
    ).toBe(1);
    expect(bad.join('\n')).toContain('unknown provider');
  });

  it('--json parses', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const lines: string[] = [];
    expect(
      await runModelsCommand(
        { json: true },
        {
          models,
          out: (l: string) => lines.push(l),
        },
      ),
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
    const ok = assembleModels(dir);
    expect(ok.models.getProvider('local')?.id).toBe('local');
    expect(ok.note).toContain('local');
    const empty = assembleModels(tmpDir());
    expect(empty.note).toBe(null);
    const badDir = tmpDir();
    writeFileSync(join(badDir, 'models.json'), '{nope');
    const bad = assembleModels(badDir);
    expect(bad.note).toContain('ignored');
  });

  it('adds the faux testing provider only under KUBIC_PROVIDER=faux', () => {
    const dir = tmpDir();
    expect(assembleModels(dir, {}).models.getProvider('faux')).toBe(undefined);
    const faux = assembleModels(dir, { KUBIC_PROVIDER: 'faux' });
    expect(faux.models.getModel('faux', 'echo')?.id).toBe('echo');
  });
});
