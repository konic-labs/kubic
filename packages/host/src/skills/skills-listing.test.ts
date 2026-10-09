// The `kubic skills` listing core: one row per skill with
// its status and reason, the doctor counts line, and the TUI's one-time
// boot notice. Pure data in, pure data out — no bridge, no network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import {
  type BootSkills,
  bootSkills,
  describeSkillSkips,
  offeredSkillNames,
  skillsDoctorProbe,
  skillsDoctorSummary,
  summarizeSkills,
} from './skills-boot.js';

function booted(): BootSkills {
  return {
    skills: [
      {
        name: 'rev',
        description: 'Package skill',
        filePath: '/repo/pkg/rev/SKILL.md',
        source: 'package',
        content: 'Body.',
      },
      {
        name: 'quiet',
        description: 'Hidden helper',
        filePath: '/home/u/.agents/skills/quiet/SKILL.md',
        source: 'user',
        disableModelInvocation: true,
        content: 'Body.',
      },
      {
        name: 'deploy',
        description: 'Deploy skill',
        filePath: '/repo/.pi/skills/deploy/SKILL.md',
        source: 'project',
        roles: ['implementer'],
        content: 'Body.',
      },
    ],
    block: undefined,
    // Admitted + gate-passed, hidden included, withheld
    // excluded — `quiet` stays (invocation-only), `deploy` does not.
    invocable: [
      {
        name: 'rev',
        description: 'Package skill',
        filePath: '/repo/pkg/rev/SKILL.md',
        source: 'package',
        content: 'Body.',
      },
      {
        name: 'quiet',
        description: 'Hidden helper',
        filePath: '/home/u/.agents/skills/quiet/SKILL.md',
        source: 'user',
        disableModelInvocation: true,
        content: 'Body.',
      },
    ],
    hidden: ['quiet'],
    withheld: [{ name: 'deploy', reason: "not visible to role 'reviewer'" }],
    unknownSkills: [],
    skipped: [
      {
        name: 'evil',
        filePath: '/abs/elsewhere/evil/SKILL.md',
        source: 'package',
        status: 'excluded',
        reason:
          "package skill '/abs/elsewhere/evil' outside trusted root '/repo'",
      },
      {
        name: 'broken',
        filePath: '/home/u/.agents/skills/broken/SKILL.md',
        source: 'user',
        status: 'error',
        reason: 'unreadable /home/u/.agents/skills/broken/SKILL.md',
      },
    ],
    readRoots: [],
  };
}

describe('summarizeSkills', () => {
  it('maps every skill to visible/hidden/withheld/excluded/error with reasons', () => {
    expect(summarizeSkills(booted())).toEqual([
      {
        name: 'broken',
        source: 'user',
        path: '/home/u/.agents/skills/broken/SKILL.md',
        status: 'error',
        reason: 'unreadable /home/u/.agents/skills/broken/SKILL.md',
      },
      {
        name: 'deploy',
        source: 'project',
        path: '/repo/.pi/skills/deploy/SKILL.md',
        status: 'withheld',
        reason: "not visible to role 'reviewer'",
      },
      {
        name: 'evil',
        source: 'package',
        path: '/abs/elsewhere/evil/SKILL.md',
        status: 'excluded',
        reason:
          "package skill '/abs/elsewhere/evil' outside trusted root '/repo'",
      },
      {
        name: 'quiet',
        source: 'user',
        path: '/home/u/.agents/skills/quiet/SKILL.md',
        status: 'hidden',
        reason: expect.stringContaining('disable-model-invocation'),
      },
      {
        name: 'rev',
        source: 'package',
        path: '/repo/pkg/rev/SKILL.md',
        status: 'visible',
      },
    ]);
  });
});

describe('skillsDoctorSummary', () => {
  it('reports counts and warns on errors, never fails', () => {
    const summary = skillsDoctorSummary(booted());
    expect(summary.id).toBe('skills');
    expect(summary.status).toBe('warn');
    expect(summary.detail).toBe('3 loaded, 1 hidden, 1 withheld, 1 errors');
  });

  it('passes clean with no errors', () => {
    const clean: BootSkills = {
      ...booted(),
      skipped: [],
      withheld: [],
      hidden: [],
    };
    const summary = skillsDoctorSummary(clean);
    expect(summary.status).toBe('pass');
    expect(summary.detail).toBe('3 loaded, 0 hidden, 0 withheld, 0 errors');
  });
});

describe('describeSkillSkips', () => {
  it('returns undefined when nothing was skipped', () => {
    expect(describeSkillSkips([])).toBeUndefined();
  });

  it('names the counts in one line', () => {
    expect(describeSkillSkips(booted().skipped)).toBe(
      'skills: 2 skipped (1 error, 1 excluded) — run `kubic skills` for every skill and why it was left out',
    );
  });
});

function writeSkill(home: string, cwd: string): void {
  const dir = join(cwd, '.pi', 'skills', 'gem');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: gem\ndescription: Left out\n---\n\nBody.\n',
  );
  void home;
}

describe('skillsDoctorProbe carries the counts line first', () => {
  it('summary first, then the per-skill warns', () => {
    const home = tempDir('kubic-skills-home-');
    const cwd = tempDir('kubic-skills-cwd-');
    writeSkill(home, cwd);
    const checks = skillsDoctorProbe({
      bridge: createNodeFileBridge(cwd),
      cwd,
      homeDir: home,
      trusted: false,
    });
    expect(checks[0]).toMatchObject({ id: 'skills', status: 'pass' });
    expect(checks[0]?.detail).toContain('loaded');
  });
});

describe('bootSkills passes discovery skips through', () => {
  it('an untrusted project skill reaches the listing as excluded', () => {
    const cwd = tempDir('kubic-skills-skipped-');
    const dir = join(cwd, '.pi', 'skills', 'gem');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: gem\ndescription: Left out\n---\n\nBody.\n',
    );
    const home = tempDir('kubic-skills-home-');
    const result = bootSkills({
      bridge: createNodeFileBridge(cwd),
      cwd,
      homeDir: home,
      trusted: false,
    });
    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([
      {
        name: 'gem',
        filePath: `${cwd}/.pi/skills/gem/SKILL.md`,
        source: 'project',
        status: 'excluded',
        reason: expect.stringContaining('untrusted'),
      },
    ]);
  });
});

describe('offeredSkillNames', () => {
  it('names the skills the run offered: neither withheld nor hidden', () => {
    // `deploy` is withheld by the role gate and `quiet` hides itself from
    // the model: a trajectory's resources name only `rev`.
    expect(offeredSkillNames(booted())).toEqual(['rev']);
  });
});

describe('an explicit --skill in the listing', () => {
  it('lists a --skill path as a visible row of source cli', () => {
    const cwd = tempDir('kubic-skills-cli-');
    const dir = join(cwd, 'extra', 'lint');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: lint\ndescription: Lint rules\n---\n\nBody.\n',
    );
    const result = bootSkills({
      bridge: createNodeFileBridge(cwd),
      cwd,
      homeDir: tempDir('kubic-skills-home-'),
      trusted: false,
      cliSkills: ['./extra/lint'],
    });
    expect(summarizeSkills(result)).toEqual([
      {
        name: 'lint',
        source: 'cli',
        path: `${cwd}/extra/lint/SKILL.md`,
        status: 'visible',
      },
    ]);
  });
});
