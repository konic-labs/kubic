// Skills loader tests. Faux-only: FakeExecutionEnv + an
// in-test FileBridge adapter (fs access stays inside packages/exec).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileBridge } from '@kubic/exec/file-bridge';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS } from '../permissions.js';
import { CWD, HOME, setup, skillMd } from '../test-support/skills-env.js';
import { discoverSkills } from './discover.js';
import { parseSkillFile } from './frontmatter.js';
import { gateSkills } from './gate.js';
import { formatSkillsForSystemPrompt, invokeSkill } from './prompt.js';

describe('skipped-skill reporting', () => {
  it('names untrusted project skills as excluded with the reason', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/.pi/skills/hidden-gem/SKILL.md`,
      skillMd('name: hidden-gem\ndescription: Left out'),
    );
    const lines: string[] = [];
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([
      {
        name: 'hidden-gem',
        filePath: `${CWD}/.pi/skills/hidden-gem/SKILL.md`,
        source: 'project',
        status: 'excluded',
        reason: expect.stringContaining('untrusted'),
      },
    ]);
    expect(lines.some((line) => /untrusted cwd/.test(line))).toBe(true);
  });

  it('excludes only the untrusted ancestors under per-path trust', () => {
    const { env, bridge } = setup();
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    env.fs.writeFile(
      '/repo/.pi/skills/far/SKILL.md',
      skillMd('name: far\ndescription: Far skill'),
    );
    env.fs.writeFile(
      '/repo/pkg/.pi/skills/near/SKILL.md',
      skillMd('name: near\ndescription: Near skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/pkg',
      trusted: false,
      trustProject: (dir) => dir === '/repo/pkg',
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['near']);
    expect(result.skipped).toEqual([
      {
        name: 'far',
        filePath: '/repo/.pi/skills/far/SKILL.md',
        source: 'project',
        status: 'excluded',
        reason: expect.stringContaining('/repo'),
      },
    ]);
  });

  it('reports an unreadable SKILL.md as an error with its reason', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/broken/SKILL.md`,
      skillMd('name: broken\ndescription: Unreadable'),
    );
    const unreadable: FileBridge = {
      ...bridge,
      readTextFile: (path: string): string => {
        if (path.endsWith('/broken/SKILL.md')) throw new Error('EACCES');
        return bridge.readTextFile(path);
      },
    };
    const lines: string[] = [];
    const result = discoverSkills({
      bridge: unreadable,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([
      {
        name: 'broken',
        filePath: `${HOME}/.agents/skills/broken/SKILL.md`,
        source: 'user',
        status: 'error',
        reason: expect.stringContaining('unreadable'),
      },
    ]);
    expect(lines.some((line) => /unreadable/.test(line))).toBe(true);
  });

  it('reports confined-away package entries as excluded skips', () => {
    const { env, bridge } = setup();
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    env.fs.writeFile(
      '/repo/pkg/package.json',
      JSON.stringify({ skills: ['/abs/elsewhere/evil'] }),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/pkg',
      trusted: true,
    });
    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([
      {
        name: 'evil',
        filePath: '/abs/elsewhere/evil/SKILL.md',
        source: 'package',
        status: 'excluded',
        reason: expect.stringContaining('outside trusted root'),
      },
    ]);
  });
});

