// Runtime config load.
// Every test drives the production entry point (`loadRuntimeConfig`) over
// a fake FileBridge: zero network, zero real files, dummy $ENV_VAR refs.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootFauxLane,
  promptToolsLine,
} from '@kubic/agent/test-support/lane-harness';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import {
  ensureRuntimeExcludeRules,
  gitSync,
} from '@kubic/exec/runtime-exclude';
import { FakeExecutionEnv } from '@kubic/exec/test-support/fake-env';
import {
  createGitSandbox,
  disposeAllGitSandboxes,
  type GitSandbox,
} from '@kubic/exec/test-support/git-sandbox';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import {
  hasToolPolicy,
  isToolAllowed,
  isToolAllowedByEnterprise,
} from '../policy/index.js';
import { fakeBridge } from '../test-support/config-bridge.js';
import {
  checkWorkspaceIgnoreSplit,
  effectiveConfigView,
  keyEffectFor,
  loadRuntimeConfig,
  RUNTIME_KEY_EFFECTS,
  type RuntimeConfigInputs,
  runtimeKeyDisposition,
} from './runtime.js';

const HOME = '/home/u';

const CWD = '/repo';

const PROJECT = `${CWD}/.kubic/config.toml`;

afterEach(() => {
  driver = undefined;
  disposeAllGitSandboxes();
});

// The test's git driver: plain, never injected — production
// reaches git only through the injected gitRunner seam.
let driver: GitSandbox | undefined;

function load(
  files: Record<string, string>,
  overrides: Partial<RuntimeConfigInputs> = {},
) {
  return loadRuntimeConfig({
    bridge: fakeBridge(files),
    home: HOME,
    cwd: CWD,
    ...overrides,
  });
}

// The row's own words, whichever disposition the row carries.
const effectTextOf = (entry: (typeof RUNTIME_KEY_EFFECTS)[string]): string => {
  if ('effect' in entry) return entry.effect;
  if ('kept' in entry) return entry.kept;
  return entry.notYetImplemented;
};

describe('request options reach the effective view', () => {
  it('marks the [model] tuning consumed with its layer', () => {
    const runtime = load(
      {
        [PROJECT]:
          '[model]\nprovider = "local"\nid = "llama3"\ntimeoutMs = 60000\nmaxRetries = 5\nmaxRetryDelayMs = 10000\ncacheRetention = "long"\n',
      },
      { projectTrusted: true },
    );
    for (const key of [
      'model.timeoutMs',
      'model.maxRetries',
      'model.maxRetryDelayMs',
      'model.cacheRetention',
    ]) {
      expect(keyEffectFor(key), key).toBe(RUNTIME_KEY_EFFECTS[key]);
      expect(runtimeKeyDisposition(keyEffectFor(key)), key).toBe('consumed');
    }
    const view = effectiveConfigView(runtime);
    expect(view.values.find((v) => v.key === 'model.timeoutMs')).toMatchObject({
      value: '60000',
      layer: 'project',
      disposition: 'consumed',
    });
    expect(
      view.values.find((v) => v.key === 'model.cacheRetention'),
    ).toMatchObject({
      value: '"long"',
      layer: 'project',
      disposition: 'consumed',
    });
    // A role table's tuning resolves through the `roles` section row — the
    // same section-or-key rule `roles.<name>.model` already follows.
    expect(keyEffectFor('roles.a.maxRetries')).toBe(RUNTIME_KEY_EFFECTS.roles);
  });
});

