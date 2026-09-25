// First-party bundle startup (issue #80): the on-disk bundle under
// skills/budget loads through the #37 trust gates at CLI startup.
// RED first.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUDGET_MANIFEST } from './bundles/budget/index.js';
import type { BundleDirFiles } from './startup.js';
import { probeFirstPartyPosture } from './startup.js';

const HOME = '/Users/tester';
const OPTS = { homeDir: HOME, cwd: '/repo', allowlist: [] as string[] };

const MANIFEST_JSON = JSON.stringify({
  name: 'kubic/budget',
  publisher: 'kubic',
  version: '0.0.0',
  sourcePath: 'kubic/budget',
  facets: ['contract', 'host', 'worker', 'tui'],
});

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function fakeFiles(
  root: string,
  shape: { dir: boolean; manifest?: string },
): BundleDirFiles {
  const dir = normalize(`${root}/skills/budget`);
  const file = normalize(`${dir}/manifest.json`);
  return {
    joinPath: (parts: string[]) => normalize(parts.join('/')),
    exists: (path: string) =>
      shape.dir &&
      (normalize(path) === dir ||
        (shape.manifest !== undefined && normalize(path) === file)),
    fileInfo: (path: string) => {
      if (shape.dir && normalize(path) === dir) return { isDirectory: true };
      throw new Error(`ENOENT: no such file: ${path}`);
    },
    readTextFile: (path: string) => {
      if (shape.dir && shape.manifest !== undefined && normalize(path) === file)
        return shape.manifest;
      throw new Error(`ENOENT: no such file: ${path}`);
    },
  };
}

function shadowFiles(
  shadowDir: string,
  shadowManifest: string,
  realDir: string,
): BundleDirFiles {
  const shadowFile = normalize(`${shadowDir}/manifest.json`);
  const realFile = normalize(`${realDir}/manifest.json`);
  return {
    joinPath: (parts: string[]) => normalize(parts.join('/')),
    exists: (path: string) => {
      const candidate = normalize(path);
      return (
        candidate === shadowDir ||
        candidate === shadowFile ||
        candidate === realDir ||
        candidate === realFile
      );
    },
    fileInfo: (path: string) => {
      const candidate = normalize(path);
      if (candidate === shadowDir || candidate === realDir)
        return { isDirectory: true };
      throw new Error(`ENOENT: no such file: ${path}`);
    },
    readTextFile: (path: string) => {
      const candidate = normalize(path);
      if (candidate === shadowFile) return shadowManifest;
      if (candidate === realFile) return MANIFEST_JSON;
      throw new Error(`ENOENT: no such file: ${path}`);
    },
  };
}

