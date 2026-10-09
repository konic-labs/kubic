// Skills loader tests. Faux-only: FakeExecutionEnv + an
// in-test FileBridge adapter (fs access stays inside packages/exec).
import type { FileBridge } from '@kubic/exec/file-bridge';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import { describe, expect, it } from 'vitest';
import {
  bridgeFromEnv,
  CWD,
  HOME,
  setup,
  skillMd,
} from '../test-support/skills-env.js';
import { discoverSkills } from './discover.js';

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
