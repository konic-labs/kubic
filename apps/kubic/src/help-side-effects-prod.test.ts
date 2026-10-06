// Issue #245: `--help` is side-effect free, driven through the real
// dispatch seam with the production runners in a scratch git repository. A
// help request must print usage and exit 0 without writing the runtime
// exclude rules, building lane deps (the `extensions:` receipt) or touching
// the repo — the missing-bundle boot failure cannot be reached by help.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureRuntimeExcludeRules } from '../../../packages/exec/src/runtime-exclude.js';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
} from '../../../packages/exec/src/test-support/git-sandbox.js';
import { loadCliConfig } from './config-runtime.js';
import { dispatchCommand } from './dispatch.js';
import { createProdRunners } from './prod-runners.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

afterEach(() => {
  disposeAllGitSandboxes();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  // Real repo from the shared sandbox (issue #420): setup spawns run under
  // its scrubbed env, and it is injected into process.env so any git the
  // dispatch shells inherits the same scrubbed view (the per-run HOME stub
  // in kubic() only narrows further).
  const sandbox = createGitSandbox({ injectProcessEnv: true });
  const root = tmpRoot('kubic-help-');
  const git = (args: string[]): void => {
    sandbox.git(args, { cwd: root });
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'help@kubic.dev']);
  git(['config', 'user.name', 'kubic help']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(['add', 'base.txt']);
  git(['commit', '-m', 'base']);
  return root;
}

// One `kubic <command> <args>` through the shipped dispatch: the real
// config load, the real runtime-exclude writer and the prod runners.
async function kubic(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; lines: string[]; errs: string[] }> {
  const home = tmpRoot('kubic-help-home-');
  vi.stubEnv('HOME', home);
  vi.stubEnv('NO_COLOR', '1');
  const lines: string[] = [];
  const errs: string[] = [];
  const code = await dispatchCommand(command, args, {
    out: (line) => lines.push(line),
    err: (line) => errs.push(line),
    loadConfig: (input) =>
      loadCliConfig({
        cwd,
        home,
        env: {},
        ...(input?.model === undefined ? {} : { model: input.model }),
      }),
    version: () => '9.9.9',
    ensureRuntimeExclude: (entries) =>
      ensureRuntimeExcludeRules({ cwd, entries }),
    runners: createProdRunners({
      out: (line) => lines.push(line),
      debug: (line) => errs.push(line),
    }),
  });
  return { code, lines, errs };
}

describe('--help is side-effect free (issue #245)', () => {
  for (const command of ['run', 'tui', 'orchestrate']) {
    it(`kubic ${command} --help prints usage, writes no exclude rules and loads no extensions`, async () => {
      const cwd = repo();
      const exclude = join(cwd, '.git', 'info', 'exclude');
      const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null;

      const { code, lines, errs } = await kubic(command, ['--help'], cwd);

      expect(code).toBe(0);
      expect(lines.join('\n')).toContain(`Usage: kubic ${command}`);
      // No lane boot: the extension receipt is a run-only diagnostic.
      expect([...lines, ...errs].join('\n')).not.toContain('extensions:');
      const after = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null;
      expect(after).toBe(before);
      // The repo is untouched otherwise: nothing was staged or created.
      expect(existsSync(join(cwd, '.kubic'))).toBe(false);
    });
  }

  it('kubic orchestrate --help works where the bundle boot would fail closed', async () => {
    // The help path never builds the manager deps, so the missing-bundle
    // failure the boot raises (`fails closed at manager startup when the
    // bundle dir is gone`, extensions-startup-prod.test.ts) is unreachable
    // by a help request: usage prints, nothing is killed or written.
    const cwd = repo();
    const { code, lines, errs } = await kubic('orchestrate', ['-h'], cwd);
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/^Usage: kubic orchestrate/);
    expect(errs).toEqual([]);
    expect(existsSync(join(cwd, '.kubic'))).toBe(false);
  });

  it('a non-help invocation still ships the runtime exclude rules', async () => {
    // The counterpart pin: the help skip must not disable the write for
    // real invocations. `kubic run --nope` is a usage error, but the
    // exclude step runs before commander answers — so the rules land.
    const cwd = repo();
    const exclude = join(cwd, '.git', 'info', 'exclude');
    const before = readFileSync(exclude, 'utf8');
    const { code } = await kubic('run', ['--nope'], cwd);
    expect(code).toBe(2);
    const after = readFileSync(exclude, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('.kubic/orchestrator/');
  });
});
