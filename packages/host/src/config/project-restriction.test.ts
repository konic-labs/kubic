import { describe, expect, it } from 'vitest';
import { fakeBridge } from '../test-support/config-bridge.js';
import { ConfigError } from './errors.js';
import { projectProvidersRefusal } from './project-restriction.js';
import { loadRuntimeConfig } from './runtime.js';

const ENTERPRISE = '/etc/kubic/config.toml';
const GLOBAL = '/home/u/.kubic/config.toml';
const PROJECT = '/repo/.kubic/config.toml';
const RESTRICTED = '[policy]\nproject_policy = "restricted"\n';

function load(files: Record<string, string>) {
  return loadRuntimeConfig({
    bridge: fakeBridge(files),
    home: '/home/u',
    cwd: '/repo',
    projectRoot: '/repo',
    projectTrusted: true,
  });
}

function refusal(files: Record<string, string>): string {
  try {
    load(files);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('the load was not refused');
}

describe('[policy] project_policy = "restricted"', () => {
  it('refuses a project that auto-approves, widens a class or runs [verify], naming each key', () => {
    const message = refusal({
      [ENTERPRISE]: RESTRICTED,
      [PROJECT]: [
        '[approvals]',
        'autoApprove = ["destructive-shell"]',
        '[permissions]',
        'network = "full"',
        'filesystem = "read"',
        '[verify]',
        'tests = "npm test"',
      ].join('\n'),
    });
    expect(message).toBe(
      `project config ${PROJECT} sets 'approvals.autoApprove', 'permissions.network', 'verify.tests', which the enterprise policy forbids ([policy] project_policy = "restricted": a project may narrow approvals and permissions, never widen them, and may not run [verify] commands) — remove them from the project config`,
    );
  });

  it('lets a project narrow, and measures a widening against the layers above', () => {
    const runtime = load({
      [ENTERPRISE]: RESTRICTED,
      [GLOBAL]: '[permissions]\nnetwork = "allowlist"\n',
      [PROJECT]: [
        '[approvals]',
        'route = "deny"',
        '[permissions]',
        'network = "allowlist"',
        'shell = "read-only-allowlist"',
        'git = false',
      ].join('\n'),
    });
    expect(runtime.projectRestriction).toEqual({ layer: 'enterprise' });
    expect(
      refusal({
        [ENTERPRISE]: RESTRICTED,
        [GLOBAL]: '[permissions]\nnetwork = "allowlist"\n',
        [PROJECT]: '[permissions]\nnetwork = "full"\n',
      }),
    ).toContain("sets 'permissions.network'");
  });

  it('applies from the global layer too, and never from the project itself', () => {
    expect(
      refusal({
        [GLOBAL]: RESTRICTED,
        [PROJECT]: '[verify]\nlint = "npm run lint"\n',
      }),
    ).toContain('which the global policy forbids');
    const open = load({
      [PROJECT]: `${RESTRICTED}[verify]\nlint = "npm run lint"\n`,
    });
    expect(open.projectRestriction).toBeUndefined();
    // The first layer that sets it wins: an enterprise "open" holds.
    expect(
      load({
        [ENTERPRISE]: '[policy]\nproject_policy = "open"\n',
        [GLOBAL]: RESTRICTED,
        [PROJECT]: '[verify]\nlint = "npm run lint"\n',
      }).projectRestriction,
    ).toBeUndefined();
  });

  it('refuses an unknown value by name', () => {
    expect(
      refusal({ [ENTERPRISE]: '[policy]\nproject_policy = "strict"\n' }),
    ).toContain("'project_policy'");
  });

  it('names the models.json refusal it implies', () => {
    expect(projectProvidersRefusal({ layer: 'enterprise' })).toBe(
      'forbidden by the enterprise policy ([policy] project_policy = "restricted")',
    );
    expect(projectProvidersRefusal(undefined)).toBeUndefined();
  });
});
