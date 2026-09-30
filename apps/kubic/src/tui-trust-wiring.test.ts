// The TUI boot hands its per-root project-trust check to the orchestrator
// drive (issue #228, §35.1): a `kubic trust` store grant must reach the
// manager's models assembly and every worker child (as the env opt-in), the
// same way `kubic orchestrate` does, decided per root. `createProdTuiOrchestrator`'s
// `projectTrust` is unit-tested in tui-orchestrator.test.ts, but dropping
// the wire in `bootTuiLane` would stay green there. This boots the REAL
// `bootTuiLane` and captures what it hands the drive (the vi.mock capture
// pattern of tui-merge-seat-wiring.test.ts).
//
// Faux provider only: zero network, zero paid tokens.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeExecutionEnv } from '../../../packages/exec/src/env.js';
import {
  createModels,
  fauxProvider,
} from '../../../packages/worker/src/pi-boundary.js';
import type { ProdTuiOrchestratorOptions } from './tui-orchestrator.js';
import { bootTuiLane } from './tui-run.js';

const captured: ProdTuiOrchestratorOptions[] = [];

vi.mock('./tui-orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tui-orchestrator.js')>();
  return {
    ...actual,
    createProdTuiOrchestrator: (options: ProdTuiOrchestratorOptions) => {
      captured.push(options);
      return actual.createProdTuiOrchestrator(options);
    },
  };
});

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kubic-228-tui-trust-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  captured.length = 0;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function boot(
  trustFor?: (workspace: string) => (path: string) => boolean,
): Promise<{ workspace: string }> {
  const workspace = tmpDir();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const booted = await bootTuiLane(undefined, {
    sessionsRoot: tmpDir(),
    models,
    env: new NodeExecutionEnv(workspace),
    skills: { homeDir: workspace, cwd: workspace, trusted: false },
    ...(trustFor === undefined ? {} : { trustProject: trustFor(workspace) }),
  });
  await booted.close?.();
  return { workspace };
}

describe('bootTuiLane hands the orchestrator drive the per-root project-trust check (issue #228)', () => {
  it('the TUI\u2019s own per-path check reaches the drive: a grant for the cwd never answers for another root', async () => {
    const asked: string[] = [];
    const { workspace } = await boot((granted) => (path) => {
      asked.push(path);
      return path === granted;
    });
    expect(captured).toHaveLength(1);
    const projectTrust = (captured[0] as ProdTuiOrchestratorOptions)
      .projectTrust;
    if (projectTrust === undefined) throw new Error('no trust check wired');
    // The exact-path decision, evaluated per root by the run: the granted
    // directory is trusted, its parent (the repo root) and a sibling are not.
    expect(projectTrust(workspace)).toBe(true);
    expect(projectTrust(join(workspace, '..'))).toBe(false);
    expect(projectTrust(join(workspace, 'other'))).toBe(false);
    expect(asked).toContain(workspace);
  });

  it('an undecided workspace is trusted nowhere', async () => {
    await boot(() => () => false);
    const projectTrust = (captured[0] as ProdTuiOrchestratorOptions)
      .projectTrust;
    expect(projectTrust?.('/anywhere')).toBe(false);
  });

  it('with no trust check wired the option is left unset', async () => {
    await boot();
    expect(captured).toHaveLength(1);
    expect(
      (captured[0] as ProdTuiOrchestratorOptions).projectTrust,
    ).toBeUndefined();
  });
});