describe('enterprise [policy] on the live path', () => {
  const ENTERPRISE = '/etc/kubic/config.toml';
  const PRODUCT = '/etc/kubic/product.toml';
  const GLOBAL = `${HOME}/.kubic/config.toml`;

  const POLICY_EXAMPLE = `[policy]
allowed_models = ["claude-sonnet-4-6", "local/*"]
allowed_providers = ["anthropic", "local"]
allowed_tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "git_diff"]
denied_tools = ["network_fetch"]

network_policy = "proxy"
allowed_domains = ["registry.npmjs.org", "github.com"]

filesystem_policy = "workspace-only"

data_policy = "no-external-training"
logging_policy = "full-audit"

[[audit]]
sink = "syslog"
level = "privileged"
`;

  it('loads the documented example as the enterprise layer and resolves it', () => {
    const runtime = load({ [ENTERPRISE]: POLICY_EXAMPLE });
    expect(runtime.policy.tools.deny).toEqual(['network_fetch']);
    expect(runtime.policy.tools.allow).toContain('bash');
    expect(runtime.policy.models.allowed).toEqual([
      'claude-sonnet-4-6',
      'local/*',
    ]);
    expect(runtime.policy.models.providers).toEqual(['anthropic', 'local']);
    // 'proxy' is carried as the engine's allowlist mode; workspace-only as
    // workspace-write.
    expect(runtime.policy.network.mode).toBe('allowlist');
    expect(runtime.policy.filesystem.level).toBe('workspace-write');
    // Every policy key has an effect row: the effective view never reports
    // the documented surface as decoration.
    const view = effectiveConfigView(runtime);
    const policyValues = view.values.filter((entry) =>
      entry.key.startsWith('policy.'),
    );
    expect(policyValues.length).toBeGreaterThan(0);
    expect(policyValues.every((entry) => entry.disposition !== 'unknown')).toBe(
      true,
    );
  });

  it('refuses an unknown [policy] key as the enterprise layer, naming the key and layer', () => {
    expect(() => load({ [ENTERPRISE]: '[policy]\nbogus_key = 1\n' })).toThrow(
      /layer 'enterprise':.*unknown key 'bogus_key'/,
    );
  });

  it('pins enterprise > product > global > project > session, denying downward only', () => {
    const runtime = load(
      {
        [ENTERPRISE]: '[policy]\ndenied_tools = ["bash"]\n',
        [PRODUCT]: '[policy]\nallowed_tools = ["bash", "read"]\n',
        [GLOBAL]: '[policy]\nallowed_tools = ["bash", "read", "write"]\n',
        [PROJECT]: '[policy]\nallowed_tools = ["bash"]\n',
      },
      {
        projectTrusted: true,
        session: { policy: { allowedTools: ['bash'] } },
      },
    );
    // The product layer is the first to set the allow list; global, project
    // and session narrower/wider attempts are reported, never applied.
    expect(runtime.policy.tools.allowSource).toBe('product');
    expect(runtime.policy.tools.denySources).toEqual({ bash: 'enterprise' });
    // The enterprise deny holds against every lower layer...
    expect(isToolAllowed(runtime.policy, 'bash')).toBe(false);
    // ...the product allow still admits what it names, and no lower layer
    // can add a tool the product did not allow (write is dropped).
    expect(isToolAllowed(runtime.policy, 'read')).toBe(true);
    expect(isToolAllowed(runtime.policy, 'write')).toBe(false);
  });

  it('narrows a live lane from an enterprise tool deny (active tools and prompt tools line)', async () => {
    const runtime = load(
      {
        [ENTERPRISE]: '[policy]\ndenied_tools = ["bash"]\n',
        [PROJECT]: '[permissions]\nshell = true\n',
      },
      { projectTrusted: true },
    );
    const lane = await bootFauxLane({
      env: new FakeExecutionEnv({}),
      policy: {
        classes: runtime.permissions.classes,
        toolAllowed: (tool) => isToolAllowedByEnterprise(runtime.policy, tool),
      },
    });
    try {
      // The class-derived allowlist would include bash (shell=true); the
      // enterprise deny removes it from what the lane actually activates.
      const active = await lane.activeTools();
      expect(active).not.toContain('bash');
      expect(active).toContain('read');
      // The prompt tells the model the truth about its own tool set;
      // the committed system entry carries the assembled prompt.
      await lane.run('hi');
      const advertised = promptToolsLine(await lane.systemPrompt());
      expect(advertised).not.toContain('bash');
      expect(advertised).toContain('read');
    } finally {
      await lane.cleanup();
    }
  });

  it('leaves a lane without an enterprise tool policy untouched (control)', async () => {
    const runtime = load(
      { [PROJECT]: '[permissions]\nshell = true\n' },
      { projectTrusted: true },
    );
    const lane = await bootFauxLane({
      env: new FakeExecutionEnv({}),
      policy: {
        classes: runtime.permissions.classes,
        ...(hasToolPolicy(runtime.policy)
          ? {
              toolAllowed: (tool: string) =>
                isToolAllowedByEnterprise(runtime.policy, tool),
            }
          : {}),
      },
    });
    try {
      const active = await lane.activeTools();
      expect(active).toContain('bash');
    } finally {
      await lane.cleanup();
    }
  });
});

