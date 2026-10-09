// Explicit --skill paths anchor at the invoking cwd: `rel/SKILL.md` loads
// relative to the cwd on BOTH lanes — `kubic run` (whose skill bridge is
// sessions-rooted) and `kubic tui` — and an unresolvable value warns on stderr
// without --debug. Live lanes with the faux provider (zero network, zero paid
// tokens) over real temp dirs; temp dirs are removed in `afterEach`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BACKGROUND_CONTEXT,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadlessPrompt } from './run/command.js';
import { bootTuiLane, type TuiLaneBoot, tuiBootOptions } from './tui-run.js';

const made: string[] = [];

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function writeSkill(cwd: string, rel: string, name: string): void {
  const dir = join(cwd, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\nBody.\n`,
  );
}

function fauxModels(texts: string[], captured: string[] = []): MutableModels {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    texts.map((text) => (context: unknown) => {
      const messages = (
        context as {
          messages?: readonly {
            role?: unknown;
            content?: unknown;
            sections?: Record<string, unknown>;
          }[];
        }
      ).messages;
      const system = messages?.find((message) => message.role === 'system');
      if (typeof system?.content === 'string') captured.push(system.content);
      for (const section of Object.values(system?.sections ?? {})) {
        if (typeof section === 'string' && section !== '') {
          captured.push(section);
        }
      }
      return fauxAssistantMessage(text);
    }),
  );
  return models;
}

async function promptOf(
  boot: TuiLaneBoot,
  captured: string[],
): Promise<string> {
  const outcome = await boot.loop?.runTurn('hi', {
    requestId: `skills-cwd-${captured.length}`,
    context: BACKGROUND_CONTEXT,
    whenBusy: 'reject',
  });
  expect(outcome?.kind).toBe('completed');
  return captured.at(-1) ?? '';
}

beforeEach(() => {
  vi.stubEnv('KUBIC_NO_NOTICE', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('explicit --skill paths anchor at the invoking cwd', () => {
  it('kubic run loads rel/SKILL.md from the cwd, not the sessions root', async () => {
    const home = tmpRoot('skills-cwd-home-');
    const cwd = tmpRoot('skills-cwd-work-');
    writeSkill(cwd, 'rel', 'relcwd');
    const debug: string[] = [];
    const result = await runHeadlessPrompt(
      'hi',
      { skills: ['rel/SKILL.md'] },
      {
        sessionsRoot: tmpRoot('skills-cwd-sessions-'),
        models: fauxModels(['done']),
        env: new NodeExecutionEnv(cwd),
        debug: (line: string) => debug.push(line),
        roles: { cwd },
        skills: { homeDir: home, cwd, trusted: false },
      },
    );
    expect(result.terminus).toBe('completed');
    // The sessions-rooted bridge must not shadow the cwd: the skill loads
    // from <cwd>/rel/SKILL.md.
    expect(debug.join('\n')).toContain('relcwd@cli');
  });

  it('kubic run warns on stderr for an unresolvable --skill without --debug', async () => {
    const home = tmpRoot('skills-cwd-home-');
    const cwd = tmpRoot('skills-cwd-work-');
    const warned: string[] = [];
    const result = await runHeadlessPrompt(
      'hi',
      { skills: ['ghost-skill'] },
      {
        sessionsRoot: tmpRoot('skills-cwd-sessions-'),
        models: fauxModels(['done']),
        env: new NodeExecutionEnv(cwd),
        // No debug sink: the warning must still surface.
        warn: (line: string) => warned.push(line),
        roles: { cwd },
        skills: { homeDir: home, cwd, trusted: false },
      },
    );
    expect(result.terminus).toBe('completed');
    expect(warned).toEqual(["skill skipped (unknown skill 'ghost-skill')"]);
  });

  it('kubic tui loads rel/SKILL.md from the cwd', async () => {
    const home = tmpRoot('skills-cwd-home-');
    const cwd = tmpRoot('skills-cwd-work-');
    writeSkill(cwd, 'rel', 'reltui');
    const captured: string[] = [];
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('skills-cwd-sessions-'),
      models: fauxModels(['done'], captured),
      env: new FakeExecutionEnv({}),
      skills: { homeDir: home, cwd, trusted: false },
      skillsList: ['rel/SKILL.md'],
    });
    const prompt = await promptOf(boot, captured);
    await boot.close?.();
    expect(prompt).toContain('<name>reltui</name>');
  });

  it('kubic tui queues an unresolvable --skill as a transcript notice', async () => {
    const home = tmpRoot('skills-cwd-home-');
    const cwd = tmpRoot('skills-cwd-work-');
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('skills-cwd-sessions-'),
      models: fauxModels(['done']),
      env: new FakeExecutionEnv({}),
      skills: { homeDir: home, cwd, trusted: false },
      skillsList: ['ghost-skill'],
    });
    const notices = boot.loop?.drainNotices?.() ?? [];
    await boot.close?.();
    expect(notices).toEqual([
      "warning: skill skipped (unknown skill 'ghost-skill')",
    ]);
  });

  it('the tui boot projection carries no warn channel: warnings stay off stderr', () => {
    const errors: string[] = [];
    const options = tuiBootOptions(
      { out: () => {}, err: (line: string) => errors.push(line) },
      { skillsList: ['ghost-skill'] },
      undefined,
    );
    expect(options).not.toHaveProperty('warn');
    expect(errors).toEqual([]);
  });
});

describe('settings skills from config on the tui lane', () => {
  it('kubic tui loads a settings skill dir with source settings', async () => {
    const home = tmpRoot('skills-settings-tui-home-');
    const cwd = tmpRoot('skills-settings-tui-work-');
    // Outside every discovery root: only the settings projection loads it.
    const settingsDir = tmpRoot('skills-settings-tui-dir-');
    writeSkill(settingsDir, 'team-helper', 'team-helper');
    const captured: string[] = [];
    const boot = await bootTuiLane(undefined, {
      sessionsRoot: tmpRoot('skills-settings-tui-sessions-'),
      models: fauxModels(['done'], captured),
      env: new FakeExecutionEnv({}),
      skills: {
        homeDir: home,
        cwd,
        trusted: false,
        settingsSkills: [join(settingsDir, 'team-helper')],
      },
    });
    const prompt = await promptOf(boot, captured);
    await boot.close?.();
    expect(prompt).toContain('<name>team-helper</name>');
    expect(prompt).toContain(
      `<filePath>${join(settingsDir, 'team-helper', 'SKILL.md')}</filePath>`,
    );
  });
});

describe('the role gate on the tui lane', () => {
  it('kubic tui withholds a skill outside the resolved role', async () => {
    const home = tmpRoot('skills-tui-gate-home-');
    const cwd = tmpRoot('skills-tui-gate-work-');
    const dir = join(cwd, '.agents', 'skills', 'impl-only');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: impl-only\ndescription: Implementers only\nroles: [implementer]\n---\n\nBody.\n',
    );
    const captured: string[] = [];
    const boot = await bootTuiLane(undefined, {
      role: 'reviewer',
      sessionsRoot: tmpRoot('skills-tui-gate-sessions-'),
      models: fauxModels(['done'], captured),
      env: new FakeExecutionEnv({}),
      skills: { homeDir: home, cwd, trusted: true },
    });
    const prompt = await promptOf(boot, captured);
    await boot.close?.();
    expect(prompt).not.toContain('<name>impl-only</name>');
  });
});
