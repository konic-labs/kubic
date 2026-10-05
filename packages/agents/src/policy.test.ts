import { describe, expect, it } from 'vitest';
import type { PermissionClasses } from './policy.js';
import {
  checkAgreement,
  checkExpressible,
  checkGrantable,
  effectiveNetworkLevel,
  PolicyValidationError,
  SOLO_DEFAULTS,
  toolsForClasses,
  validateClasses,
} from './policy.js';

describe('permission policy model (issue #15, slice A)', () => {
  it('loads solo defaults matching §12.1', () => {
    expect(SOLO_DEFAULTS).toEqual({
      filesystem: 'workspace-write',
      shell: true,
      network: 'none',
      git: 'workspace',
      credentials: 'none',
    });
  });

  it('derives the solo tool allowlist from defaults', () => {
    expect(toolsForClasses(SOLO_DEFAULTS).sort()).toEqual(
      [
        'bash',
        'edit',
        'find',
        'git_branch',
        'git_checkpoint',
        'git_commit',
        'git_diff',
        'git_log',
        'git_show',
        'git_stage',
        'git_status',
        'grep',
        'ls',
        'read',
        'write',
      ].sort(),
    );
  });

  it('restricts read-only roles to read tools', () => {
    const tools = toolsForClasses({
      ...SOLO_DEFAULTS,
      filesystem: 'read',
      shell: false,
      git: false,
    });
    expect(tools.sort()).toEqual(['find', 'grep', 'ls', 'read'].sort());
  });

  // Issue #161: `read-only-allowlist` keeps the bash TOOL (the command
  // allowlist is enforced by the lane's guard, not by removing bash) and
  // `shell: true` is unchanged — the level distinction never narrows the
  // full shell.
  it('keeps bash for both shell levels, and narrows only the guard', () => {
    expect(
      toolsForClasses({ ...SOLO_DEFAULTS, shell: 'read-only-allowlist' }),
    ).toContain('bash');
    expect(toolsForClasses({ ...SOLO_DEFAULTS, shell: true })).toContain(
      'bash',
    );
    expect(
      checkAgreement(
        { ...SOLO_DEFAULTS, shell: 'read-only-allowlist' },
        toolsForClasses({ ...SOLO_DEFAULTS, shell: 'read-only-allowlist' }),
      ).agree,
    ).toBe(true);
  });

  it('refuses contradictory roles with named reasons', () => {
    const read = checkAgreement({ ...SOLO_DEFAULTS, filesystem: 'read' }, [
      'read',
      'write',
    ]);
    expect(read.agree).toBe(false);
    if (!read.agree) expect(read.reason).toContain('write');
    const shell = checkAgreement({ ...SOLO_DEFAULTS, shell: false }, ['bash']);
    expect(shell.agree).toBe(false);
    if (!shell.agree) expect(shell.reason).toContain('bash');
  });

  it('accepts agreeing roles', () => {
    expect(
      checkAgreement(SOLO_DEFAULTS, toolsForClasses(SOLO_DEFAULTS)).agree,
    ).toBe(true);
  });

  it('refuses ungrantable classes with named reasons', () => {
    const missing = checkGrantable(SOLO_DEFAULTS, ['read']);
    expect(missing.agree).toBe(false);
    if (!missing.agree) expect(missing.reason).toContain('ls');
    expect(
      checkGrantable(SOLO_DEFAULTS, toolsForClasses(SOLO_DEFAULTS)).agree,
    ).toBe(true);
  });

  it('merges partial input over solo defaults', () => {
    expect(validateClasses({})).toEqual(SOLO_DEFAULTS);
    expect(validateClasses({ filesystem: 'read' }).shell).toBe(true);
  });

  it('rejects unknown class literals', () => {
    expect(() =>
      validateClasses({ ...SOLO_DEFAULTS, filesystem: 'sometimes' }),
    ).toThrow(/invalid filesystem: "sometimes"/);
    expect(() => validateClasses(null)).toThrow(
      /permission classes must be an object/,
    );
  });

  it('throws named PolicyValidationError failures', () => {
    try {
      validateClasses(null);
      expect.unreachable('validateClasses(null) must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyValidationError);
      expect((err as Error).name).toBe('PolicyValidationError');
    }
  });
});

describe('checkAgreement every refuse branch (issue #220)', () => {
  it("refuses fs 'none' with a read tool, naming the tool", () => {
    const result = checkAgreement({ ...SOLO_DEFAULTS, filesystem: 'none' }, [
      'read',
    ]);
    expect(result).toEqual({
      agree: false,
      reason: "filesystem is 'none' but tool 'read' is registered",
    });
  });

  it("refuses fs 'read' with a write tool, naming the tool", () => {
    const result = checkAgreement({ ...SOLO_DEFAULTS, filesystem: 'read' }, [
      'read',
      'write',
    ]);
    expect(result).toEqual({
      agree: false,
      reason: "filesystem is 'read' but write tool 'write' is registered",
    });
  });

  it('refuses shell false with bash', () => {
    expect(
      checkAgreement({ ...SOLO_DEFAULTS, shell: false }, ['bash']),
    ).toEqual({
      agree: false,
      reason: "shell is disabled but tool 'bash' is registered",
    });
  });

  it('refuses git false with git_commit, naming the tool', () => {
    const result = checkAgreement({ ...SOLO_DEFAULTS, git: false }, [
      'read',
      'git_commit',
    ]);
    expect(result).toEqual({
      agree: false,
      reason: "git is disabled but tool 'git_commit' is registered",
    });
  });

  it('agrees when no refused tool is registered', () => {
    expect(
      checkAgreement(
        { ...SOLO_DEFAULTS, filesystem: 'none', shell: false, git: false },
        [],
      ).agree,
    ).toBe(true);
    expect(
      checkAgreement(SOLO_DEFAULTS, toolsForClasses(SOLO_DEFAULTS)).agree,
    ).toBe(true);
  });
});

describe('toolsForClasses over every level (issue #220)', () => {
  it('filesystem: none holds no fs tools, read holds reads, writes need workspace-write/full', () => {
    const base: PermissionClasses = { ...SOLO_DEFAULTS, shell: false, git: false };
    expect(toolsForClasses({ ...base, filesystem: 'none' })).toEqual([]);
    expect(toolsForClasses({ ...base, filesystem: 'read' }).sort()).toEqual(
      ['find', 'grep', 'ls', 'read'].sort(),
    );
    for (const filesystem of ['workspace-write', 'full'] as const) {
      const tools = toolsForClasses({ ...base, filesystem });
      expect(tools.sort()).toEqual(
        ['edit', 'find', 'grep', 'ls', 'read', 'write'].sort(),
      );
    }
  });

  it('shell: false holds no bash, the allowlist and full shell do', () => {
    const base: PermissionClasses = { ...SOLO_DEFAULTS, filesystem: 'none', git: false };
    expect(toolsForClasses({ ...base, shell: false })).toEqual([]);
    for (const shell of ['read-only-allowlist', true] as const) {
      expect(toolsForClasses({ ...base, shell })).toEqual(['bash']);
    }
  });

  it('git: false holds no git tools, workspace and full hold all eight', () => {
    const base: PermissionClasses = { ...SOLO_DEFAULTS, filesystem: 'none', shell: false };
    expect(toolsForClasses({ ...base, git: false })).toEqual([]);
    const all = [
      'git_status',
      'git_diff',
      'git_log',
      'git_show',
      'git_stage',
      'git_commit',
      'git_branch',
      'git_checkpoint',
    ];
    for (const git of ['workspace', 'full'] as const) {
      expect(toolsForClasses({ ...base, git }).sort()).toEqual(all.sort());
    }
  });

  it('network and credentials levels add no tools', () => {
    const base = toolsForClasses(SOLO_DEFAULTS);
    for (const network of ['none', 'allowlist', 'full'] as const) {
      for (const credentials of ['none', 'allowlist'] as const) {
        expect(
          toolsForClasses({ ...SOLO_DEFAULTS, network, credentials }),
        ).toEqual(base);
      }
    }
  });
});

describe('validateClasses invalid literal per key (issue #220)', () => {
  it.each([
    ['filesystem', 'sometimes'],
    ['shell', 'sometimes'],
    ['network', 'sometimes'],
    ['git', 'sometimes'],
    ['credentials', 'sometimes'],
  ])('rejects an invalid %s literal by name', (key, literal) => {
    expect(() => validateClasses({ [key]: literal })).toThrow(
      `invalid ${key}: "${literal}"`,
    );
  });
});

describe('inexpressible levels are reported, never silent (issue #166, §40.2)', () => {
  it('reports network allowlist with no domain list as unsupported, enforced as none', () => {
    const found = checkExpressible(validateClasses({ network: 'allowlist' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      class: 'network',
      level: 'allowlist',
      enforcedAs: 'none',
    });
    expect(found[0]?.reason).toMatch(/domain/);
    expect(effectiveNetworkLevel('allowlist')).toBe('none');
    expect(effectiveNetworkLevel('full')).toBe('full');
    expect(effectiveNetworkLevel('none')).toBe('none');
  });

  it('reports credentials allowlist, filesystem full and git full by class', () => {
    const found = checkExpressible(
      validateClasses({
        credentials: 'allowlist',
        filesystem: 'full',
        git: 'full',
      }),
    );
    expect(
      found.map((entry) => [entry.class, entry.level, entry.enforcedAs]),
    ).toEqual([
      ['filesystem', 'full', 'workspace-write'],
      ['git', 'full', 'workspace'],
      ['credentials', 'allowlist', 'none'],
    ]);
  });

  it('reports nothing for the expressible solo defaults', () => {
    expect(checkExpressible(SOLO_DEFAULTS)).toEqual([]);
    expect(
      checkExpressible(
        validateClasses({ network: 'full', filesystem: 'read' }),
      ),
    ).toEqual([]);
  });
});