describe('first-party bundle startup (issue #80)', () => {
  it('loads the on-disk bundle through the trust gates, refusing both live bypasses', async () => {
    const posture = await probeFirstPartyPosture({
      anchorDir: '/repo/dist/apps/kubic/src',
      files: fakeFiles('/repo', { dir: true, manifest: MANIFEST_JSON }),
      trust: OPTS,
    });
    expect(posture.ok).toBe(true);
    expect(posture.loaded).toEqual(['kubic/budget']);
    expect(posture.refused.map((entry) => entry.attempt)).toEqual([
      'resolve:/repo/.pi/extensions/../evil.js',
      'use:budget/limits:{remote:1}',
    ]);
    expect(posture.detail).toContain(
      'loaded 1 (kubic/budget: budget: none configured)',
    );
    expect(posture.detail).toContain('refused 2');
  });

  it('fails closed with a clear error when the bundle dir is gone, never a silent no-op', async () => {
    const posture = await probeFirstPartyPosture({
      anchorDir: '/repo/dist/apps/kubic/src',
      files: fakeFiles('/repo', { dir: false }),
      trust: OPTS,
    });
    expect(posture.ok).toBe(false);
    expect(posture.loaded).toEqual([]);
    expect(posture.detail).toContain('extension bundle dir missing');
    expect(posture.detail).toContain('skills/budget');
    expect(posture.detail).toContain('never a silent skip');
  });

  it('refuses a tampered manifest (third-party publisher) through the same gates', async () => {
    const tampered = JSON.stringify({
      name: 'kubic/budget',
      publisher: 'evil-corp',
      version: '0.0.0',
      sourcePath: 'kubic/budget',
      facets: ['contract'],
    });
    const posture = await probeFirstPartyPosture({
      anchorDir: '/repo/dist/apps/kubic/src',
      files: fakeFiles('/repo', { dir: true, manifest: tampered }),
      trust: OPTS,
    });
    expect(posture.ok).toBe(false);
    expect(posture.loaded).toEqual([]);
    expect(posture.refused.map((entry) => entry.attempt)).toEqual([
      'manifest:kubic/budget',
    ]);
    expect(posture.detail).toContain('third-party');
  });

  it('refuses a tampered manifest (traversal sourcePath) through the same gates', async () => {
    const tampered = JSON.stringify({
      name: 'kubic/budget',
      publisher: 'kubic',
      version: '0.0.0',
      sourcePath: `${HOME}/.pi/agent/extensions/../evil.js`,
      facets: ['contract'],
    });
    const posture = await probeFirstPartyPosture({
      anchorDir: '/repo/dist/apps/kubic/src',
      files: fakeFiles('/repo', { dir: true, manifest: tampered }),
      trust: OPTS,
    });
    expect(posture.ok).toBe(false);
    expect(posture.loaded).toEqual([]);
    expect(posture.detail).toContain('not an owned path');
  });

  it('refuses invalid JSON and unknown bundle names with a clear error', async () => {
    for (const manifest of [
      '{not json',
      JSON.stringify({
        name: 'evil/extra',
        publisher: 'kubic',
        version: '0.0.0',
        sourcePath: 'kubic/extra',
        facets: ['contract'],
      }),
    ]) {
      const posture = await probeFirstPartyPosture({
        anchorDir: '/repo/dist/apps/kubic/src',
        files: fakeFiles('/repo', { dir: true, manifest }),
        trust: OPTS,
      });
      expect(posture.ok).toBe(false);
      expect(posture.loaded).toEqual([]);
      expect(posture.detail).toContain('extension bundle');
    }
  });

  it('refuses an on-disk manifest whose publisher drifted from the compiled pin', async () => {
    // 'konic-labs' passes the #37 trust gates (first-party publisher,
    // owned sourcePath) but disagrees with the compiled BUDGET_MANIFEST
    // pin — fail closed on drift, never trust-gates-only.
    const drifted = JSON.stringify({
      name: 'kubic/budget',
      publisher: 'konic-labs',
      version: '0.0.0',
      sourcePath: 'kubic/budget',
      facets: ['contract', 'host', 'worker', 'tui'],
    });
    const posture = await probeFirstPartyPosture({
      anchorDir: '/repo/dist/apps/kubic/src',
      files: fakeFiles('/repo', { dir: true, manifest: drifted }),
      trust: OPTS,
    });
    expect(posture.ok).toBe(false);
    expect(posture.loaded).toEqual([]);
    expect(posture.detail).toContain('drift');
  });

  it('refuses a same-length facets array with a duplicated entry masking a missing facet', async () => {
    // Length + subset would accept ['contract','contract','host','worker']
    // for the 4-facet pin despite missing 'tui' — strict set equality
    // must fail closed.
    const drifted = JSON.stringify({
      name: 'kubic/budget',
      publisher: 'kubic',
      version: '0.0.0',
      sourcePath: 'kubic/budget',
      facets: ['contract', 'contract', 'host', 'worker'],
    });
    const posture = await probeFirstPartyPosture({
      anchorDir: '/repo/dist/apps/kubic/src',
      files: fakeFiles('/repo', { dir: true, manifest: drifted }),
      trust: OPTS,
    });
    expect(posture.ok).toBe(false);
    expect(posture.loaded).toEqual([]);
    expect(posture.detail).toContain('drift');
  });

  it('refuses an on-disk manifest whose facets drifted from the compiled pin', async () => {
    const drifted = JSON.stringify({
      name: 'kubic/budget',
      publisher: 'kubic',
      version: '0.0.0',
      sourcePath: 'kubic/budget',
      facets: ['contract'],
    });
    const posture = await probeFirstPartyPosture({
      anchorDir: '/repo/dist/apps/kubic/src',
      files: fakeFiles('/repo', { dir: true, manifest: drifted }),
      trust: OPTS,
    });
    expect(posture.ok).toBe(false);
    expect(posture.loaded).toEqual([]);
    expect(posture.detail).toContain('drift');
  });

  it('fails closed on a nearer shadow manifest instead of falling through to the real bundle', async () => {
    const shadow = JSON.stringify({
      name: 'kubic/budget',
      publisher: 'konic-labs',
      version: '0.0.0',
      sourcePath: 'kubic/budget',
      facets: ['contract', 'host', 'worker', 'tui'],
    });
    const posture = await probeFirstPartyPosture({
      anchorDir: '/repo/dist/apps/kubic/src',
      files: shadowFiles(
        '/repo/dist/apps/kubic/src/skills/budget',
        shadow,
        '/repo/skills/budget',
      ),
      trust: OPTS,
    });
    expect(posture.ok).toBe(false);
    expect(posture.loaded).toEqual([]);
    expect(posture.detail).toContain('drift');
  });

  it('does not walk past the repo-root bound looking for the bundle', async () => {
    // The bundle sits 5 levels above this anchor; the walk is capped at
    // 4 (covers the dist layout exactly) so the probe fails closed
    // instead of escaping toward the filesystem root.
    const posture = await probeFirstPartyPosture({
      anchorDir: '/repo/d1/d2/d3/d4/d5',
      files: fakeFiles('/repo', { dir: true, manifest: MANIFEST_JSON }),
      trust: OPTS,
    });
    expect(posture.ok).toBe(false);
    expect(posture.loaded).toEqual([]);
    expect(posture.detail).toContain('extension bundle dir missing');
  });

  it('ships a valid on-disk manifest for kubic/budget under skills/', async () => {
    const repoRoot = dirname(
      dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
    );
    const text = readFileSync(
      join(repoRoot, 'skills', 'budget', 'manifest.json'),
      'utf8',
    );
    const shipped = JSON.parse(text) as {
      name: string;
      publisher: string;
      version: string;
      sourcePath: string;
      facets: string[];
    };
    expect(shipped.name).toBe(BUDGET_MANIFEST.name);
    expect(shipped.publisher).toBe(BUDGET_MANIFEST.publisher);
    expect(shipped.sourcePath).toBe(BUDGET_MANIFEST.sourcePath);
    expect(shipped.facets).toEqual([...BUDGET_MANIFEST.facets]);
  });
});
