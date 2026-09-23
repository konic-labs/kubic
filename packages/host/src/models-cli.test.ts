// `kubic models` catalog CLI (issue #20, slice C; §17).
// Lists providers/models with thinking support + pricing; --resolve
// proves the selection chain end-to-end. Zero network: catalog reads are
// local (refresh is an explicit, separate concern).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_MODELS_EXAMPLE } from '../../worker/src/models-config.js';
import { createModels, fauxProvider } from '../../worker/src/pi-boundary.js';
import { assembleModels, runModelsCommand } from './models-cli.js';

describe('kubic models (issue #20, slice C)', () => {
  it('lists providers, models, and thinking support', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const lines: string[] = [];
    expect(
      await runModelsCommand([], { models, out: (l: string) => lines.push(l) }),
    ).toBe(0);
    expect(lines.join('\n')).toContain('faux');
    expect(lines.join('\n')).toMatch(/thinking:/);
  });

  it('resolves --model provider/id through the selection chain', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const fauxId = models.getModels('faux')[0]?.id ?? 'x';
    const lines: string[] = [];
    expect(
      await runModelsCommand(['--resolve', `faux/${fauxId}`], {
        models,
        out: (l: string) => lines.push(l),
      }),
    ).toBe(0);
    expect(lines.join('\n')).toContain(`selected faux/${fauxId}`);
    const bad: string[] = [];
    expect(
      await runModelsCommand(['--resolve', 'nope/x'], {
        models,
        out: (l: string) => bad.push(l),
      }),
    ).toBe(1);
    expect(bad.join('\n')).toContain('unknown provider');
  });

  it('--json parses', async () => {
    const models = createModels();
    models.setProvider(fauxProvider().provider);
    const lines: string[] = [];
    expect(
      await runModelsCommand(['--json'], {
        models,
        out: (l: string) => lines.push(l),
      }),
    ).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as Array<{ id: string }>;
    expect(parsed[0]?.id).toBe('faux');
  });

  it('assembles models.json customs from cwd, reporting invalid files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm-'));
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify(LOCAL_MODELS_EXAMPLE),
    );
    const ok = assembleModels(dir);
    expect(ok.models.getProvider('local')?.id).toBe('local');
    expect(ok.note).toContain('local');
    const empty = assembleModels(mkdtempSync(join(tmpdir(), 'm-')));
    expect(empty.note).toBe(null);
    const badDir = mkdtempSync(join(tmpdir(), 'm-'));
    writeFileSync(join(badDir, 'models.json'), '{nope');
    const bad = assembleModels(badDir);
    expect(bad.note).toContain('ignored');
  });
});
