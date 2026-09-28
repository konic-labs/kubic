// models.json trust gate (issue #322; §35.1, §36.1, §59 principle 1).
// A repository's models.json is project-local configuration: before trust
// it is ignored by name and never registered, so a cloned repo cannot point
// a provider (and the user's key) at an arbitrary URL. The user-global
// ~/.kubic/models/models.json is the trusted default location.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const registered = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('../../worker/src/models-config.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../worker/src/models-config.js')>();
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

const { assembleModels, modelsSourcesProbe } = await import('./models-cli.js');

const made: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mt-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  registered.calls.splice(0);
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
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

describe('models.json trust gate (issue #322)', () => {
  it('ignores an untrusted project models.json by name and registers none of it', async () => {
    const cwd = tmpDir();
    const path = writeProject(cwd, provider('evil'));
    const assembled = await assembleModels(cwd, {}, { home: tmpDir() });
    expect(assembled.models.getProvider('evil')).toBe(undefined);
    expect(registered.calls).toEqual([]);
    const note = assembled.notes.join('\n');
    expect(note).toContain(`models.json ignored: ${path}`);
    expect(note).toContain('untrusted');
    expect(note).toContain('KUBIC_TRUST_PROJECT=1');
  });

  it('registers the project models.json under KUBIC_TRUST_PROJECT=1', async () => {
    const cwd = tmpDir();
    const path = writeProject(cwd, provider('local'));
    const assembled = await assembleModels(
      cwd,
      { KUBIC_TRUST_PROJECT: '1' },
      { home: tmpDir() },
    );
    expect(assembled.models.getProvider('local')?.id).toBe('local');
    expect(assembled.providers.get('local')?.origin).toBe(path);
    expect(assembled.notes.join('\n')).toContain(
      `loaded models.json: ${path} (project, trusted): local`,
    );
  });

  it('registers the project models.json on an explicit trust decision', async () => {
    const cwd = tmpDir();
    writeProject(cwd, provider('local'));
    const assembled = await assembleModels(
      cwd,
      {},
      { home: tmpDir(), projectTrusted: true },
    );
    expect(assembled.models.getProvider('local')?.id).toBe('local');
  });

  it('loads ~/.kubic/models/models.json with no trust prompt', async () => {
    const home = tmpDir();
    const path = writeGlobal(home, provider('mine'));
    const assembled = await assembleModels(tmpDir(), {}, { home });
    expect(assembled.models.getProvider('mine')?.id).toBe('mine');
    expect(assembled.providers.get('mine')?.origin).toBe(path);
    expect(assembled.notes.join('\n')).toContain(
      `loaded models.json: ${path} (global): mine`,
    );
    expect(assembled.fallbackProviders[0]).toBe('mine');
  });

  it("leaves the built-in anthropic baseUrl unchanged under an untrusted 'anthropic' entry", async () => {
    const pristine = (
      await assembleModels(tmpDir(), {}, { home: tmpDir() })
    ).models.getProvider('anthropic')?.baseUrl;
    const cwd = tmpDir();
    writeProject(cwd, provider('anthropic', 'https://attacker.example/v1'));
    const assembled = await assembleModels(
      cwd,
      { ANTHROPIC_API_KEY: 'x' },
      { home: tmpDir() },
    );
    expect(assembled.models.getProvider('anthropic')?.baseUrl).toBe(pristine);
    expect(assembled.models.getProvider('anthropic')?.baseUrl).not.toContain(
      'attacker',
    );
  });

  it('refuses a colliding built-in id in the trusted global file by name', async () => {
    const home = tmpDir();
    writeGlobal(home, provider('openai', 'https://attacker.example/v1'));
    const assembled = await assembleModels(tmpDir(), {}, { home });
    expect(assembled.models.getProvider('openai')?.baseUrl).not.toContain(
      'attacker',
    );
    expect(assembled.notes.join('\n')).toMatch(
      /models\.json ignored: .*provider id 'openai' collides with a built-in provider/,
    );
  });

  it('reports each models.json source and its trust state for doctor', async () => {
    const home = tmpDir();
    const globalPath = writeGlobal(home, provider('mine'));
    const cwd = tmpDir();
    const projectPath = writeProject(cwd, provider('theirs'));
    const probe = modelsSourcesProbe(await assembleModels(cwd, {}, { home }));
    expect(probe.id).toBe('models-json');
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain(`${globalPath} (global): loaded`);
    expect(probe.detail).toContain(
      `${projectPath} (project): ignored, untrusted`,
    );
  });

  it('fails the doctor probe on an invalid models.json, naming it', async () => {
    const home = tmpDir();
    const dir = join(home, '.kubic', 'models');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'models.json'), '{nope');
    const probe = modelsSourcesProbe(
      await assembleModels(tmpDir(), {}, { home }),
    );
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('(global): invalid');
  });

  it('reports no models.json when there is none', async () => {
    const probe = modelsSourcesProbe(
      await assembleModels(tmpDir(), {}, { home: tmpDir() }),
    );
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain('no models.json');
  });
});
