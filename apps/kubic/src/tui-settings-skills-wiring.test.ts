// The TUI boot hands the config `skills` projection to the orchestrator
// drive (issue #237, §29.2): workers spawned from `kubic tui` must load the
// same settings skills as CLI-spawned workers (prod-runners.ts), which the
// drive forwards into the manager lane. This boots the REAL `bootTuiLane`
// and captures what it hands the drive (the vi.mock capture pattern of
// tui-trust-wiring.test.ts).
//
// Faux provider only: zero network, zero paid tokens.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'kubic-237-tui-settings-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  captured.length = 0;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function settingsSkillFile(): string {
  const dir = join(tmpDir(), 'settings-skill');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(
    file,
    '---\nname: team\ndescription: Team skill\n---\n\nTeam content.\n',
  );
  return file;
}

async function bootWith(settingsSkills?: string[]): Promise<void> {
  const workspace = tmpDir();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const booted = await bootTuiLane(undefined, {
    sessionsRoot: tmpDir(),
    models,
    env: new NodeExecutionEnv(workspace),
    skills: {
      homeDir: workspace,
      cwd: workspace,
      trusted: false,
      ...(settingsSkills === undefined ? {} : { settingsSkills }),
    },
  });
  await booted.close?.();
}

describe('bootTuiLane hands the orchestrator drive the settings skills (issue #237)', () => {
  it('the configured settings skills reach the drive', async () => {
    const file = settingsSkillFile();
    await bootWith([file]);
    expect(captured).toHaveLength(1);
    expect((captured[0] as ProdTuiOrchestratorOptions).settingsSkills).toEqual([
      file,
    ]);
  });

  it('with no settings skills configured the option is left unset', async () => {
    await bootWith();
    expect(captured).toHaveLength(1);
    expect(
      (captured[0] as ProdTuiOrchestratorOptions).settingsSkills,
    ).toBeUndefined();
  });
});