describe('role scoping and capability gating', () => {
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
      classes: DEFAULT_PERMISSIONS,
    });
    expect(gated.visible).toEqual([]);
    expect(gated.withheld).toEqual([
      { name: 'deploy', reason: "not visible to role 'reviewer'" },
    ]);
    const allowed = gateSkills(skills, {
      role: 'implementer',
      classes: DEFAULT_PERMISSIONS,
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
      classes: { ...DEFAULT_PERMISSIONS, filesystem: 'read' },
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

  // No role on the lane means no role scoping — the
  // capability check alone decides, so a plain run keeps role-scoped
  // skills it can actually run.
  it('skips role scoping when the lane booted with no role', () => {
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
    const gated = gateSkills(skills, { classes: DEFAULT_PERMISSIONS });
    expect(gated.visible.map((skill) => skill.name)).toEqual(['deploy']);
    expect(gated.withheld).toEqual([]);
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
      classes: { ...DEFAULT_PERMISSIONS, filesystem: 'read' },
    });
    expect(gated.visible.map((skill) => skill.name)).toEqual(['ok']);
    expect(gated.withheld).toEqual([
      expect.objectContaining({
        name: 'needy',
        reason: "needs tool 'write' denied by capability grant",
      }),
    ]);
  });
});

describe('skill CLI flags', () => {
  it('ships no fetcher module or flag', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const names = readdirSync(here);
    // Non-vacuity: the listing is the real skills dir.
    expect(names).toContain('discover.ts');
    expect(names.some((name) => /fetch|install/i.test(name))).toBe(false);
    // And no skills module has a network path to fetch through.
    const modules = names.filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    for (const name of modules) {
      const source = readFileSync(join(here, name), 'utf8');
      expect(source).not.toMatch(/\bfetch\(|node:https?\b|node:net\b/);
    }
  });
});

// Frontmatter + explicit-skill hardening: every parse branch
// pinned so a dropped quote style or gate fails loudly.
describe('skill frontmatter hardening', () => {
  it('parses single- and double-quoted frontmatter values', () => {
    const parsed = parseSkillFile(
      '/x/skill/SKILL.md',
      '---\nname: \'quoted\'\ndescription: "dbl"\n---\nBody.\n',
    );
    expect(parsed.name).toBe('quoted');
    expect(parsed.description).toBe('dbl');
  });

  it('parses quoted flow-list entries and booleans', () => {
    const parsed = parseSkillFile(
      '/x/skill/SKILL.md',
      '---\nroles: [\'a\', "b"]\ntools: [read, write]\ndisableModelInvocation: true\n---\nBody.\n',
    );
    expect(parsed.roles).toEqual(['a', 'b']);
    expect(parsed.requiredTools).toEqual(['read', 'write']);
    expect(parsed.disableModelInvocation).toBe(true);
  });

  it('treats empty roles/tools and false flags as absent', () => {
    const parsed = parseSkillFile(
      '/x/skill/SKILL.md',
      '---\nroles: []\ntools: []\ndisableModelInvocation: false\n---\nBody.\n',
    );
    expect(parsed.roles).toBeUndefined();
    expect(parsed.requiredTools).toBeUndefined();
    expect(parsed.disableModelInvocation).toBeUndefined();
  });

  it('falls back to the directory name for empty names', () => {
    const parsed = parseSkillFile(
      '/x/mydir/SKILL.md',
      '---\nname: ""\n---\nBody line.\n',
    );
    expect(parsed.name).toBe('mydir');
  });

  it('keeps unclosed frontmatter as raw body', () => {
    const raw = '---\nname: x\nBody without closing.\n';
    const parsed = parseSkillFile('/x/mydir/SKILL.md', raw);
    expect(parsed.content).toBe(raw);
    expect(parsed.name).toBe('mydir');
  });

  it('parses CRLF frontmatter', () => {
    const parsed = parseSkillFile(
      '/x/skill/SKILL.md',
      '---\r\nname: crlf\r\n---\r\nBody\r\n',
    );
    expect(parsed.name).toBe('crlf');
  });

  it('skips comments and colon-less lines in frontmatter', () => {
    const parsed = parseSkillFile(
      '/x/skill/SKILL.md',
      '---\n# a comment\nno-colon-here\n: empty-key\nname: ok\n---\nBody.\n',
    );
    expect(parsed.name).toBe('ok');
    expect(parsed.description).toBe('Body.');
  });

  it('uses the first non-empty body line as the description fallback', () => {
    const parsed = parseSkillFile(
      '/x/mydir/SKILL.md',
      '\n\nFirst line.\nSecond.\n',
    );
    expect(parsed.name).toBe('mydir');
    expect(parsed.description).toBe('First line.');
  });

  it('falls back to an empty description when the body is empty', () => {
    const parsed = parseSkillFile('/x/mydir/SKILL.md', '---\nname: n\n---\n');
    expect(parsed.name).toBe('n');
    expect(parsed.description).toBe('');
    expect(parsed.content).toBe('');
  });
});

