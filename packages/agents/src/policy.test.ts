import { describe, expect, it } from 'vitest';
import {
  checkAgreement,
  checkGrantable,
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
      ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'].sort(),
    );
  });

  it('restricts read-only roles to read tools', () => {
    const tools = toolsForClasses({
      ...SOLO_DEFAULTS,
      filesystem: 'read',
      shell: false,
    });
    expect(tools.sort()).toEqual(['find', 'grep', 'ls', 'read'].sort());
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

  it('rejects unknown class literals', () => {
    expect(() =>
      validateClasses({ ...SOLO_DEFAULTS, filesystem: 'sometimes' }),
    ).toThrow();
    expect(() => validateClasses(null)).toThrow();
  });
});
