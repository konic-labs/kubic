// `kubic trust --list` reports every recorded decision from anywhere: a
// subdirectory of a project is where a run usually happens, and the runner
// must not hand the list a path of its own. Grants and revokes from a
// subdirectory still land at the project root. Tmp dirs only.
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CliUsageError } from '@kubic/core/cli/exit-codes';
import { ProjectTrustStore, projectTrustStorePath } from '@kubic/host/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { loadCliConfig } from '../../src/config/load.js';
import { trustRunner } from '../../src/runners/setup.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// A project whose root holds `.kubic/`, and a subdirectory to run from.
function project(): { home: string; root: string; sub: string } {
  const home = tempDir('trust-list-home-');
  const root = tempDir('trust-list-repo-');
  mkdirSync(join(root, '.kubic'));
  const sub = join(root, 'apps');
  mkdirSync(sub);
  return { home, root, sub };
}

async function runFrom(
  cwd: string,
  home: string,
  options: { list?: boolean; revoke?: boolean; path?: string },
): Promise<{ code: number; lines: string[] }> {
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const lines: string[] = [];
  const runner = trustRunner({
    out: (line) => lines.push(line),
    debug: () => undefined,
  });
  try {
    const result = await runner(options, loadCliConfig({ home, cwd, env: {} }));
    return { code: result.exitCode, lines };
  } catch (error) {
    // The front door turns a usage error into exit 2.
    if (error instanceof CliUsageError) return { code: 2, lines };
    throw error;
  }
}

describe('kubic trust --list', () => {
  it('reports from the project root and from a subdirectory alike', async () => {
    const { home, root, sub } = project();
    new ProjectTrustStore(projectTrustStorePath(home)).set(root, true);
    for (const cwd of [root, sub]) {
      const { code, lines } = await runFrom(cwd, home, { list: true });
      expect(code, cwd).toBe(0);
      expect(lines.join('\n')).toContain(`trusted  ${realpathSync(root)}`);
    }
  });

  it('still refuses an explicit path', async () => {
    const { home, sub } = project();
    expect((await runFrom(sub, home, { list: true, path: sub })).code).toBe(2);
  });

  it('revokes at the project root from a subdirectory', async () => {
    const { home, root, sub } = project();
    const store = new ProjectTrustStore(projectTrustStorePath(home));
    store.set(root, true);
    expect((await runFrom(sub, home, { revoke: true })).code).toBe(0);
    expect(store.entries()).toEqual([]);
  });
});
