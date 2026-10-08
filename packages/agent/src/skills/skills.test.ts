// Skills loader tests. Faux-only: FakeExecutionEnv + an
// in-test FileBridge adapter (fs access stays inside packages/exec).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeExecutionEnv } from '../../../exec/src/env.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { DEFAULT_PERMISSIONS } from '../permissions.js';
import type { LoadedSkill } from './skills.js';
import {
  discoverSkills,
  expandSkillInvocation,
  formatSkillsForSystemPrompt,
  gateSkills,
  invokeSkill,
  parseSkillFile,
} from './skills.js';

function bridgeFromEnv(
  env: FakeExecutionEnv,
  links: Record<string, string> = {},
): FileBridge {
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
    // Symlink stand-in — the fake fs cannot model links, so
    // tests declare lexical-prefix → target mappings here. Longest prefix
    // wins, applied iteratively so chained links resolve fully.
    realPath: (path: string): string => {
      let resolved = path.replace(/\/*$/, '') || '/';
      for (let i = 0; i < 10; i++) {
        const from = Object.keys(links)
          .sort((a, b) => b.length - a.length)
          .find(
            (candidate) =>
              resolved === candidate || resolved.startsWith(`${candidate}/`),
          );
        if (from === undefined) break;
        resolved = `${links[from]}${resolved.slice(from.length)}`;
      }
      return resolved || '/';
    },
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

describe('skill discovery', () => {
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

  it('discovers ~/.kubic/skills as a third user root', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.kubic/skills/gamma/SKILL.md`,
      skillMd('name: gamma\ndescription: Kubic-native skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['gamma']);
    expect(result.skills[0]?.source).toBe('user');
  });

  it('prefers ~/.kubic/skills over the Pi-compatible roots on name conflict', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/lint/SKILL.md`,
      skillMd('name: lint\ndescription: Pi-carried lint'),
    );
    env.fs.writeFile(
      `${HOME}/.kubic/skills/lint/SKILL.md`,
      skillMd('name: lint\ndescription: Kubic-native lint'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['lint']);
    expect(result.skills[0]?.description).toBe('Kubic-native lint');
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

  it('checks trust per ancestor: a child grant never reaches the parent', () => {
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
    // The grant names /repo/pkg only: the parent's skill is out of scope
    // even though the child's cwd sits under it.
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/pkg',
      trusted: false,
      trustProject: (dir) => dir === '/repo/pkg',
    });
    expect(result.skills.map((skill) => skill.name).sort()).toEqual(['near']);
  });

  it('lets a parent grant cover the parent tree from a child cwd', () => {
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
    // The grant names /repo: its skills load from a child cwd, while the
    // child's own (untrusted) dir stays out.
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/pkg',
      trusted: false,
      trustProject: (dir) => dir === '/repo',
    });
    expect(result.skills.map((skill) => skill.name).sort()).toEqual(['far']);
  });

  it('loads ancestor project dirs far-to-near with nearer shadowing', () => {
    const { env, bridge } = setup();
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
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

  it('stops the ancestor walk at the git top level', () => {
    const { env, bridge } = setup();
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    env.fs.writeFile(
      '/parent/.agents/skills/outsider/SKILL.md',
      skillMd('name: outsider\ndescription: Above the repo'),
    );
    env.fs.writeFile(
      '/repo/.agents/skills/insider/SKILL.md',
      skillMd('name: insider\ndescription: At the root'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/pkg/sub',
      trusted: true,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['insider']);
  });

  it('loads repo-root skills from a nested cwd', () => {
    const { env, bridge } = setup();
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    env.fs.writeFile(
      '/repo/.agents/skills/rooted/SKILL.md',
      skillMd('name: rooted\ndescription: Repo root skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/a/b',
      trusted: true,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['rooted']);
  });

  it('searches only the cwd outside a repository', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      '/plain/.agents/skills/parent-skill/SKILL.md',
      skillMd('name: parent-skill\ndescription: Parent skill'),
    );
    env.fs.writeFile(
      '/plain/sub/.agents/skills/own-skill/SKILL.md',
      skillMd('name: own-skill\ndescription: Own skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/plain/sub',
      trusted: true,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['own-skill']);
  });

  it('ignores a package.json above the git root', () => {
    const { env, bridge } = setup();
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    env.fs.writeFile(
      '/package.json',
      JSON.stringify({ skills: ['./evil-skills/pwn'] }),
    );
    env.fs.writeFile(
      '/evil-skills/pwn/SKILL.md',
      skillMd('name: pwn\ndescription: Above-root package skill'),
    );
    env.fs.writeFile(
      '/repo/package.json',
      JSON.stringify({ skills: ['./repo-skills/ok'] }),
    );
    env.fs.writeFile(
      '/repo/repo-skills/ok/SKILL.md',
      skillMd('name: ok\ndescription: In-repo package skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/sub',
      trusted: true,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['ok']);
  });

  it('keeps home skills user-only, never relabelled project', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/home-skill/SKILL.md`,
      skillMd('name: home-skill\ndescription: Home skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: `${HOME}/proj`,
      trusted: true,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['home-skill']);
    expect(result.skills[0]?.source).toBe('user');
  });

  it('never lists a user root as a project root when the repo root is $HOME', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(`${HOME}/.git/HEAD`, 'ref: refs/heads/main\n');
    env.fs.writeFile(
      `${HOME}/.agents/skills/home-skill/SKILL.md`,
      skillMd('name: home-skill\ndescription: Home skill'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: `${HOME}/proj`,
      trusted: true,
    });
    const hits = result.skills.filter((skill) => skill.name === 'home-skill');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.source).toBe('user');
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

// Package-declared skill confinement: a package.json entry
// naming an absolute path, a `..` escape, or a symlink resolving outside
// the declaring ancestor never loads — each refusal carries its reason on
// the log sink.
describe('package-declared skill confinement', () => {
  it('refuses absolute and ../-escape package entries outside the declaring dir', () => {
    const { env, bridge } = setup();
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    env.fs.writeFile(
      '/repo/pkg/package.json',
      JSON.stringify({
        skills: ['/abs/elsewhere/evil', '../outside', './local-ok'],
      }),
    );
    env.fs.writeFile(
      '/repo/pkg/local-ok/SKILL.md',
      skillMd('name: ok\ndescription: Local skill'),
    );
    const lines: string[] = [];
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/pkg',
      trusted: true,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['ok']);
    expect(
      lines.filter((line) => /outside trusted root/.test(line)),
    ).toHaveLength(2);
    // Review on: the refusals are reported, not just logged —
    // both entries land in `skipped` with reasons.
    expect(result.skipped).toEqual([
      {
        name: 'evil',
        filePath: '/abs/elsewhere/evil/SKILL.md',
        source: 'package',
        status: 'excluded',
        reason:
          "package skill '/abs/elsewhere/evil' outside trusted root '/repo/pkg'",
      },
      {
        name: 'outside',
        filePath: '/repo/outside/SKILL.md',
        source: 'package',
        status: 'excluded',
        reason:
          "package skill '/repo/outside' outside trusted root '/repo/pkg'",
      },
    ]);
  });

  it('refuses a package entry whose symlink resolves outside the declaring dir', () => {
    const env = new FakeExecutionEnv({});
    const bridge = bridgeFromEnv(env, {
      '/repo/pkg/linked': '/outside/real',
    });
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    env.fs.writeFile(
      '/repo/pkg/package.json',
      JSON.stringify({ skills: ['./linked'] }),
    );
    // Present at the lexical path (the link itself is readable); the
    // realPath stand-in above resolves it outside the repo.
    env.fs.writeFile(
      '/repo/pkg/linked/SKILL.md',
      skillMd('name: smuggled\ndescription: Via symlink'),
    );
    const lines: string[] = [];
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/pkg',
      trusted: true,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(result.skills).toEqual([]);
    expect(lines.some((line) => /outside trusted root/.test(line))).toBe(true);
  });

  it('fails closed when realPath throws (a transient failure must not load)', () => {
    const { env, bridge } = setup();
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    env.fs.writeFile(
      '/repo/pkg/package.json',
      JSON.stringify({ skills: ['./maybe-link'] }),
    );
    // Readable at the lexical path — without fail-closed this loads.
    env.fs.writeFile(
      '/repo/pkg/maybe-link/SKILL.md',
      skillMd('name: maybe\ndescription: Maybe'),
    );
    const throwing: FileBridge = {
      ...bridge,
      realPath: () => {
        throw new Error('EIO');
      },
    };
    const lines: string[] = [];
    const result = discoverSkills({
      bridge: throwing,
      homeDir: HOME,
      cwd: '/repo/pkg',
      trusted: true,
      log: (line) => {
        lines.push(line);
      },
    });
    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([
      {
        name: 'maybe-link',
        filePath: '/repo/pkg/maybe-link/SKILL.md',
        source: 'package',
        status: 'error',
        reason:
          "package skill '/repo/pkg/maybe-link' unresolvable under trusted root '/repo/pkg' (realPath failed)",
      },
    ]);
    expect(lines.some((line) => /unresolvable/.test(line))).toBe(true);
  });

  it('keeps a package entry whose symlink resolves inside the declaring dir', () => {
    const env = new FakeExecutionEnv({});
    const bridge = bridgeFromEnv(env, {
      '/repo/pkg/alias': '/repo/pkg/real',
    });
    env.fs.writeFile('/repo/.git/HEAD', 'ref: refs/heads/main\n');
    env.fs.writeFile(
      '/repo/pkg/package.json',
      JSON.stringify({ skills: ['./alias'] }),
    );
    env.fs.writeFile(
      '/repo/pkg/alias/SKILL.md',
      skillMd('name: inner\ndescription: Inside link'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: '/repo/pkg',
      trusted: true,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['inner']);
  });
});

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
    expect(names).toContain('skills.ts');
    expect(names.some((name) => /fetch|install/i.test(name))).toBe(false);
    // And the loader itself has no network path to fetch through.
    const source = readFileSync(join(here, 'skills.ts'), 'utf8');
    expect(source).not.toMatch(/\bfetch\(|node:https?\b|node:net\b/);
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

// Explicit skill paths anchor at the invoking cwd:
// `./rel-skill`, `rel-skill` and `../up/skill` load from cwd-relative
// locations, `rel/SKILL.md` never consults the bridge's own root, and a
// stray filesystem-root hit never wins over the discovery roots.
describe('explicit skill paths anchor at the invoking cwd', () => {
  it('loads --skill ./rel-skill from the cwd', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/rel-skill/SKILL.md`,
      skillMd('name: rel\ndescription: Rel'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['./rel-skill'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['rel']);
    expect(result.skills[0]?.filePath).toBe(`${CWD}/rel-skill/SKILL.md`);
    expect(result.unknownSkills).toEqual([]);
  });

  it('loads a bare --skill name from the cwd when no root provides it', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/local/SKILL.md`,
      skillMd('name: local\ndescription: Local'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['local'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['local']);
    expect(result.unknownSkills).toEqual([]);
  });

  it('prefers the discovery roots over the cwd for a bare name', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/shared/SKILL.md`,
      skillMd('name: shared\ndescription: From root'),
    );
    env.fs.writeFile(
      `${CWD}/shared/SKILL.md`,
      skillMd('name: shared\ndescription: From cwd'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['shared'],
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe('From root');
  });

  it('loads --skill ../up/skill above the cwd', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      '/fakehome/up/skill/SKILL.md',
      skillMd('name: upsy\ndescription: Up'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['../up/skill'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['upsy']);
    expect(result.unknownSkills).toEqual([]);
  });

  it('loads --skill rel/SKILL.md against the cwd, not the bridge root', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/rel/SKILL.md`,
      skillMd('name: relfile\ndescription: Rel file'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['rel/SKILL.md'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['relfile']);
    expect(result.unknownSkills).toEqual([]);
  });

  it('resolves relative settings skill dirs against the cwd', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${CWD}/team/SKILL.md`,
      skillMd('name: team\ndescription: Team'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      settingsSkills: ['./team'],
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['team']);
    expect(result.skills[0]?.source).toBe('settings');
  });

  it('never probes the filesystem root for a bare name', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      '/planted/SKILL.md',
      skillMd('name: planted\ndescription: Planted'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
      cliSkills: ['planted'],
    });
    expect(result.skills).toEqual([]);
    expect(result.unknownSkills).toEqual(['planted']);
  });
});

describe('skill gating and invocation hardening', () => {
  it('escapes XML metacharacters in the system prompt', () => {
    const xml = formatSkillsForSystemPrompt([
      {
        name: 'a&b<c>d"e\'f',
        description: 'x&y<z>"q"',
        filePath: '/p/SKILL.md',
        source: 'user',
        content: 'c',
      },
    ]);
    expect(xml).toContain('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(xml).toContain('x&amp;y&lt;z&gt;&quot;q&quot;');
    expect(xml).not.toContain('a&b');
  });

  it('throws on unknown explicit skill names', () => {
    expect(() => invokeSkill([], 'ghost')).toThrow(/unknown skill/);
  });

  it('expands an explicit invocation to the skill content plus instructions', () => {
    const skills = [
      { name: 'secret', content: 'Hidden content.' },
      { name: 'open', content: 'Open content.' },
    ] as LoadedSkill[];
    expect(expandSkillInvocation(skills, 'secret', 'do x')).toBe(
      'Hidden content.\n\ndo x',
    );
    expect(expandSkillInvocation(skills, 'open')).toBe('Open content.');
    expect(expandSkillInvocation(skills, 'open', '  ')).toBe('Open content.');
    expect(() => expandSkillInvocation(skills, 'ghost', 'do x')).toThrow(
      /unknown skill 'ghost'/,
    );
  });

  it('refuses an unknown skill name with the unknown-skill reason', () => {
    expect(() => expandSkillInvocation([], 'ghost')).toThrow(
      "unknown skill 'ghost'",
    );
  });
});

// Pi skill-contract parity: the canonical kebab-case
// `disable-model-invocation`, block sequences and folded/literal scalars
// for the contract keys, and recursive discovery. Deeper YAML (anchors,
// tags, nested maps, indent indicators) stays plain values by design.
describe('Pi skill-contract parity', () => {
  it('hides disable-model-invocation skills, keeping camelCase as an alias', () => {
    const kebab = parseSkillFile(
      '/x/hide/SKILL.md',
      '---\nname: hide\ndisable-model-invocation: true\n---\nBody.\n',
    );
    expect(kebab.disableModelInvocation).toBe(true);
    const camel = parseSkillFile(
      '/x/hide/SKILL.md',
      '---\nname: hide\ndisableModelInvocation: true\n---\nBody.\n',
    );
    expect(camel.disableModelInvocation).toBe(true);
    const plain = parseSkillFile('/x/hide/SKILL.md', '---\nname: hide\n---\n');
    expect(plain.disableModelInvocation).toBeUndefined();
    // Hidden means hidden: neither spelling reaches the prompt block.
    const xml = formatSkillsForSystemPrompt([
      { ...kebab, source: 'user' },
      { ...camel, name: 'hide2', source: 'user' },
    ]);
    expect(xml).not.toContain('hide');
  });

  it('folds > descriptions and keeps | newlines', () => {
    const folded = parseSkillFile(
      '/x/f/SKILL.md',
      '---\nname: f\ndescription: >\n  Line one\n  line two\n---\nBody.\n',
    );
    expect(folded.description).toBe('Line one line two');
    const literal = parseSkillFile(
      '/x/f/SKILL.md',
      '---\nname: f\ndescription: |\n  Line one\n  line two\n---\nBody.\n',
    );
    expect(literal.description).toBe('Line one\nline two');
    const stripped = parseSkillFile(
      '/x/f/SKILL.md',
      '---\nname: f\ndescription: |-\n  Line one\n  line two\n---\nBody.\n',
    );
    expect(stripped.description).toBe('Line one\nline two');
  });

  it('parses block-list roles and tools, stripping quotes', () => {
    const parsed = parseSkillFile(
      '/x/b/SKILL.md',
      '---\nname: b\nroles:\n  - reviewer\n  - "plan ner"\ntools:\n  - read\n  - write\n---\nBody.\n',
    );
    expect(parsed.roles).toEqual(['reviewer', 'plan ner']);
    expect(parsed.requiredTools).toEqual(['read', 'write']);
  });

  it('reads an empty value with indented non-list text as absent', () => {
    const parsed = parseSkillFile(
      '/x/b/SKILL.md',
      '---\nname: b\nroles:\n  just some text\ntools: [read]\n---\nBody.\n',
    );
    expect(parsed.roles).toBeUndefined();
    expect(parsed.requiredTools).toEqual(['read']);
  });

  it('discovers nested skill dirs, skipping dot-dirs and node_modules', () => {
    const { env, bridge } = setup();
    env.fs.writeFile(
      `${HOME}/.agents/skills/outer/nested/SKILL.md`,
      skillMd('name: nested\ndescription: Deep'),
    );
    env.fs.writeFile(
      `${HOME}/.agents/skills/.hidden/SKILL.md`,
      skillMd('name: hidden\ndescription: Nope'),
    );
    env.fs.writeFile(
      `${HOME}/.agents/skills/node_modules/dep/SKILL.md`,
      skillMd('name: dep\ndescription: Nope'),
    );
    const result = discoverSkills({
      bridge,
      homeDir: HOME,
      cwd: CWD,
      trusted: false,
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(['nested']);
  });
});
