import { describe, expect, it } from 'vitest';
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
    expect(() => validateClasses({ filesystem: 'sometimes' })).toThrow(
      /invalid filesystem: "sometimes"/,
    );
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
