// models.json lookup: the global ~/.kubic/models/models.json, then the
// PROJECT file at the project root (git top level / nearest .kubic), so
// which providers exist never depends on the directory kubic was launched
// from.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import {
  ProjectTrustStore,
  projectTrustCheck,
  projectTrustStorePath,
} from '@kubic/host/config';
import { assembleModels, findModelsProjectRoot } from '@kubic/host/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from './headless-run.js';

const made: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ml-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function provider(id: string, baseUrl = 'http://127.0.0.1:1/v1') {
  return {
    id,
    baseUrl,
    api: 'openai-completions',
    models: [{ id: 'm1' }],
  };
}

function writeJson(path: string, ...providers: unknown[]): string {
  writeFileSync(path, JSON.stringify({ providers }));
  return path;
}

function globalFile(home: string, ...providers: unknown[]): string {
  const dir = join(home, '.kubic', 'models');
  mkdirSync(dir, { recursive: true });
  return writeJson(join(dir, 'models.json'), ...providers);
}

// A repo root marked the way git marks one (a `.git` dir), with a nested
// subdirectory to launch from.
function repo(): { root: string; sub: string } {
  const root = tmpDir();
  mkdirSync(join(root, '.git'));
  const sub = join(root, 'src', 'deep');
  mkdirSync(sub, { recursive: true });
  return { root, sub };
}

const TRUST = { KUBIC_TRUST_PROJECT: '1' };

describe('models.json lookup', () => {
  it('lists a provider declared only in the global file from any cwd', async () => {
    const home = tmpDir();
    globalFile(home, provider('mine'));
    const { sub } = repo();
    for (const cwd of [sub, tmpDir()]) {
      const assembled = await assembleModels(cwd, {}, { home });
      expect(assembled.models.getProvider('mine')?.id).toBe('mine');
    }
  });

  it('lists the same providers from a repo subdirectory as from the root', async () => {
    const home = tmpDir();
    const { root, sub } = repo();
    const path = writeJson(join(root, 'models.json'), provider('proj'));
    const fromRoot = await assembleModels(root, TRUST, { home });
    const fromSub = await assembleModels(sub, TRUST, { home });
    expect(fromSub.models.getProvider('proj')?.id).toBe('proj');
    expect(fromSub.providers.get('proj')?.origin).toBe(path);
    expect(fromSub.fallbackProviders).toEqual(fromRoot.fallbackProviders);
  });

  it('finds <root>/.kubic/models.json at the project root', async () => {
    const home = tmpDir();
    const { root, sub } = repo();
    mkdirSync(join(root, '.kubic'));
    const path = writeJson(
      join(root, '.kubic', 'models.json'),
      provider('dotkubic'),
    );
    const assembled = await assembleModels(sub, TRUST, { home });
    expect(assembled.providers.get('dotkubic')?.origin).toBe(path);
  });

  it('lets a project provider override a global one with the same id', async () => {
    const home = tmpDir();
    globalFile(home, provider('shared', 'http://127.0.0.1:1/global'));
    const { root } = repo();
    const path = writeJson(
      join(root, 'models.json'),
      provider('shared', 'http://127.0.0.1:1/project'),
    );
    const assembled = await assembleModels(root, TRUST, { home });
    expect(assembled.providers.get('shared')?.origin).toBe(path);
    expect(assembled.models.getModel('shared', 'm1')?.baseUrl).toBe(
      'http://127.0.0.1:1/project',
    );
    expect(
      assembled.fallbackProviders.filter((id) => id === 'shared'),
    ).toHaveLength(1);
  });

  it('keeps the global provider when the project file is untrusted', async () => {
    const home = tmpDir();
    globalFile(home, provider('shared', 'http://127.0.0.1:1/global'));
    const { root } = repo();
    writeJson(
      join(root, 'models.json'),
      provider('shared', 'http://127.0.0.1:1/project'),
    );
    const assembled = await assembleModels(root, {}, { home });
    expect(assembled.models.getModel('shared', 'm1')?.baseUrl).toBe(
      'http://127.0.0.1:1/global',
    );
  });

  it('never treats the home directory (global .kubic) as a project root', () => {
    const home = tmpDir();
    mkdirSync(join(home, '.kubic', 'models'), { recursive: true });
    const cwd = join(home, 'scratch');
    mkdirSync(cwd);
    expect(findModelsProjectRoot(cwd, home)).toBe(cwd);
    const { root, sub } = repo();
    expect(findModelsProjectRoot(sub, home)).toBe(root);
  });

  it('`kubic run` from a subdirectory uses the global provider', async () => {
    const home = tmpDir();
    const path = globalFile(home, provider('mine'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    const { sub } = repo();
    const debugLines: string[] = [];
    const result = await runHeadlessPrompt(
      'hello',
      // A safety net only, never the thing under test: the wall-clock guard
      // must not race the boot-phase sinks (under coverage instrumentation a
      // 1 ms bound fires before model assembly and the debug line is never
      // emitted). The unreachable keyless endpoint ends the run on its own.
      { timeoutMs: 30_000, debug: true },
      {
        sessionsRoot: tmpDir(),
        env: new FakeExecutionEnv({}),
        modelsCwd: sub,
        debugSink: (line) => debugLines.push(line),
        warn: () => undefined,
      },
    );
    // The global provider was selected (a keyless custom endpoint then
    // fails its auth — never "no models available").
    expect(result.summary).not.toContain('no models available');
    expect(debugLines.join('\n')).toContain(
      `loaded models.json: ${path} (global): mine`,
    );
  });
});

it('scopes a store grant to the tree the models.json lives in', async () => {
  const home = tmpDir();
  const { root, sub } = repo();
  const path = writeJson(join(root, 'models.json'), provider('mine'));
  const store = new ProjectTrustStore(projectTrustStorePath(home));
  vi.stubEnv('HOME', home);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  // The grant names the repository root; the run starts in src/deep, and
  // the root's committed file must still load — the decision belongs to
  // the tree the file lives in.
  store.set(root, true);
  const debugLines: string[] = [];
  await runHeadlessPrompt(
    'hello',
    { timeoutMs: 30_000, debug: true },
    {
      sessionsRoot: tmpDir(),
      env: new FakeExecutionEnv({}),
      modelsCwd: sub,
      debugSink: (line) => debugLines.push(line),
      warn: () => undefined,
      trustProject: projectTrustCheck({ home, env: {}, store }),
    },
  );
  expect(debugLines.join('\n')).toContain(
    `loaded models.json: ${path} (project, trusted): mine`,
  );
});

it('never lets a subdirectory grant reach the ancestor models.json', async () => {
  const home = tmpDir();
  const { root, sub } = repo();
  const path = writeJson(join(root, 'models.json'), provider('mine'));
  const store = new ProjectTrustStore(projectTrustStorePath(home));
  vi.stubEnv('HOME', home);
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
  // A grant in src/deep only: the root's committed file is out of scope.
  store.set(sub, true);
  const warnings: string[] = [];
  await runHeadlessPrompt(
    'hello',
    { timeoutMs: 30_000, debug: true },
    {
      sessionsRoot: tmpDir(),
      env: new FakeExecutionEnv({}),
      modelsCwd: sub,
      debugSink: () => undefined,
      warn: (line) => warnings.push(line),
      trustProject: projectTrustCheck({ home, env: {}, store }),
    },
  );
  expect(warnings.join('\n')).toContain(
    `models.json ignored: ${path} (project, untrusted`,
  );
});
