// First-party bundle startup gate (issue #93): the composition root loads
// the bundle set through the #37 trust gates at process startup, for the
// solo and manager lanes alike. RED first.
import { describe, expect, it } from 'vitest';
import { BUDGET_MANIFEST } from './bundles/budget/index.js';
import {
  budgetStatusOf,
  budgetToolGate,
  ExtensionBudgetError,
  firstBreachedLimit,
  startFirstPartyExtensions,
} from './runtime.js';
import type { BundleDirFiles } from './startup.js';
import { ExtensionStartupError, loadFirstPartyBundle } from './startup.js';

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

function options(shape: { dir: boolean; manifest?: string }) {
  return {
    anchorDir: '/repo/dist/apps/kubic/src',
    files: fakeFiles('/repo', shape),
    trust: OPTS,
  };
}

describe('first-party bundle startup gate (issue #93)', () => {
  it('loads the on-disk bundle on the startup path and reports both refused bypass attempts', async () => {
    const startup = await startFirstPartyExtensions(
      options({ dir: true, manifest: MANIFEST_JSON }),
    );
    expect(startup.loaded).toEqual([BUDGET_MANIFEST.name]);
    expect(startup.refused.map((entry) => entry.attempt)).toEqual([
      'resolve:/repo/.pi/extensions/../evil.js',
      'use:budget/limits:{remote:1}',
    ]);
    expect(startup.detail).toContain(
      'loaded 1 (kubic/budget: budget: none configured)',
    );
    expect(startup.detail).toContain('refused 2');
    expect(startup.registered).toEqual([BUDGET_MANIFEST.name]);
  });

  it('fails closed with a named ExtensionStartupError when the bundle dir is gone', async () => {
    const error = await startFirstPartyExtensions(options({ dir: false })).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ExtensionStartupError);
    expect((error as Error).name).toBe('ExtensionStartupError');
    expect((error as Error).message).toContain('skills/budget');
    expect((error as Error).message).toContain('failed closed');
  });

  it('exposes the tui facet status for the limits it actually loaded', async () => {
    const startup = await startFirstPartyExtensions({
      ...options({ dir: true, manifest: MANIFEST_JSON }),
      limits: { maxTokens: 4096, maxToolCalls: 8 },
    });
    // The status text is rendered from the LOADED service — remove the tui
    // facet (or the provide/use round-trip) and this fails, not silently
    // degrades.
    expect(budgetStatusOf(startup)).toBe('budget: tokens≤4096 calls≤8');
    expect(startup.statusText).toBe('budget: tokens≤4096 calls≤8');
  });

  it('exposes the worker facet limit check against the loaded service', async () => {
    const startup = await startFirstPartyExtensions({
      ...options({ dir: true, manifest: MANIFEST_JSON }),
      limits: { maxTokens: 100, maxToolCalls: 2 },
    });
    expect(firstBreachedLimit(startup, { tokens: 101 })).toBe('tokens');
    expect(firstBreachedLimit(startup, { tokens: 50, toolCalls: 3 })).toBe(
      'toolCalls',
    );
    expect(firstBreachedLimit(startup, { tokens: 50, toolCalls: 2 })).toBe(
      undefined,
    );
  });

  it('refuses to render a status from a degraded startup object', async () => {
    const degraded = await loadFirstPartyBundle(options({ dir: false }));
    expect(() => budgetStatusOf(degraded)).toThrow(ExtensionStartupError);
    expect(() => firstBreachedLimit(degraded, { tokens: 1 })).toThrow(
      ExtensionStartupError,
    );
  });

  it('gates live tool calls through the loaded worker-facet limits', async () => {
    const startup = await startFirstPartyExtensions({
      ...options({ dir: true, manifest: MANIFEST_JSON }),
      limits: { maxToolCalls: 1 },
    });
    const gate = budgetToolGate(startup);
    expect(gate.id).toBe('extension-budget');
    const call = gate.wrap(async () => 'ran', 'read') as (
      ...args: unknown[]
    ) => Promise<string>;
    await expect(call()).resolves.toBe('ran');
    await expect(call()).rejects.toThrow(ExtensionBudgetError);
    await expect(call()).rejects.toThrow(/toolCalls/);
  });

  it('lets tool calls through when the loaded budget has no tool-call limit', async () => {
    const startup = await startFirstPartyExtensions(
      options({ dir: true, manifest: MANIFEST_JSON }),
    );
    const gate = budgetToolGate(startup);
    const call = gate.wrap(async () => 'ran', 'read') as (
      ...args: unknown[]
    ) => Promise<string>;
    await expect(call()).resolves.toBe('ran');
  });
});
