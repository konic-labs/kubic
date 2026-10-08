// `kubic skills` handler tests: the listing shows every
// source and status, `--role` withholds like the lane, `--json` matches
// the fixture shape, and a refusing `--role` fails closed. Real tmp dirs
// through the node bridge (no git, no network); temp dirs removed in
// `afterEach`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import { afterEach, describe, expect, it } from 'vitest';
import { selectRole } from './roles/roles-boot.js';
import { runSkillsCommand, type SkillsCommandDeps } from './skills-cli.js';

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

function writeSkillMd(dir: string, frontmatter: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody.\n`);
}

interface Captured {
  out: string[];
  info: string[];
  warn: string[];
  error: string[];
  success: string[];
}

function depsOver(
  cwd: string,
  home: string,
  trusted: boolean,
): {
  deps: SkillsCommandDeps;
  captured: Captured;
} {
  const captured: Captured = {
    out: [],
    info: [],
    warn: [],
    error: [],
    success: [],
  };
  const deps: SkillsCommandDeps = {
    out: (line: string) => captured.out.push(line),
    logger: {
      info: (line: string) => captured.info.push(line),
      warn: (line: string) => captured.warn.push(line),
      error: (line: string) => captured.error.push(line),
      success: (line: string) => captured.success.push(line),
    },
    base: {
      bridge: createNodeFileBridge(cwd),
      cwd,
      homeDir: home,
      trusted,
    },
  };
  return { deps, captured };
}

describe('runSkillsCommand', () => {
  it('lists user/project/settings sources and hidden skills', () => {
    const home = tmpRoot('kubic-skills-home-');
    const cwd = tmpRoot('kubic-skills-cwd-');
    writeSkillMd(
      join(home, '.agents', 'skills', 'lint'),
      'name: lint\ndescription: Lint skill',
    );
    writeSkillMd(
      join(cwd, '.pi', 'skills', 'gem'),
      'name: gem\ndescription: Project skill',
    );
    const settingsDir = join(tmpRoot('kubic-skills-settings-'), 'team');
    writeSkillMd(settingsDir, 'name: team\ndescription: Team skill');
    const { deps, captured } = depsOver(cwd, home, true);
    const code = runSkillsCommand(
      {},
      {
        ...deps,
        base: { ...deps.base, settingsSkills: [settingsDir] },
      },
    ).exitCode;
    expect(code).toBe(0);
    const text = captured.out.join('\n');
    expect(text).toContain('lint');
    expect(text).toContain('user');
    expect(text).toContain('gem');
    expect(text).toContain('project');
    expect(text).toContain('team');
    expect(text).toContain('settings');
    expect(text).toContain('visible');
  });

  it('marks disable-model-invocation skills hidden', () => {
    const home = tmpRoot('kubic-skills-home-');
    const cwd = tmpRoot('kubic-skills-cwd-');
    writeSkillMd(
      join(home, '.agents', 'skills', 'quiet'),
      'name: quiet\ndescription: Helper\ndisable-model-invocation: true',
    );
    const { deps, captured } = depsOver(cwd, home, false);
    expect(runSkillsCommand({}, deps).exitCode).toBe(0);
    expect(captured.out.join('\n')).toContain('hidden');
  });

  it('shows untrusted project skills as excluded with the reason', () => {
    const home = tmpRoot('kubic-skills-home-');
    const cwd = tmpRoot('kubic-skills-cwd-');
    writeSkillMd(
      join(cwd, '.pi', 'skills', 'gem'),
      'name: gem\ndescription: Left out',
    );
    const { deps, captured } = depsOver(cwd, home, false);
    expect(runSkillsCommand({}, deps).exitCode).toBe(0);
    const text = captured.out.join('\n');
    expect(text).toContain('gem');
    expect(text).toContain('excluded');
    expect(text).toContain('untrusted');
  });

  it('--role marks role-withheld skills as withheld', () => {
    const home = tmpRoot('kubic-skills-home-');
    const cwd = tmpRoot('kubic-skills-cwd-');
    writeSkillMd(
      join(home, '.agents', 'skills', 'deploy'),
      'name: deploy\ndescription: Deploy\nroles: [implementer]',
    );
    const { deps, captured } = depsOver(cwd, home, false);
    const code = runSkillsCommand(
      { role: 'reviewer' },
      {
        ...deps,
        resolveRole: (name: string) => ({ name }),
      },
    ).exitCode;
    expect(code).toBe(0);
    const text = captured.out.join('\n');
    expect(text).toContain('deploy');
    expect(text).toContain('withheld');
    expect(text).toContain("not visible to role 'reviewer'");
  });

  it('--json parses and matches the fixture shape', () => {
    const home = tmpRoot('kubic-skills-home-');
    const cwd = tmpRoot('kubic-skills-cwd-');
    writeSkillMd(
      join(home, '.agents', 'skills', 'lint'),
      'name: lint\ndescription: Lint skill',
    );
    writeSkillMd(
      join(cwd, '.pi', 'skills', 'gem'),
      'name: gem\ndescription: Left out',
    );
    const { deps, captured } = depsOver(cwd, home, false);
    expect(runSkillsCommand({ json: true }, deps).exitCode).toBe(0);
    const parsed: unknown = JSON.parse(captured.out.join('\n'));
    expect(parsed).toEqual([
      {
        name: 'gem',
        source: 'project',
        path: `${cwd}/.pi/skills/gem/SKILL.md`,
        status: 'excluded',
        reason: expect.stringContaining('untrusted'),
      },
      {
        name: 'lint',
        source: 'user',
        path: `${home}/.agents/skills/lint/SKILL.md`,
        status: 'visible',
      },
    ]);
  });

  it('a refusing --role fails closed with its reason', () => {
    const home = tmpRoot('kubic-skills-home-');
    const cwd = tmpRoot('kubic-skills-cwd-');
    const { deps, captured } = depsOver(cwd, home, false);
    const code = runSkillsCommand(
      { role: 'nope' },
      {
        ...deps,
        resolveRole: () => {
          throw new Error("unknown role 'nope'");
        },
      },
    ).exitCode;
    expect(code).toBe(1);
    expect(captured.error.join('\n')).toContain("unknown role 'nope'");
  });

  it('resolves --role through the real selectRole (builtin preset)', () => {
    const home = tmpRoot('kubic-skills-home-');
    const cwd = tmpRoot('kubic-skills-cwd-');
    writeSkillMd(
      join(home, '.agents', 'skills', 'deploy'),
      'name: deploy\ndescription: Deploy\nroles: [implementer]',
    );
    const { deps, captured } = depsOver(cwd, home, false);
    const code = runSkillsCommand(
      { role: 'implementer' },
      {
        ...deps,
        resolveRole: (name: string) => {
          const selected = selectRole({
            bridge: createNodeFileBridge(cwd),
            cwd,
            role: name,
            projectRoot: cwd,
            trustProject: () => false,
          });
          return {
            name: selected.resolved.name,
            ...(selected.doc.skills === undefined
              ? {}
              : { skills: selected.doc.skills }),
            classes: selected.resolved.classes,
          };
        },
      },
    ).exitCode;
    expect(code).toBe(0);
    const text = captured.out.join('\n');
    expect(text).toContain('deploy');
    expect(text).toContain('visible');
  });

  it('says so when nothing was discovered', () => {
    const home = tmpRoot('kubic-skills-home-');
    const cwd = tmpRoot('kubic-skills-cwd-');
    const { deps, captured } = depsOver(cwd, home, false);
    expect(runSkillsCommand({}, deps).exitCode).toBe(0);
    expect(captured.info.join('\n')).toContain('no skills discovered');
  });
});
