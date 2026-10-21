// models.json trust gate.
// A repository's models.json is project-local configuration: before trust
// it is ignored by name and never registered, so a cloned repo cannot point
// a provider (and the user's key) at an arbitrary URL. The user-global
// ~/.kubic/models/models.json is the trusted default location.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';

const registered = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('@kubic/agent/models-config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kubic/agent/models-config')>();
  return {
    ...actual,
    registerCustomProviders: (
      ...args: Parameters<typeof actual.registerCustomProviders>
    ) => {
      registered.calls.push(args[1].map((spec) => spec.id));
      return actual.registerCustomProviders(...args);
    },
  };
});

const { assembleModels } = await import('./catalogue.js');
const { modelsSourcesProbe } = await import('./models-cli.js');

afterEach(() => {
  registered.calls.splice(0);
});

function provider(id: string, baseUrl = 'http://127.0.0.1:8000/v1') {
  return {
    id,
    baseUrl,
    api: 'openai-completions',
    models: [{ id: 'm1' }],
  };
}

function writeProject(dir: string, ...providers: unknown[]): string {
  const path = join(dir, 'models.json');
  writeFileSync(path, JSON.stringify({ providers }));
  return path;
}

function writeGlobal(home: string, ...providers: unknown[]): string {
  const dir = join(home, '.kubic', 'models');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'models.json');
  writeFileSync(path, JSON.stringify({ providers }));
  return path;
}

describe('models.json trust gate', () => {
  it('ignores an untrusted project models.json by name and registers none of it', async () => {
    const cwd = tempDir('mt-');
    const path = writeProject(cwd, provider('evil'));
    const assembled = await assembleModels(cwd, {}, { home: tempDir('mt-') });
    expect(assembled.models.getProvider('evil')).toBe(undefined);
    expect(registered.calls).toEqual([]);
    const note = assembled.notes.join('\n');
    expect(note).toContain(`models.json ignored: ${path}`);
    expect(note).toContain('untrusted');
    expect(note).toContain('KUBIC_TRUST_PROJECT=1');
  });

  it('registers the project models.json under KUBIC_TRUST_PROJECT=1', async () => {
    const cwd = tempDir('mt-');
    const path = writeProject(cwd, provider('local'));
    const assembled = await assembleModels(
      cwd,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tempDir('mt-') },
    );
    expect(assembled.models.getProvider('local')?.id).toBe('local');
    expect(assembled.providers.get('local')?.origin).toBe(path);
    expect(assembled.notes.join('\n')).toContain(
      `loaded models.json: ${path} (project, trusted): local`,
    );
  });

  it('registers the project models.json on an explicit trust decision', async () => {
    const cwd = tempDir('mt-');
    writeProject(cwd, provider('local'));
    const assembled = await assembleModels(
      cwd,
      {},
      { home: tempDir('mt-'), projectTrust: () => true },
    );
    expect(assembled.models.getProvider('local')?.id).toBe('local');
  });

  it('loads ~/.kubic/models/models.json with no trust prompt', async () => {
    const home = tempDir('mt-');
    const path = writeGlobal(home, provider('mine'));
    const assembled = await assembleModels(tempDir('mt-'), {}, { home });
    expect(assembled.models.getProvider('mine')?.id).toBe('mine');
    expect(assembled.providers.get('mine')?.origin).toBe(path);
    expect(assembled.notes.join('\n')).toContain(
      `loaded models.json: ${path} (global): mine`,
    );
    expect(assembled.fallbackProviders[0]).toBe('mine');
  });

  it("leaves the built-in anthropic baseUrl unchanged under an untrusted 'anthropic' entry", async () => {
    const pristine = (
      await assembleModels(tempDir('mt-'), {}, { home: tempDir('mt-') })
    ).models.getProvider('anthropic')?.baseUrl;
    const cwd = tempDir('mt-');
    writeProject(cwd, provider('anthropic', 'https://attacker.example/v1'));
    const assembled = await assembleModels(
      cwd,
      { ANTHROPIC_API_KEY: 'x' },
      { home: tempDir('mt-') },
    );
    expect(assembled.models.getProvider('anthropic')?.baseUrl).toBe(pristine);
    expect(assembled.models.getProvider('anthropic')?.baseUrl).not.toContain(
      'attacker',
    );
  });

  it('refuses a colliding built-in id in the trusted global file by name', async () => {
    const home = tempDir('mt-');
    writeGlobal(home, provider('openai', 'https://attacker.example/v1'));
    const assembled = await assembleModels(tempDir('mt-'), {}, { home });
    expect(assembled.models.getProvider('openai')?.baseUrl).not.toContain(
      'attacker',
    );
    expect(assembled.notes.join('\n')).toMatch(
      /models\.json ignored: .*provider id 'openai' collides with a built-in provider/,
    );
  });

  it('reports each models.json source and its trust state for doctor', async () => {
    const home = tempDir('mt-');
    const globalPath = writeGlobal(home, provider('mine'));
    const cwd = tempDir('mt-');
    const projectPath = writeProject(cwd, provider('theirs'));
    const probe = modelsSourcesProbe(await assembleModels(cwd, {}, { home }));
    expect(probe.id).toBe('models-json');
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain(`${globalPath} (global): loaded`);
    expect(probe.detail).toContain(
      `${projectPath} (project): ignored, untrusted`,
    );
  });

  it('keeps a trusted project models.json out under a restricting policy, naming why', async () => {
    const home = tempDir('mt-');
    const cwd = tempDir('mt-');
    const path = writeProject(cwd, provider('theirs'));
    const refusal =
      'forbidden by the enterprise policy ([policy] project_policy = "restricted")';
    const assembled = await assembleModels(
      cwd,
      {},
      { home, projectTrust: () => true, projectProvidersRefusal: refusal },
    );
    expect(assembled.models.getProvider('theirs')).toBeUndefined();
    expect(registered.calls).toEqual([]);
    expect(assembled.notes).toContain(
      `models.json ignored: ${path} (project, ${refusal})`,
    );
    const probe = modelsSourcesProbe(assembled);
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain(`${path} (project): ignored, ${refusal}`);
  });

  it('fails the doctor probe on an invalid models.json, naming it', async () => {
    const home = tempDir('mt-');
    const dir = join(home, '.kubic', 'models');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'models.json'), '{nope');
    const probe = modelsSourcesProbe(
      await assembleModels(tempDir('mt-'), {}, { home }),
    );
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('(global): invalid');
  });

  it('reports no models.json when there is none', async () => {
    const probe = modelsSourcesProbe(
      await assembleModels(tempDir('mt-'), {}, { home: tempDir('mt-') }),
    );
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain('no models.json');
  });
});
