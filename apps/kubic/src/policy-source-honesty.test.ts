// The installed-policy SOURCE is the config layer's own record:
// the posture `doctor` prints and the posture the lane installs must name the
// same origin, and neither may claim "config" for a directory that configured
// nothing. This exists because the first implementation inferred `source` from
// the shape of the classes object — and a config-less install still yields
// DEFAULT_PERMISSIONS, so the real binary printed `source=config` in an empty
// directory. Measured against /tmp/k86 with no config: PASS policy:installed
// said source=config; that was the bug this test now pins shut.
//
// Faux provider only: zero network, zero paid tokens.

import { DEFAULT_PERMISSIONS } from '@kubic/agent/permissions';
import {
  detectTriggers,
  installPolicy,
  triggerContextFor,
} from '@kubic/host/approvals';
import {
  loadRuntimeConfig,
  NO_PROJECT_TRUST,
  type RuntimeConfig,
} from '@kubic/host/config';
import { describe, expect, it } from 'vitest';
import type { CliConfigResult } from './config/load.js';
import { installedPolicyDeps } from './config/projections.js';

// The shape the composition root hands the projection: the load's own result
// plus the fields `run`/`tui` do not read. Only `runtime` matters here.
function cliResult(runtime: RuntimeConfig | undefined): CliConfigResult {
  return {
    runtime,
    error: undefined,
    ignoreSplit: { missing: [], checked: [], applicable: false },
    trust: NO_PROJECT_TRUST,
  };
}

const NO_CONFIG = {
  bridge: { exists: () => false, readTextFile: () => '' },
  home: '/nonexistent-home',
  cwd: '/nonexistent-cwd',
  enterprisePath: '/nonexistent/enterprise.toml',
  projectTrusted: true,
  env: {},
} as const;

function configured(text: string) {
  return {
    bridge: {
      exists: (path: string): boolean =>
        path === '/nonexistent-cwd/.kubic/config.toml',
      readTextFile: (): string => text,
    },
    home: '/nonexistent-home',
    cwd: '/nonexistent-cwd',
    enterprisePath: '/nonexistent/enterprise.toml',
    projectTrusted: true,
    env: {},
  };
}

describe('installed-policy source honesty', () => {
  it('a config-less directory installs the documented DEFAULT, not "config"', () => {
    const result = cliResult(loadRuntimeConfig(NO_CONFIG));
    const deps = installedPolicyDeps(result);
    // The layer said 'defaults', so no classes are claimed and the posture
    // will print source=default. The classes themselves are still the
    // documented safe ones — that is the install, not a configuration.
    expect(deps.source).toBe('default');
    expect(deps.classes).toBeUndefined();
    const installed = installPolicy({
      workspace: '/tmp/x',
      ...deps,
    });
    expect(installed.posture.source).toBe('default');
    expect(installed.posture.classes).toEqual(DEFAULT_PERMISSIONS);
    // Deny-by-default tail: the safe half is what the default is made of.
    expect(installed.posture.classes.network).toBe('none');
    expect(installed.posture.classes.credentials).toBe('none');
    expect(installed.posture.allowlist.length).toBeGreaterThan(0);
    expect(installed.posture.interceptors).toContain('destructive-guard');
    expect(installed.posture.interceptors).toContain('approval');
  });

  it('an explicit [permissions] layer installs as "config"', () => {
    const result = cliResult(
      loadRuntimeConfig(configured('[permissions]\nnetwork = "allowlist"\n')),
    );
    const deps = installedPolicyDeps(result);
    expect(deps.source).toBe('config');
    expect(deps.classes?.network).toBe('allowlist');
    const installed = installPolicy({ workspace: '/tmp/x', ...deps });
    expect(installed.posture.source).toBe('config');
    expect(installed.posture.classes.network).toBe('allowlist');
    // The domain-less allowlist is reported, and the installed
    // guards enforce it as `none` — `curl` raises the network trigger.
    expect(installed.posture.unsupported.map((u) => u.class)).toEqual([
      'network',
    ]);
    expect(
      detectTriggers(
        'bash',
        { command: 'curl https://x' },
        triggerContextFor(installed.posture.classes, '/tmp/x'),
      ),
    ).toEqual(['network']);
  });

  it('a config that sets something ELSE still installs the default classes', () => {
    // [journal] only: the permission leaf was never set by any layer, so the
    // posture must not claim the operator configured classes.
    const result = cliResult(
      loadRuntimeConfig(configured('[journal]\nretentionDays = 3\n')),
    );
    const deps = installedPolicyDeps(result);
    expect(deps.source).toBe('default');
    expect(deps.classes).toBeUndefined();
    expect(
      installPolicy({ workspace: '/tmp/x', ...deps }).posture.classes,
    ).toEqual(DEFAULT_PERMISSIONS);
  });

  it('a refused config falls back to the default posture, never to silence', () => {
    // A refused load has no runtime at all; the install must still be the
    // documented safe default (the run path refuses separately, on its own
    // config check).
    const deps = installedPolicyDeps(cliResult(undefined));
    expect(deps.source).toBe('default');
    expect(deps.classes).toBeUndefined();
    const posture = installPolicy({ workspace: '/tmp/x', ...deps }).posture;
    expect(posture.classes).toEqual(DEFAULT_PERMISSIONS);
    expect(posture.allowlist.length).toBeGreaterThan(0);
  });

  it('the run path and doctor agree on the source for the same config', () => {
    // One projection, two consumers. Both read installedPolicyDeps,
    // so this pins the single-source rule rather than a coincidence.
    const noConfig = installedPolicyDeps(
      cliResult(loadRuntimeConfig(NO_CONFIG)),
    );
    const withPerms = installedPolicyDeps(
      cliResult(
        loadRuntimeConfig(configured('[permissions]\nshell = false\n')),
      ),
    );
    expect(noConfig.source).toBe('default');
    expect(withPerms.source).toBe('config');
    expect(
      installPolicy({ workspace: '/tmp/x', ...noConfig }).posture.source,
    ).toBe('default');
    const configuredPosture = installPolicy({
      workspace: '/tmp/x',
      ...withPerms,
    }).posture;
    expect(configuredPosture.source).toBe('config');
    // The configured class really reached the install, not just the label.
    expect(configuredPosture.classes.shell).toBe(false);
    expect(configuredPosture.allowlist).not.toContain('bash');
  });
});