describe('explicit skill loading hardening', () => {
  it('logs and skips unreadable skill dirs', () => {
    const { env, bridge } = setup();
    env.fs.writeFile('/oops/other.txt', 'x');
    const lines: string[] = [];
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      settingsSkills: ['/oops'],
      log: (line) => {
        lines.push(line);
      },
    });
    expect(result.skills).toEqual([]);
    expect(lines.some((line) => /unreadable/.test(line))).toBe(true);
  });

  it('reports unknown --skill names without failing', () => {
    const { bridge } = setup();
    const lines: string[] = [];
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['ghost-skill'],
      log: (line) => {
        lines.push(line);
      },
    });
    expect(result.skills).toEqual([]);
    // The loader stays fail-open, but the miss is reported for the
    // caller's stderr warning — never only a debug-log line.
    expect(result.unknownSkills).toEqual(['ghost-skill']);
    expect(lines.some((line) => /unknown skill/.test(line))).toBe(false);
  });

  it('loads a direct .md --skill path', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      '/custom/standalone.md',
      skillMd('name: lane\ndescription: Direct'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['/custom/standalone.md'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['lane']);
    expect(result.skills[0]?.source).toBe('cli');
  });

  it('loads a --skill directory via its SKILL.md', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      '/custom/dir/SKILL.md',
      skillMd('name: dirry\ndescription: Dir'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['/custom/dir'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['dirry']);
  });

  it('resolves bare --skill names against discovery roots', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/bare/SKILL.md`,
      skillMd('name: bare\ndescription: Bare'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['bare'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['bare']);
  });

  it('resolves a bare --skill name to a nested skill under a discovery root', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/group/nested/SKILL.md`,
      skillMd('name: nested\ndescription: Nested'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['nested'],
    });
    expect(result.unknownSkills).toEqual([]);
    expect(
      result.skills.map((skill) => [skill.name, skill.source, skill.filePath]),
    ).toEqual([
      ['nested', 'cli', `${HOME}/.agents/skills/group/nested/SKILL.md`],
    ]);
  });

  it('prefers a top-level skill in any root over a nested one for a bare name', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.pi/agent/skills/group/twin/SKILL.md`,
      skillMd('name: twin\ndescription: Nested twin'),
    );
    env.fs.writeFile(
      `${HOME}/.kubic/skills/twin/SKILL.md`,
      skillMd('name: twin\ndescription: Top-level twin'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['twin'],
    });
    expect(
      result.skills.map((skill) => [skill.source, skill.filePath]),
    ).toEqual([['cli', `${HOME}/.kubic/skills/twin/SKILL.md`]]);
  });

  it('skips missing settings dirs silently', () => {
    const { bridge } = setup();
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      settingsSkills: ['/missing/dir'],
    });
    expect(result.skills).toEqual([]);
  });

  it('logs invalid package.json files and keeps going', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(`${CWD}/package.json`, '{invalid json');
    env.fs.writeFile(
      `${HOME}/.agents/skills/ok/SKILL.md`,
      skillMd('name: ok\ndescription: Fine'),
    );
    const lines: string[] = [];
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: true,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['ok']);
    expect(lines.some((line) => /invalid package\.json/.test(line))).toBe(true);
  });

  it('logs the untrusted-cwd exclusion', () => {
    const { bridge } = setup();
    const lines: string[] = [];
    discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(lines.some((line) => /untrusted cwd/.test(line))).toBe(true);
  });
});