describe('checkWorkspaceIgnoreSplit in linked worktrees', () => {
  // Real git fixtures: a linked worktree's `.git` is a file, so only
  // `git rev-parse --git-path info/exclude` (what the writer uses) finds
  // the common-dir exclude. Cleanup removes the worktree first so no
  // stale metadata stays in the main checkout, then the temp dirs.
  const worktrees: Array<{ repo: string; wt: string }> = [];

  afterEach(() => {
    for (const { repo, wt } of worktrees.splice(0)) {
      try {
        git(repo, ['worktree', 'remove', '--force', wt]);
      } catch {
        // The rmSync below still reclaims the directory.
      }
    }
  });

  function git(cwd: string, args: string[]): string {
    // Shared sandbox driver: production reaches git only
    // through the injected gitRunner seam below — plain, never injected.
    driver ??= createGitSandbox();
    return driver.git(args, { cwd }).trim();
  }

  // The injectable runner the prod caller passes: the writer's own probe.
  const gitRunner = gitSync;

  function initRepo(): string {
    const repo = tempDir('kubic-ignore-split-');
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'split@kubic.dev']);
    git(repo, ['config', 'user.name', 'kubic split']);
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', 'base.txt']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
    return repo;
  }

  function linkWorktree(repo: string): string {
    const wt = join(tempDir('kubic-ignore-wt-'), 'checkout');
    git(repo, ['worktree', 'add', '--detach', wt, 'HEAD']);
    worktrees.push({ repo, wt });
    return wt;
  }

  it('finds the writer entries in the common-dir exclude from a linked worktree', () => {
    const repo = initRepo();
    const wt = linkWorktree(repo);
    // Prod fidelity: the real writer puts the entries where rev-parse
    // points — the common dir's info/exclude.
    const written = ensureRuntimeExcludeRules({ cwd: wt });
    expect(written.changed).toBe(true);
    const split = checkWorkspaceIgnoreSplit(
      createNodeFileBridge('/'),
      wt,
      gitRunner,
    );
    expect(split.applicable).toBe(true);
    // The worktree `.git` is a file: the legacy `${cwd}/.git/info/exclude`
    // probe fails ENOTDIR and every entry reports missing.
    expect(split.missing).toEqual([]);
  });

  it('reads the root files from a repo subdirectory', () => {
    const repo = initRepo();
    const written = ensureRuntimeExcludeRules({ cwd: repo });
    expect(written.changed).toBe(true);
    const sub = join(repo, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const split = checkWorkspaceIgnoreSplit(
      createNodeFileBridge('/'),
      sub,
      gitRunner,
    );
    expect(split.applicable).toBe(true);
    expect(split.missing).toEqual([]);
    expect(split.checked.some((path) => path.endsWith('info/exclude'))).toBe(
      true,
    );
  });

  it('stays inapplicable outside any repository', () => {
    const outside = tempDir('kubic-ignore-outside-');
    const split = checkWorkspaceIgnoreSplit(
      createNodeFileBridge('/'),
      outside,
      gitRunner,
    );
    expect(split.applicable).toBe(false);
    expect(split.missing).toEqual([]);
  });
});

describe('project configuration', () => {
  // The project layer the test writes into a temp directory, so no test reads a
  // config file from the checkout.
  const PROJECT_CONFIG_TOML = `[model]
provider = "local"
id = "llama3"
thinking = "medium"

[approvals]
route = "ask-user"
maxPendingMs = 60000
autoApprove = []
sessionScoped = true
requireJustification = false

[permissions]
filesystem = "workspace-write"
shell = true
network = "none"
git = "workspace"
credentials = "none"

[journal]
retentionDays = 30
`;

  it('keeps every key-effect entry meaningful', () => {
    for (const [key, entry] of Object.entries(RUNTIME_KEY_EFFECTS)) {
      expect(key.length).toBeGreaterThan(0);
      // Every disposition carries words: an effect, a kept decision, or a
      // named pending follow-up.
      expect(effectTextOf(entry).length).toBeGreaterThan(10);
      expect(runtimeKeyDisposition(entry)).not.toBe('unknown');
    }
  });

  it('loads a project .kubic/config.toml and maps every key', () => {
    const project = tempDir('kubic-project-config-');
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(join(project, '.kubic', 'config.toml'), PROJECT_CONFIG_TOML);
    const runtime = loadRuntimeConfig({
      bridge: createNodeFileBridge(project),
      home: '/home/u',
      cwd: project,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
    });
    expect(runtime.model).toEqual({
      provider: 'local',
      id: 'llama3',
      thinking: 'medium',
    });
    expect(runtime.modelSource).toBe('project');
    expect(runtime.approvals.source).toBe('project');
    expect(runtime.permissions.classes.network).toBe('none');
    expect(runtime.journal.retentionDays).toBe(30);
    expect(runtime.projectTrusted).toBe(true);
    const view = effectiveConfigView(runtime);
    expect(view.values.length).toBeGreaterThan(0);
    expect(view.values.every((entry) => entry.layer === 'project')).toBe(true);
    expect(view.values.every((entry) => entry.disposition !== 'unknown')).toBe(
      true,
    );
  });
});
