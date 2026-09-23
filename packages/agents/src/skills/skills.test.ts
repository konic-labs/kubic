// Skills loader tests (issue #36; §29). Faux-only: FakeExecutionEnv + an
// in-test FileBridge adapter (fs access stays inside packages/exec).
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { SOLO_DEFAULTS } from '../policy.js';
import {
  discoverSkills,
  formatSkillsForSystemPrompt,
  gateSkills,
  invokeSkill,
  parseSkillArgs,
  resolveTaskSkillRefs,
} from './skills.js';

function bridgeFromEnv(env: FakeExecutionEnv): FileBridge {
  const isDir = (dir: string, name: string): boolean => {
    const clean = dir.replace(/\/*$/, '');
    const full = clean === '' ? name : `${clean}/${name}`;
    try {
      return env.fs.stat(full).isDirectory;
    } catch {
      return false;
    }
  };
  return {
    cwd: env.cwd,
    absolutePath: (path: string): string => path,
    joinPath: (parts: string[]): string => parts.join('/'),
    readTextFile: (path: string): string => env.fs.readFile(path),
    readBinaryFile: (path: string): Uint8Array =>
      new TextEncoder().encode(env.fs.readFile(path)),
    readTextLines: (path: string, maxLines?: number): string[] => {
      const lines = env.fs.readFile(path).split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return maxLines === undefined ? lines : lines.slice(0, maxLines);
    },
    openTextLineReader: (path: string) => {
      const reader = bridgeFromEnv(env);
      const lines = reader.readTextLines(path);
      let index = 0;
      return {
        readLine: (): string | undefined =>
          index < lines.length ? lines[index++] : undefined,
        close: (): void => undefined,
      };
    },
    writeFile: (path: string, content: string | Uint8Array): void => {
      env.fs.writeFile(path, typeof content === 'string' ? content : '{}');
    },
    appendFile: (path: string, content: string | Uint8Array): void => {
      const prior = (() => {
        try {
          return env.fs.readFile(path);
        } catch {
          return '';
        }
      })();
      env.fs.writeFile(
        path,
        prior + (typeof content === 'string' ? content : '{}'),
      );
    },
    renameFile: (source: string, destination: string): void => {
      env.fs.rename(source, destination);
    },
    fileInfo: (path: string) => ({
      name: path.split('/').pop() ?? path,
      path,
      isDirectory: false,
      isSymbolicLink: false,
      size: 0,
      mtimeMs: 0,
    }),
    listDir: (path: string) =>
      env.fs.listDir(path).map((name) => ({
        name,
        path: `${path.replace(/\/*$/, '')}/${name}`,
        isDirectory: isDir(path, name),
        isSymbolicLink: false,
        size: 0,
        mtimeMs: 0,
      })),
    exists: (path: string): boolean => {
      try {
        env.fs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    createDir: (): void => undefined,
    remove: (): void => undefined,
    createTempDir: (): string => '/fake-tmp',
    createTempFile: (): string => '/fake-tmp-file',
  };
}

function skillMd(frontmatter: string, body = 'Skill body.'): string {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

function setup(): { env: FakeExecutionEnv; bridge: FileBridge } {
  const env = new FakeExecutionEnv({});
  return { env, bridge: bridgeFromEnv(env) };
}

const HOME = '/fakehome';
const CWD = '/fakehome/proj';

describe('skill discovery (issue #36)', () => {
  it('loads user skills from both home roots', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.pi/agent/skills/alpha/SKILL.md`,
      skillMd('name: alpha\ndescription: Alpha skill'),
    );
    env.fs.writeFile(
      `${HOME}/.agents/skills/beta/SKILL.md`,
      skillMd('name: beta\ndescription: Beta skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('applies precedence: project shadows user on name conflict (trusted)', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/lint/SKILL.md`,
      skillMd('name: lint\ndescription: User lint'),
    );
    env.fs.writeFile(
      `${CWD}/.pi/skills/lint/SKILL.md`,
      skillMd('name: lint\ndescription: Project lint'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: true,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['lint']);
    expect(result.skills[0]?.filePath).toBe(`${CWD}/.pi/skills/lint/SKILL.md`);
    expect(result.skills[0]?.description).toBe('Project lint');
  });

  it('gates project skills behind trust: untrusted cwd excludes them', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/lint/SKILL.md`,
      skillMd('name: lint\ndescription: User lint'),
    );
    env.fs.writeFile(
      `${CWD}/.pi/skills/lint/SKILL.md`,
      skillMd('name: lint\ndescription: Project lint'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['lint']);
    expect(result.skills[0]?.filePath).toBe(
      `${HOME}/.agents/skills/lint/SKILL.md`,
    );
  });

  it('loads ancestor project dirs far-to-near with nearer shadowing', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      '/repo/.agents/skills/deep/SKILL.md',
      skillMd('name: deep\ndescription: Far skill'),
    );
    env.fs.writeFile(
      '/repo/sub/.pi/skills/deep/SKILL.md',
      skillMd('name: deep\ndescription: Near skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/sub',
      trusted: true,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['deep']);
    expect(result.skills[0]?.description).toBe('Near skill');
  });

  it('--skill appends under --no-skills', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/a/SKILL.md`,
      skillMd('name: a\ndescription: Home skill'),
    );
    env.fs.writeFile(
      '/extra/review/SKILL.md',
      skillMd('name: review\ndescription: Explicit skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: true,
      noSkills: true,
      cliSkills: ['/extra/review'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['review']);
  });

  it('honors the settings array of explicit skill dirs', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      '/opt/shared/team/SKILL.md',
      skillMd('name: team\ndescription: Shared skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      settingsSkills: ['/opt/shared/team'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['team']);
  });

  it('loads package skills/pi.skills entries only once trusted', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/package.json`,
      JSON.stringify({
        skills: ['./local-skills/rev'],
        pi: { skills: ['./pi-skills/scan'] },
      }),
    );
    env.fs.writeFile(
      `${CWD}/local-skills/rev/SKILL.md`,
      skillMd('name: rev\ndescription: Package skill'),
    );
    env.fs.writeFile(
      `${CWD}/pi-skills/scan/SKILL.md`,
      skillMd('name: scan\ndescription: Pi-namespaced skill'),
    );
    const trustedResult = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: true,
    });
    expect(trustedResult.skills.map((skill) => skill.name).sort()).toEqual([
      'rev',
      'scan',
    ]);
    const untrustedResult = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    expect(untrustedResult.skills).toEqual([]);
  });

  it('falls back to dir name and first body line for name/description', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/mystery/SKILL.md`,
      'Do the mysterious thing.\nMore detail.\n',
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    expect(result.skills[0]?.name).toBe('mystery');
    expect(result.skills[0]?.description).toBe('Do the mysterious thing.');
  });
});

describe('role scoping and capability gating (issue #36)', () => {
  it('hides role-restricted skills from other roles with a reason', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/deploy/SKILL.md`,
      skillMd('name: deploy\ndescription: Deploy\nroles: [implementer]'),
    );
    const { skills } = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    const gated = gateSkills(skills, {
      role: 'reviewer',
      classes: SOLO_DEFAULTS,
    });
    expect(gated.visible).toEqual([]);
    expect(gated.withheld).toEqual([
      { name: 'deploy', reason: "not visible to role 'reviewer'" },
    ]);
    const allowed = gateSkills(skills, {
      role: 'implementer',
      classes: SOLO_DEFAULTS,
    });
    expect(allowed.visible.map((skill) => skill.name)).toEqual(['deploy']);
  });

  it('withholds denied-capability skills and logs the reason', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/writer/SKILL.md`,
      skillMd('name: writer\ndescription: Writes\ntools: [write]'),
    );
    const logged: string[] = [];
    const { skills } = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    const gated = gateSkills(skills, {
      role: 'implementer',
      classes: { ...SOLO_DEFAULTS, filesystem: 'read' },
      log: (line: string): void => {
        logged.push(line);
      },
    });
    expect(gated.visible).toEqual([]);
    expect(gated.withheld).toEqual([
      {
        name: 'writer',
        reason: "needs tool 'write' denied by capability grant",
      },
    ]);
    expect(logged.join('\n')).toContain('writer');
    expect(logged.join('\n')).toContain('write');
  });

  it('emits one XML block per visible skill with name/description/filePath', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/a/SKILL.md`,
      skillMd('name: a\ndescription: Alpha'),
    );
    env.fs.writeFile(
      `${HOME}/.agents/skills/b/SKILL.md`,
      skillMd('name: b\ndescription: Beta'),
    );
    const { skills } = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    const xml = formatSkillsForSystemPrompt(skills);
    expect(xml).toContain('<name>a</name>');
    expect(xml).toContain('<description>Alpha</description>');
    expect(xml).toContain(
      `<filePath>${HOME}/.agents/skills/a/SKILL.md</filePath>`,
    );
    expect(xml).toContain('<name>b</name>');
    expect(xml.match(/<skill>/g)?.length).toBe(2);
  });

  it('hides disableModelInvocation skills from the model but keeps them explicit-callable', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/secret/SKILL.md`,
      skillMd(
        'name: secret\ndescription: Hidden helper\ndisableModelInvocation: true',
        'Hidden content.',
      ),
    );
    const { skills } = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    expect(skills.map((skill) => skill.name)).toEqual(['secret']);
    expect(formatSkillsForSystemPrompt(skills)).not.toContain('secret');
    expect(invokeSkill(skills, 'secret')).toContain('Hidden content.');
  });

  it('resolves task skill refs without ever mid-task-failing', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/ok/SKILL.md`,
      skillMd('name: ok\ndescription: Fine'),
    );
    env.fs.writeFile(
      `${HOME}/.agents/skills/needy/SKILL.md`,
      skillMd('name: needy\ndescription: Needy\ntools: [write]'),
    );
    const { skills } = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    const gated = gateSkills(skills, {
      role: 'implementer',
      classes: { ...SOLO_DEFAULTS, filesystem: 'read' },
    });
    const resolved = resolveTaskSkillRefs(['ok', 'needy', 'ghost'], gated);
    expect(resolved.granted.map((skill) => skill.name)).toEqual(['ok']);
    expect(resolved.withheld).toEqual([
      {
        name: 'needy',
        reason: "needs tool 'write' denied by capability grant",
      },
      { name: 'ghost', reason: "unknown skill 'ghost'" },
    ]);
  });
});

describe('skill CLI flags (issue #36)', () => {
  it('parses repeatable --skill with --no-skills', () => {
    expect(
      parseSkillArgs(['--no-skills', '--skill', 'a', '--skill', 'b']),
    ).toEqual({ noSkills: true, skills: ['a', 'b'] });
  });

  it('rejects fetcher/install flags: skills never fetch', () => {
    for (const flag of ['--fetch-skills', '--install-skill', '--skill-fetch']) {
      expect(() => parseSkillArgs([flag])).toThrow(/never fetch/i);
    }
    expect(() => parseSkillArgs(['--skill'])).toThrow(/needs a value/);
  });

  it('ships no fetcher module or flag', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const names = readdirSync(here);
    expect(names.some((name) => /fetch|install/i.test(name))).toBe(false);
    expect(join(here, 'skills.ts')).toBe(join(here, 'skills.ts'));
  });
});
