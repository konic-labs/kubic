// The TUI's one-time skill warning notice: loader lines the
// TUI does not drop (a skipped skill) ride the boot notices once — stderr
// `warning: …` before the alt-screen opens — instead of vanishing. A clean
// boot stays silent. Real `bootTuiLane` over tmp dirs, faux models only:
// zero network, zero paid tokens; temp dirs removed in `afterEach`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModels,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { afterEach, describe, expect, it } from 'vitest';
import { bootTuiLane } from './tui/boot.js';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function fauxModels(): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return models;
}

async function bootNotices(cwd: string, home: string): Promise<string[]> {
  const booted = await bootTuiLane(undefined, {
    sessionsRoot: tmpRoot('kubic-tui-skills-sessions-'),
    models: fauxModels(),
    env: new NodeExecutionEnv(cwd),
    skills: { homeDir: home, cwd, trusted: false },
  });
  try {
    return [...(booted.notices ?? [])];
  } finally {
    await booted.close?.();
  }
}

describe('TUI skill warning notice', () => {
  it('names a skipped skill once instead of dropping it', async () => {
    const cwd = tmpRoot('kubic-tui-skills-cwd-');
    const dir = join(cwd, '.pi', 'skills', 'gem');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: gem\ndescription: Left out\n---\n\nBody.\n',
    );
    const notices = await bootNotices(cwd, tmpRoot('kubic-tui-skills-home-'));
    const skillNotice = notices.filter((line) => line.startsWith('skills:'));
    expect(skillNotice).toHaveLength(1);
    expect(skillNotice[0]).toMatchInlineSnapshot(
      `"skills: 1 skipped (1 excluded) — run \`kubic skills\` for every skill and why it was left out"`,
    );
  });

  it('stays silent on a clean boot', async () => {
    const notices = await bootNotices(
      tmpRoot('kubic-tui-skills-clean-'),
      tmpRoot('kubic-tui-skills-home-'),
    );
    expect(notices.filter((line) => line.startsWith('skills:'))).toEqual([]);
  });
});
