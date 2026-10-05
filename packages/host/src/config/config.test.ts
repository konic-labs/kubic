// Layered TOML config, precedence, trust gate, example (issue #38) — RED first.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import {
  assertNoBudgetKeys,
  BudgetKeyError,
  COMMITTED_CONFIG_FILES,
  CONFIG_LAYERS,
  ConfigError,
  type ConfigLayer,
  checkGitignoreSplit,
  checkRoleModelRef,
  defaultLayerPaths,
  EXAMPLE_TOML,
  GITIGNORE_REQUIRED_ENTRIES,
  isCommittedConfigPath,
  loadLayered,
  mergeLayered,
  ProjectUntrustedError,
  parseTomlConfig,
  serializeTomlConfig,
} from './config.js';
import { McpUnsupportedError } from './stances.js';

type BridgePick = Pick<FileBridge, 'exists' | 'readTextFile'>;

function fakeBridge(files: Record<string, string>): BridgePick {
  const store = new Map(Object.entries(files));
  return {
    exists: (path: string): boolean => store.has(path),
    readTextFile: (path: string): string => {
      const hit = store.get(path);
      if (hit === undefined) throw new Error(`no such file: ${path}`);
      return hit;
    },
  };
}

describe('config layers (issue #38)', () => {
  it('orders precedence Enterprise > Product > Global > Project > Workspace > Session > Agent', () => {
    expect(CONFIG_LAYERS).toEqual([
      'enterprise',
      'product',
      'global',
      'project',
      'workspace',
      'session',
      'agent',
    ]);
  });

  it('gives the product layer the documented /etc/kubic/product.toml path', () => {
    const paths = defaultLayerPaths({ home: '/home/u', projectRoot: '/repo' });
    expect(paths.product).toBe('/etc/kubic/product.toml');
    expect(paths.enterprise).toBe('/etc/kubic/config.toml');
  });

  it('lets a higher layer win every pairwise contest', () => {
    const pairs: Array<[ConfigLayer, ConfigLayer]> = [
      ['enterprise', 'product'],
      ['product', 'global'],
      ['global', 'project'],
      ['project', 'workspace'],
      ['workspace', 'session'],
      ['session', 'agent'],
    ];
    for (const [higher, lower] of pairs) {
      const merged = mergeLayered([
        {
          layer: lower,
          config: { model: { provider: 'lower', id: 'm' } },
          ...(lower === 'project' ? { trusted: true as const } : {}),
        },
        {
          layer: higher,
          config: { model: { provider: 'higher', id: 'm' } },
          ...(higher === 'project' ? { trusted: true as const } : {}),
        },
      ]);
      expect(merged.config.model?.provider).toBe('higher');
    }
  });

  it('survives lower-override attempts against enterprise keys', () => {
    const merged = mergeLayered([
      { layer: 'agent', config: { model: { provider: 'rogue', id: 'm' } } },
      {
        layer: 'enterprise',
        config: { model: { provider: 'ent', id: 'm' } },
      },
      {
        layer: 'project',
        config: { model: { provider: 'proj', id: 'm' } },
        trusted: true,
      },
    ]);
    expect(merged.config.model?.provider).toBe('ent');
    expect(merged.overriddenAttempts).toContain('model.provider');
  });

  it('merges disjoint keys across layers', () => {
    const merged = mergeLayered([
      { layer: 'global', config: { model: { provider: 'g', id: 'm' } } },
      {
        layer: 'project',
        config: { journal: { retentionDays: 7 } },
        trusted: true,
      },
    ]);
    expect(merged.config.model?.provider).toBe('g');
    expect(merged.config.journal?.retentionDays).toBe(7);
  });
});

describe('prototype-pollution guard (issue #38)', () => {
  it('refuses a [__proto__] section without polluting Object.prototype', () => {
    expect(() => parseTomlConfig('[__proto__]\npolluted = "yes"\n')).toThrow(
      /forbidden key '__proto__'/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses dunder keys in dotted paths', () => {
    expect(() =>
      parseTomlConfig('[agent]\n__proto__.polluted = "yes"\n'),
    ).toThrow(/forbidden key '__proto__'/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('canonical TOML example (issue #38)', () => {
  it('parses the example with every required section', () => {
    const parsed = parseTomlConfig(EXAMPLE_TOML);
    expect(parsed.agent?.name).toBe('kubic');
    expect(parsed.model?.provider).toBe('local');
    expect(parsed.model?.thinking).toBe('medium');
    expect(parsed.modes?.solo).toBe(true);
    expect(parsed.approvals?.route).toBe('ask-user');
    expect(typeof parsed.approvals?.maxPendingMs).toBe('number');
    expect(parsed.journal?.retentionDays).toBe(30);
    expect(parsed.roles?.reviewer?.tools).toContain('read');
    expect(parsed.roles?.implementer?.model).toBe('local/llama3');
    expect(parsed.orchestrator?.root).toBe('.kubic/wt');
    expect(parsed.ui?.theme).toBe('dark');
    expect(parsed.session?.store).toBe('jsonl');
  });

  it('round-trips the example semantically', () => {
    const once = parseTomlConfig(EXAMPLE_TOML);
    const twice = parseTomlConfig(serializeTomlConfig(once));
    expect(twice).toEqual(once);
  });

  it('keeps example.toml in sync with EXAMPLE_TOML', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const onDisk = readFileSync(join(here, 'example.toml'), 'utf8');
    expect(parseTomlConfig(onDisk)).toEqual(parseTomlConfig(EXAMPLE_TOML));
  });

  it('has no default budget keys', () => {
    expect(() =>
      assertNoBudgetKeys(parseTomlConfig(EXAMPLE_TOML)),
    ).not.toThrow();
    expect(JSON.stringify(parseTomlConfig(EXAMPLE_TOML))).not.toContain(
      'budget',
    );
  });

  it('rejects budget sections', () => {
    expect(() =>
      parseTomlConfig(`${EXAMPLE_TOML}\n[budgets]\ndefault = 100\n`),
    ).toThrow(BudgetKeyError);
    expect(() => assertNoBudgetKeys({ budgets: {} })).toThrow(BudgetKeyError);
  });

  it('rejects mcp sections with the unsupported error', () => {
    expect(() =>
      parseTomlConfig(`${EXAMPLE_TOML}\n[mcp]\nenabled = true\n`),
    ).toThrow(/unsupported/i);
  });

  it('rejects unknown sections', () => {
    expect(() => parseTomlConfig('[telemetry]\nenabled = true\n')).toThrow(
      ConfigError,
    );
  });
});

// §58 Enterprise Policy (issue #288): the documented `[policy]` section and
// the `[[audit]]` array-of-tables must load verbatim — an admin who pastes
// the design's example into /etc/kubic/config.toml gets enforcement, not a
// refusal. Unknown keys stay fail-closed and are named.
const S58_POLICY_EXAMPLE = `[policy]
allowed_models = ["claude-sonnet-4-6", "local/*"]
allowed_providers = ["anthropic", "local"]
allowed_tools = ["read", "grep", "find", "ls", "bash", "edit", "write", "git_diff"]
denied_tools = ["network_fetch"]

network_policy = "proxy"
allowed_domains = ["registry.npmjs.org", "github.com"]

filesystem_policy = "workspace-only"
require_credential_broker = true
deny_local_credentials = true

data_policy = "no-external-training"
logging_policy = "full-audit"
agent_policy = { max_agents = 2, max_cost_usd = 5.0 }

[[audit]]
sink = "syslog"
level = "privileged"
`;

describe('§58 [policy] + [[audit]] (issue #288)', () => {
  it('parses the §58 example verbatim, keys normalized for the policy engine', () => {
    const parsed = parseTomlConfig(S58_POLICY_EXAMPLE);
    expect(parsed.policy?.allowedModels).toEqual([
      'claude-sonnet-4-6',
      'local/*',
    ]);
    expect(parsed.policy?.allowedProviders).toEqual(['anthropic', 'local']);
    expect(parsed.policy?.allowedTools).toContain('bash');
    expect(parsed.policy?.deniedTools).toEqual(['network_fetch']);
    expect(parsed.policy?.networkPolicy).toBe('proxy');
    expect(parsed.policy?.allowedDomains).toEqual([
      'registry.npmjs.org',
      'github.com',
    ]);
    expect(parsed.policy?.filesystemPolicy).toBe('workspace-only');
    expect(parsed.policy?.requireCredentialBroker).toBe(true);
    expect(parsed.policy?.denyLocalCredentials).toBe(true);
    expect(parsed.policy?.dataPolicy).toBe('no-external-training');
    expect(parsed.policy?.loggingPolicy).toBe('full-audit');
    expect(parsed.policy?.agentPolicy).toEqual({
      maxAgents: 2,
      maxCostUsd: 5,
    });
    expect(parsed.audit).toEqual([{ sink: 'syslog', level: 'privileged' }]);
  });

  it('accepts the engine vocabulary for network and filesystem policy too', () => {
    const parsed = parseTomlConfig(
      '[policy]\nnetwork_policy = "none"\nfilesystem_policy = "read"\n',
    );
    expect(parsed.policy?.networkPolicy).toBe('none');
    expect(parsed.policy?.filesystemPolicy).toBe('read');
  });

  it('refuses an unknown key inside [policy], naming it', () => {
    expect(() => parseTomlConfig('[policy]\nbogus_key = 1\n')).toThrow(
      /unknown key 'bogus_key'/,
    );
  });

  it('refuses unknown keys and mistyped values inside agent_policy, by path', () => {
    expect(() =>
      parseTomlConfig(
        '[policy]\nagent_policy = { max_agents = 1, bogus = 2 }\n',
      ),
    ).toThrow(/agent_policy.*bogus/);
    expect(() =>
      parseTomlConfig('[policy]\nagent_policy = { max_agents = -1 }\n'),
    ).toThrow(/non-negative/);
  });

  it('refuses unknown network and filesystem policy values by name', () => {
    expect(() => parseTomlConfig('[policy]\nnetwork_policy = "vpn"\n')).toThrow(
      /'policy': 'network_policy' must be one of/,
    );
    expect(() =>
      parseTomlConfig('[policy]\nfilesystem_policy = "everywhere"\n'),
    ).toThrow(/'policy': 'filesystem_policy' must be one of/);
  });

  it('refuses a malformed [policy] value shape by name', () => {
    expect(() =>
      parseTomlConfig('[policy]\nallowed_models = "local/*"\n'),
    ).toThrow(/string array/);
    expect(() =>
      parseTomlConfig('[policy]\nrequire_credential_broker = "yes"\n'),
    ).toThrow(/must be a boolean/);
  });

  it('refuses unknown sink kinds, levels and keys in [[audit]], by name', () => {
    expect(() =>
      parseTomlConfig('[[audit]]\nsink = "carrier-pigeon"\n'),
    ).toThrow(/sink/);
    expect(() =>
      parseTomlConfig('[[audit]]\nsink = "syslog"\nlevel = "secret"\n'),
    ).toThrow(/level/);
    expect(() => parseTomlConfig('[[audit]]\nsink = "syslog"\n')).toThrow(
      /'level' must be a non-empty string/,
    );
    expect(() =>
      parseTomlConfig('[[audit]]\nsink = "syslog"\nlevel = "all"\nbogus = 1\n'),
    ).toThrow(/unknown key 'bogus'/);
  });

  // Review finding (issue #286): docs promise `facility` as "name or
  // number 0–23", so TOML `facility = 19` must parse to the number.
  it('accepts a numeric facility 0–23 in [[audit]]', () => {
    const parsed = parseTomlConfig(
      '[[audit]]\nsink = "syslog"\nlevel = "privileged"\nfacility = 19\n',
    );
    expect(parsed.audit).toEqual([
      { sink: 'syslog', level: 'privileged', facility: 19 },
    ]);
  });

  it('refuses an out-of-range or fractional facility by name', () => {
    expect(() =>
      parseTomlConfig(
        '[[audit]]\nsink = "syslog"\nlevel = "privileged"\nfacility = 99\n',
      ),
    ).toThrow(/facility/);
    expect(() =>
      parseTomlConfig(
        '[[audit]]\nsink = "syslog"\nlevel = "privileged"\nfacility = 1.5\n',
      ),
    ).toThrow(/facility/);
  });

  it('keeps the audit list appendable across multiple [[audit]] tables', () => {
    const parsed = parseTomlConfig(
      '[[audit]]\nsink = "syslog"\nlevel = "privileged"\n\n[[audit]]\nsink = "file"\nlevel = "all"\ntarget = "/var/log/kubic.jsonl"\n',
    );
    expect(parsed.audit).toEqual([
      { sink: 'syslog', level: 'privileged' },
      { sink: 'file', level: 'all', target: '/var/log/kubic.jsonl' },
    ]);
  });

  it('round-trips [policy] and [[audit]] through the serializer', () => {
    const once = parseTomlConfig(S58_POLICY_EXAMPLE);
    const twice = parseTomlConfig(serializeTomlConfig(once));
    expect(twice).toEqual(once);
  });
});

describe('session.retentionDays (issue #119)', () => {
  it('parses the key and refuses malformed values', () => {
    expect(
      parseTomlConfig('[session]\nretentionDays = 30\n').session?.retentionDays,
    ).toBe(30);
    // 0 is legal and means "retention off" — the value must survive parsing
    // so prune can report that, rather than being dropped as falsy.
    expect(
      parseTomlConfig('[session]\nretentionDays = 0\n').session?.retentionDays,
    ).toBe(0);
    expect(() => parseTomlConfig('[session]\nretentionDays = -1\n')).toThrow(
      /non-negative/,
    );
    expect(() => parseTomlConfig('[session]\nretentionDays = "30"\n')).toThrow(
      /non-negative/,
    );
    expect(() => parseTomlConfig('[session]\nretention = 30\n')).toThrow(
      /unknown key/,
    );
  });

  it('is a leaf like any other: the first layer wins and lower attempts are reported', () => {
    const merged = mergeLayered([
      {
        layer: 'global',
        config: parseTomlConfig('[session]\nretentionDays = 14\n'),
      },
      {
        layer: 'project',
        config: parseTomlConfig('[session]\nretentionDays = 3\n'),
        trusted: true,
      },
    ]);
    expect(merged.config.session?.retentionDays).toBe(14);
    expect(merged.overriddenAttempts).toContain('session.retentionDays');
  });
});

describe('[session] compaction keys (issue #239)', () => {
  it('parses autoCompact, reserveTokens and keepRecentTokens', () => {
    const session = parseTomlConfig(
      '[session]\nautoCompact = false\nreserveTokens = 4000\nkeepRecentTokens = 5000\n',
    ).session;
    expect(session?.autoCompact).toBe(false);
    expect(session?.reserveTokens).toBe(4000);
    expect(session?.keepRecentTokens).toBe(5000);
  });

  it('refuses malformed values by key name (fail-closed)', () => {
    expect(() =>
      parseTomlConfig('[session]\nautoCompact = "yes"\n'),
    ).toThrow(/'session': 'autoCompact' must be a boolean/);
    for (const bad of ['-1', '0', '4.5', '"4000"']) {
      expect(() =>
        parseTomlConfig(`[session]\nreserveTokens = ${bad}\n`),
      ).toThrow(/'session': 'reserveTokens' must be a positive integer/);
      expect(() =>
        parseTomlConfig(`[session]\nkeepRecentTokens = ${bad}\n`),
      ).toThrow(/'session': 'keepRecentTokens' must be a positive integer/);
    }
    expect(() => parseTomlConfig('[session]\nauto_compact = false\n')).toThrow(
      /unknown key/,
    );
  });
});

describe('trust-gated project-local config (issue #38)', () => {
  it('refuses untrusted project config pre-trust', () => {
    expect(() =>
      mergeLayered([
        {
          layer: 'project',
          config: { model: { provider: 'p', id: 'm' } },
        },
      ]),
    ).toThrow(ProjectUntrustedError);
  });

  it('loads trusted project config', () => {
    const merged = mergeLayered([
      {
        layer: 'project',
        config: { model: { provider: 'p', id: 'm' } },
        trusted: true,
      },
    ]);
    expect(merged.config.model?.provider).toBe('p');
  });

  it('refuses untrusted project files at load time without reading them', () => {
    const reads: string[] = [];
    const inner = fakeBridge({
      '/repo/.kubic/config.toml': 'garbage [[[',
    });
    const bridge: BridgePick = {
      exists: inner.exists,
      readTextFile: (path: string): string => {
        reads.push(path);
        return inner.readTextFile(path);
      },
    };
    const paths = defaultLayerPaths({
      home: '/home/u',
      projectRoot: '/repo',
    });
    expect(() => loadLayered(bridge, paths, { projectTrusted: false })).toThrow(
      ProjectUntrustedError,
    );
    expect(reads).toEqual([]);
  });

  it('loads layered files through the FileBridge when trusted', () => {
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[model]\nprovider = "g"\nid = "m"\n',
      '/repo/.kubic/config.toml': '[journal]\nretentionDays = 7\n',
    });
    const paths = defaultLayerPaths({
      home: '/home/u',
      projectRoot: '/repo',
    });
    const merged = loadLayered(bridge, paths, { projectTrusted: true });
    expect(merged.config.model?.provider).toBe('g');
    expect(merged.config.journal?.retentionDays).toBe(7);
  });

  it('treats absent files as empty layers', () => {
    const merged = loadLayered(
      fakeBridge({}),
      defaultLayerPaths({
        home: '/home/u',
        projectRoot: '/repo',
      }),
    );
    expect(merged.config).toEqual({});
    expect(merged.overriddenAttempts).toEqual([]);
  });
});

describe('committed vs gitignored split (issue #38)', () => {
  it('commits config + roles, never sessions/journal/artifacts/worktrees', () => {
    expect(isCommittedConfigPath('config.toml')).toBe(true);
    expect(isCommittedConfigPath('roles/reviewer.md')).toBe(true);
    expect(isCommittedConfigPath('sessions/s1.jsonl')).toBe(false);
    expect(isCommittedConfigPath('journal/2026-01-01.jsonl')).toBe(false);
    expect(isCommittedConfigPath('artifacts/out.txt')).toBe(false);
    expect(isCommittedConfigPath('wt/agent-1')).toBe(false);
  });

  it('requires every ignored prefix in .gitignore', () => {
    expect(GITIGNORE_REQUIRED_ENTRIES.length).toBeGreaterThan(0);
    const good = GITIGNORE_REQUIRED_ENTRIES.map((entry) => `${entry}*`).join(
      '\n',
    );
    expect(checkGitignoreSplit(good).missing).toEqual([]);
    const bad = checkGitignoreSplit('# empty\n');
    expect(bad.missing).toEqual([...GITIGNORE_REQUIRED_ENTRIES]);
  });
});

describe('layer paths (issue #38)', () => {
  it('maps global config under home and project config under the repo', () => {
    const paths = defaultLayerPaths({ home: '/home/u', projectRoot: '/repo' });
    expect(paths.global).toBe('/home/u/.kubic/config.toml');
    expect(paths.project).toBe('/repo/.kubic/config.toml');
    expect(typeof paths.enterprise).toBe('string');
    expect(paths.session).toBeUndefined();
    expect(paths.agent).toBeUndefined();
  });

  it('honors an enterprise path override', () => {
    const paths = defaultLayerPaths({
      home: '/home/u',
      projectRoot: '/repo',
      enterprisePath: '/mnt/policy/config.toml',
    });
    expect(paths.enterprise).toBe('/mnt/policy/config.toml');
  });
});

// TOML parser hardening (issue #69): single-quote, escape, and malformed
// branches pinned so dropped guards fail loudly.
describe('TOML parser hardening (issue #69)', () => {
  it('keeps # and = inside single-quoted strings', () => {
    const parsed = parseTomlConfig(
      "[agent]\nname = 'a#b'\n[model]\nid = 'x=y'\nprovider = \"p\"\n",
    );
    expect(parsed.agent?.name).toBe('a#b');
    expect(parsed.model?.id).toBe('x=y');
  });

  it('decodes double-quoted escapes and rejects bad ones', () => {
    const parsed = parseTomlConfig(
      '[agent]\nname = "a\\nb\\tc\\"d\\\\e\\rf"\n',
    );
    expect(parsed.agent?.name).toBe('a\nb\tc"d\\e\rf');
    expect(() => parseTomlConfig('[agent]\nname = "a\\xb"\n')).toThrow(
      /bad escape/,
    );
  });

  it('rejects nested arrays and parses mixed-quote string arrays', () => {
    expect(() => parseTomlConfig('[roles.a]\ntools = [["x"]]\n')).toThrow(
      /nested arrays/,
    );
    const parsed = parseTomlConfig('[roles.a]\ntools = ["a", \'b\']\n');
    expect(parsed.roles?.a?.tools).toEqual(['a', 'b']);
  });

  it('parses [roles.<name>] requires like tools (issue #196)', () => {
    const parsed = parseTomlConfig(
      '[roles.a]\nrequires = ["write", \'bash\']\n',
    );
    expect(parsed.roles?.a?.requires).toEqual(['write', 'bash']);
    expect(() => parseTomlConfig('[roles.a]\nrequires = [["x"]]\n')).toThrow(
      /nested arrays/,
    );
    expect(() => parseTomlConfig('[roles.a]\nrequires = ["x]\n')).toThrow();
  });

  it('rejects unterminated strings in arrays', () => {
    expect(() => parseTomlConfig('[roles.a]\ntools = ["x]\n')).toThrow(
      /unterminated string/,
    );
  });

  it('rejects malformed headers, keys, and assignments', () => {
    expect(() => parseTomlConfig('[bad\n')).toThrow(/bad section header/);
    expect(() => parseTomlConfig('[a b]\n')).toThrow(/bad section header/);
    expect(() => parseTomlConfig('[agent]\nbad key = 1\n')).toThrow(/bad key/);
    expect(() => parseTomlConfig('[agent]\nname\n')).toThrow(
      /expected key = value/,
    );
    expect(() => parseTomlConfig('[agent]\nname = kubic\n')).toThrow(
      /cannot parse/,
    );
  });

  it('rejects duplicate keys and value/table collisions', () => {
    expect(() => parseTomlConfig('[agent]\nname = "a"\nname = "b"\n')).toThrow(
      /duplicate key/,
    );
    expect(() => parseTomlConfig('agent = "x"\n[agent]\nname = "a"\n')).toThrow(
      /already a value/,
    );
  });

  it('parses dotted keys and single-quoted array members', () => {
    const parsed = parseTomlConfig("[roles.a]\ntools = ['read', 'write']\n");
    expect(parsed.roles?.a?.tools).toEqual(['read', 'write']);
  });

  it('tracks quotes before the assignment separator', () => {
    // Malformed lines with a quote ahead of '=' still scan quoted spans
    // before failing key validation — the quote branches are live.
    expect(() => parseTomlConfig("[agent]\n'a=b' = 1\n")).toThrow(/bad key/);
    expect(() => parseTomlConfig('[agent]\n"a=b" = 1\n')).toThrow(/bad key/);
    expect(() => parseTomlConfig('[agent]\n"a\\"b" = 1\n')).toThrow(/bad key/);
  });

  it('passes escapes through nested array items', () => {
    const parsed = parseTomlConfig('[roles.a]\ntools = ["a\\nb", "c"]\n');
    expect(parsed.roles?.a?.tools).toEqual(['a\nb', 'c']);
  });

  it('rejects a trailing backslash as a bad escape', () => {
    expect(() => parseTomlConfig('[agent]\nname = "a\\"\n')).toThrow(
      /bad escape/,
    );
  });

  it('rejects constructor/prototype path segments', () => {
    expect(() => parseTomlConfig('[constructor]\nx = 1\n')).toThrow(
      /forbidden key 'constructor'/,
    );
    expect(() => parseTomlConfig('[agent]\nprototype.x = 1\n')).toThrow(
      /forbidden key 'prototype'/,
    );
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('config validation hardening (issue #69)', () => {
  it('rejects unknown keys per section', () => {
    expect(() => parseTomlConfig('[agent]\nname = "x"\nextra = 1\n')).toThrow(
      /unknown key/,
    );
    expect(() =>
      parseTomlConfig('[modes]\nsolo = true\nturbo = true\n'),
    ).toThrow(/unknown key/);
    // `maxBytes` is a real key (issue #350); anything else under [journal]
    // is still refused by name.
    expect(() => parseTomlConfig('[journal]\nbogus = 1\n')).toThrow(
      /unknown key 'bogus'/,
    );
  });

  it('rejects non-table sections', () => {
    expect(() => parseTomlConfig('agent = "x"\n')).toThrow(/must be a table/);
    expect(() => parseTomlConfig('modes = true\n')).toThrow(/must be a table/);
    expect(() => parseTomlConfig('[roles.a]\nmodel = 42\n')).toThrow(
      /'roles\.a': 'model' must be 'provider\/id'/,
    );
    // The shape is checked too (issue #133): a bare provider can never
    // become a selection, so it is refused by name at parse time.
    expect(() => parseTomlConfig('[roles.a]\nmodel = "local"\n')).toThrow(
      /'roles\.a': 'model' must be 'provider\/id'/,
    );
  });

  it('rejects invalid thinking levels and approval shapes', () => {
    expect(() => parseTomlConfig('[model]\nthinking = "ultra"\n')).toThrow(
      /must be one of/,
    );
    expect(() => parseTomlConfig('[approvals]\nroute = "auto"\n')).toThrow(
      /must be 'ask-user' or 'deny'/,
    );
    expect(() => parseTomlConfig('[approvals]\nautoApprove = "all"\n')).toThrow(
      /string array/,
    );
    expect(() => parseTomlConfig('[approvals]\nautoApprove = [1]\n')).toThrow(
      /string array/,
    );
    expect(() => parseTomlConfig('[modes]\nsolo = "yes"\n')).toThrow(
      /must be a boolean/,
    );
  });

  it('rejects negative numbers and non-string role tools', () => {
    expect(() => parseTomlConfig('[journal]\nretentionDays = -1\n')).toThrow(
      /non-negative number/,
    );
    expect(() => parseTomlConfig('[roles.a]\ntools = "read"\n')).toThrow(
      /string array/,
    );
    expect(() => parseTomlConfig('[roles]\na = "nope"\n')).toThrow(
      /must be a table/,
    );
  });

  it('parses [journal] maxBytes as a positive integer, refusing anything else', () => {
    // §42.4 byte bound (issue #350): the whole store — index + blobs — is
    // pruned to stay under it. 0 is not "off" (unset is): it is a bound
    // nothing fits, so it is refused by name rather than failing every write.
    expect(parseTomlConfig('[journal]\nmaxBytes = 1048576\n').journal).toEqual({
      maxBytes: 1_048_576,
    });
    expect(
      parseTomlConfig('[journal]\nretentionDays = 7\nmaxBytes = 4096\n')
        .journal,
    ).toEqual({ retentionDays: 7, maxBytes: 4096 });
    for (const bad of ['0', '-1', '1.5', '"1MB"']) {
      expect(() => parseTomlConfig(`[journal]\nmaxBytes = ${bad}\n`)).toThrow(
        /'journal': 'maxBytes' must be a positive integer/,
      );
    }
  });

  it('parses [journal] outOfScope as a path array, refusing empty entries by name', () => {
    expect(
      parseTomlConfig('[journal]\noutOfScope = ["build", "coverage"]\n').journal
        ?.outOfScope,
    ).toEqual(['build', 'coverage']);
    // Unset stays unset: no empty list is invented (§35 opt-in).
    expect(
      parseTomlConfig('[journal]\nretentionDays = 7\n').journal?.outOfScope,
    ).toBeUndefined();
    // Same array-validation shape as every other string array key.
    expect(() => parseTomlConfig('[journal]\noutOfScope = "build"\n')).toThrow(
      /string array/,
    );
    expect(() => parseTomlConfig('[journal]\noutOfScope = [42]\n')).toThrow(
      /string array/,
    );
    // An empty entry would match nothing (workspace-relative paths never
    // start with '/'), so it is refused by name rather than carried as dead
    // config — fail-closed like every other key.
    expect(() => parseTomlConfig('[journal]\noutOfScope = [""]\n')).toThrow(
      /'journal': 'outOfScope' entry 1 is empty/,
    );
    expect(() =>
      parseTomlConfig('[journal]\noutOfScope = ["build", "  "]\n'),
    ).toThrow(/'journal': 'outOfScope' entry 2 is empty/);
  });

  it('rejects empty-string required values', () => {
    expect(() => parseTomlConfig('[agent]\nname = ""\n')).toThrow(
      /non-empty string/,
    );
  });

  it('passes non-record values through the budget guard', () => {
    expect(() => assertNoBudgetKeys(null)).not.toThrow();
    expect(() => assertNoBudgetKeys([])).not.toThrow();
    expect(() => assertNoBudgetKeys('budgets')).not.toThrow();
  });
});

describe('orchestrator root hardening (issue #133 review)', () => {
  it('refuses control characters by name, never echoing the value', () => {
    // The root is shipped verbatim as a git exclude entry, so a newline
    // injects arbitrary patterns into `.git/info/exclude` — the pre-merge
    // clean-tree guard and `git add -A` would then silently skip matching
    // paths. A literal ESC (single-quoted TOML) would reach operator-facing
    // messages. Both are refused by name at parse time.
    for (const text of [
      '[orchestrator]\nroot = "x\\n*.log\\n!keep"\n',
      '[orchestrator]\nroot = "wt\\rX"\n',
      "[orchestrator]\nroot = 'wt\u001b[31m'\n",
      '[orchestrator]\nroot = "wt\u0085X"\n',
      '[orchestrator]\nroot = "wt\u202eX"\n',
    ]) {
      expect(() => parseTomlConfig(text), JSON.stringify(text)).toThrow(
        /'orchestrator': 'root' must be a workspace-relative path \(control characters are refused/,
      );
    }
    // The refusal never echoes the hostile bytes: an ESC in the message
    // would reach the operator's terminal.
    try {
      parseTomlConfig("[orchestrator]\nroot = 'wt\u001b[31m'\n");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('\u001b');
      expect((error as Error).message).not.toContain('31m');
    }
  });

  it('refuses a root whose exclude entry would ignore the committed half', () => {
    // D35: `.kubic/config.toml` and `.kubic/roles/*.md` are committed. An
    // exclude entry `.kubic/` (or `.kubic/roles/`) hides them from git, so
    // the root is refused by name — including equivalent spellings of the
    // same directory.
    for (const root of [
      '.kubic',
      '.kubic/roles',
      '.kubic//roles',
      '.kubic/./roles',
    ]) {
      expect(
        () => parseTomlConfig(`[orchestrator]\nroot = "${root}"\n`),
        root,
      ).toThrow(
        /'orchestrator': 'root' must not cover the committed config half/,
      );
    }
    // The shipped parent, its runtime siblings, and a lookalike name stay
    // allowed: the check is segment-wise, never a string prefix.
    for (const root of [
      '.kubic/wt',
      '.kubic/orchestrator',
      'wt',
      '.kubic/roles-archive',
      '.kubic/wt/nested',
    ]) {
      expect(
        parseTomlConfig(`[orchestrator]\nroot = "${root}"\n`).orchestrator
          ?.root,
        root,
      ).toBe(root);
    }
  });

  it('refuses case variants of the committed half (issue #133 fix-cycle-3)', () => {
    // git case-folds ignore patterns on a case-insensitive filesystem
    // (`core.ignorecase=true`, the macOS default), so `.KUBIC/` hides
    // `.kubic/config.toml` and `.kubic/roles/*.md` exactly like `.kubic/`
    // does. The segment compare folds with it: a variant that names the same
    // directory is the same refusal, by name.
    for (const root of [
      '.KUBIC',
      '.Kubic',
      '.KUBIC/roles',
      '.kubic/ROLES',
      '.KUBIC/ROLES',
      '.KUBIC//roles',
    ]) {
      expect(
        () => parseTomlConfig(`[orchestrator]\nroot = "${root}"\n`),
        root,
      ).toThrow(
        /'orchestrator': 'root' must not cover the committed config half/,
      );
    }
    // Case variants that do not name the committed half stay allowed: the
    // check is segment-wise, never a case-folded prefix. `.KUBIC/wt` is the
    // shipped runtime parent's own directory.
    for (const root of [
      '.KUBIC/wt',
      '.Kubic/orchestrator',
      '.kubic/ROLES-archive',
    ]) {
      expect(
        parseTomlConfig(`[orchestrator]\nroot = "${root}"\n`).orchestrator
          ?.root,
        root,
      ).toBe(root);
    }
  });

  it('refuses roots that name the workspace or carry a . segment (issue #133 fix-cycle-3)', () => {
    // A '.' segment names the directory it sits in: `.` is the workspace
    // itself, `./` matches nothing at all, and `foo/.` is spelled `foo`. The
    // derived `<root>/` entry would then ignore nothing — the worktree set
    // would stay untracked and the pre-merge clean-tree guard would refuse
    // every merge. Refused by name, never normalized: the value the operator
    // wrote is the value that would ship.
    for (const root of ['.', './.', './worktrees', 'foo/.', '././x']) {
      expect(
        () => parseTomlConfig(`[orchestrator]\nroot = "${root}"\n`),
        root,
      ).toThrow(
        /'orchestrator': 'root' must not name the workspace or carry a '\.' segment/,
      );
    }
    // A committed-half spelling keeps its own (more specific) refusal: the
    // no-op rule never masks the rule that protects D35's files.
    expect(() =>
      parseTomlConfig('[orchestrator]\nroot = ".kubic/./roles"\n'),
    ).toThrow(
      /'orchestrator': 'root' must not cover the committed config half/,
    );
  });

  it('refuses gitignore metacharacters by name (issue #133 re-review)', () => {
    // The root is shipped verbatim as `<root>/` in `.git/info/exclude`, and
    // git reads that line as a gitignore pattern: `*`/`?`/`[`/`]` make the
    // entry match paths other than the named directory — hiding files from
    // `git add -A` and the pre-merge clean-tree guard — a leading `#` turns
    // it into a comment, and a backslash escapes the next character (a
    // trailing one leaves an entry that matches nothing at all). Refused by
    // name, never escaped into a different rule.
    for (const root of [
      '*',
      '**',
      '.kubic*',
      '.kubi[c]',
      '.kubi?',
      '#x',
      'x\\',
      '\\',
      'a\\b',
    ]) {
      expect(
        () =>
          parseTomlConfig(`[orchestrator]\nroot = ${JSON.stringify(root)}\n`),
        root,
      ).toThrow(
        /'orchestrator': 'root' must be a workspace-relative path \(gitignore metacharacters are refused/,
      );
    }
  });
});

describe('layer merge hardening (issue #69)', () => {
  it('records no attempt when layers agree on a value', () => {
    const merged = mergeLayered([
      { layer: 'global', config: { model: { provider: 'g', id: 'm' } } },
      {
        layer: 'project',
        config: { model: { provider: 'g', id: 'm' } },
        trusted: true,
      },
    ]);
    expect(merged.config.model?.provider).toBe('g');
    expect(merged.overriddenAttempts).toEqual([]);
  });

  it('sorts layers regardless of input order (enterprise still wins)', () => {
    const merged = mergeLayered([
      { layer: 'agent', config: { model: { provider: 'rogue', id: 'm' } } },
      { layer: 'enterprise', config: { model: { provider: 'ent', id: 'm' } } },
    ]);
    expect(merged.config.model?.provider).toBe('ent');
    expect(merged.overriddenAttempts).toEqual(['model.provider']);
  });

  it('lets workspace beat session and session beat agent', () => {
    const merged = mergeLayered([
      { layer: 'agent', config: { model: { provider: 'a', id: 'm' } } },
      { layer: 'session', config: { model: { provider: 's', id: 'm' } } },
      { layer: 'workspace', config: { model: { provider: 'w', id: 'm' } } },
    ]);
    expect(merged.config.model?.provider).toBe('w');
    expect(merged.overriddenAttempts).toEqual(
      expect.arrayContaining(['model.provider']),
    );
  });

  it('accepts an empty untrusted project layer', () => {
    const merged = mergeLayered([{ layer: 'project', config: {} }]);
    expect(merged.config).toEqual({});
  });

  it('treats reordered arrays as changed (order-sensitive compare)', () => {
    const merged = mergeLayered([
      {
        layer: 'global',
        config: { roles: { reviewer: { tools: ['a', 'b'] } } },
      },
      {
        layer: 'project',
        config: { roles: { reviewer: { tools: ['b', 'a'] } } },
        trusted: true,
      },
    ]);
    expect(merged.config.roles?.reviewer?.tools).toEqual(['a', 'b']);
    expect(merged.overriddenAttempts).toEqual(['roles.reviewer.tools']);
  });
});

describe('layered load hardening (issue #69)', () => {
  it('wraps file errors with the layer name', () => {
    const bridge = fakeBridge({ '/etc/kubic/config.toml': '[bad\n' });
    const paths = defaultLayerPaths({
      home: '/home/u',
      projectRoot: '/repo',
    });
    try {
      loadLayered(bridge, paths, { projectTrusted: true });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/layer 'enterprise'/);
    }
  });

  it('wraps MCP violations with the offending layer', () => {
    const paths = defaultLayerPaths({
      home: '/home/u',
      projectRoot: '/repo',
    });
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[mcp]\nenabled = true\n',
    });
    try {
      loadLayered(bridge, paths, { projectTrusted: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(McpUnsupportedError);
      expect((error as Error).message).toMatch(/layer 'global'/);
    }
  });

  it('wraps budget violations with the offending layer', () => {
    const paths = defaultLayerPaths({
      home: '/home/u',
      projectRoot: '/repo',
    });
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[budgets]\ndefault = 1\n',
    });
    expect(() => loadLayered(bridge, paths)).toThrow(/layer 'global'/);
  });

  it('loads the other layers pre-trust when no project file exists', () => {
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[model]\nprovider = "g"\nid = "m"\n',
    });
    const merged = loadLayered(
      bridge,
      defaultLayerPaths({ home: '/home/u', projectRoot: '/repo' }),
      { projectTrusted: false },
    );
    expect(merged.config.model?.provider).toBe('g');
  });

  it('honors workspace roots and the default enterprise path', () => {
    const paths = defaultLayerPaths({
      home: '/home/u',
      projectRoot: '/repo',
      workspaceRoot: '/ws',
    });
    expect(paths.workspace).toBe('/ws/.kubic/config.toml');
    expect(paths.enterprise).toBe('/etc/kubic/config.toml');
    const bridge = fakeBridge({
      '/ws/.kubic/config.toml': '[ui]\ntheme = "light"\n',
    });
    const merged = loadLayered(bridge, paths, { projectTrusted: true });
    expect(merged.config.ui?.theme).toBe('light');
  });
});

describe('config serialization hardening (issue #69)', () => {
  it('emits role tables sorted by name', () => {
    const text = serializeTomlConfig({
      roles: {
        zebra: { model: 'm' },
        alpha: { model: 'm' },
      },
    });
    expect(text.indexOf('[roles.alpha]')).toBeLessThan(
      text.indexOf('[roles.zebra]'),
    );
  });

  it('refuses to serialize nested tables as values', () => {
    expect(() =>
      serializeTomlConfig({ agent: { name: { nested: true } as never } }),
    ).toThrow(/cannot serialize nested tables/);
  });

  it('classifies committed vs runtime paths exactly', () => {
    expect(isCommittedConfigPath('.kubic/config.toml')).toBe(true);
    expect(isCommittedConfigPath('.kubic/roles/a.md')).toBe(true);
    expect(isCommittedConfigPath('other/config.toml')).toBe(false);
    expect(isCommittedConfigPath('.kubic/sessions/x')).toBe(false);
  });

  it('reports only the missing gitignore entries', () => {
    const partial = `.kubic/sessions/\n.kubic/journal/\n`;
    expect(checkGitignoreSplit(partial).missing).toEqual([
      '.kubic/artifacts/',
      '.kubic/wt/',
      '.kubic/orchestrator/',
    ]);
  });

  // Issue #91: the required-entry list is not a second copy of the rule
  // set — it is derived from the module that writes the rules. If the two
  // ever drift, this fails instead of shipping a gate that checks fiction.
  it('derives the required entries from the shipped runtime rules', async () => {
    const shipped = await import('../../../exec/src/runtime-exclude.js');
    expect([...GITIGNORE_REQUIRED_ENTRIES]).toEqual([
      ...shipped.RUNTIME_EXCLUDE_ENTRIES,
    ]);
    // The writer's own output satisfies this checker: if the two ever
    // diverge, the gate built on `checkGitignoreSplit` would be checking
    // rules nobody ships.
    expect(
      checkGitignoreSplit(shipped.applyRuntimeExcludeBlock('').text).missing,
    ).toEqual([]);
  });

  // Issue #91 criterion 2: the committed half must stay trackable, proven
  // against the rules that are actually shipped (not a hand-written list).
  it('keeps every shipped runtime rule off the committed half', async () => {
    const shipped = await import('../../../exec/src/runtime-exclude.js');
    expect([...COMMITTED_CONFIG_FILES]).toEqual(['config.toml', 'roles/']);
    for (const entry of shipped.RUNTIME_EXCLUDE_ENTRIES) {
      const normalized = entry.replace(/^\.kubic\//, '').replace(/\/$/, '');
      expect(isCommittedConfigPath(normalized)).toBe(false);
      expect(isCommittedConfigPath(`.kubic/${normalized}/x`)).toBe(false);
    }
    expect(isCommittedConfigPath('.kubic/config.toml')).toBe(true);
    expect(isCommittedConfigPath('.kubic/roles/reviewer.md')).toBe(true);
  });
});

describe('[verify] section (issue #267)', () => {
  it('parses the four gate commands and the timeout, and round-trips', () => {
    const text =
      '[verify]\ntests = "npm test"\nbuild = "npm run build"\nlint = "npm run lint"\ntypecheck = "npm run typecheck"\ntimeoutMs = 60000\n';
    const parsed = parseTomlConfig(text);
    expect(parsed.verify).toEqual({
      tests: 'npm test',
      build: 'npm run build',
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      timeoutMs: 60000,
    });
    expect(parseTomlConfig(serializeTomlConfig(parsed)).verify).toEqual(
      parsed.verify,
    );
  });

  it('refuses an unknown key, a non-string or blank command and a bad timeout by name', () => {
    expect(() => parseTomlConfig('[verify]\nformat = "x"\n')).toThrow(
      "'verify': unknown key 'format'",
    );
    expect(() => parseTomlConfig('[verify]\ntests = 1\n')).toThrow(
      /'verify': 'tests' must be a non-empty command string/,
    );
    expect(() => parseTomlConfig('[verify]\nlint = "  "\n')).toThrow(
      /'verify': 'lint' must be a non-empty command string/,
    );
    for (const bad of ['0', '-5', '1.5', '"10"']) {
      expect(() => parseTomlConfig(`[verify]\ntimeoutMs = ${bad}\n`)).toThrow(
        /'verify': 'timeoutMs' must be a positive integer/,
      );
    }
    expect(() => parseTomlConfig('verify = 1\n')).toThrow(
      "'[verify]' must be a table",
    );
  });
});

describe('checkRoleModelRef (issue #211)', () => {
  it.each(['llama', '/x', 'x/', ''])(
    'refuses %j with the provider/id message',
    (ref) => {
      expect(() => checkRoleModelRef(ref, 'implementer')).toThrow(
        "'roles.implementer': 'model' must be 'provider/id'",
      );
    },
  );

  it('refuses a blank or non-string ref', () => {
    expect(() => checkRoleModelRef('   ', 'implementer')).toThrow(
      "'roles.implementer': 'model' must be 'provider/id'",
    );
    expect(() => checkRoleModelRef(42, 'implementer')).toThrow(
      "'roles.implementer': 'model' must be 'provider/id'",
    );
  });

  it('passes a provider/id ref and undefined through', () => {
    expect(checkRoleModelRef('g/file', 'implementer')).toBe('g/file');
    expect(checkRoleModelRef(undefined, 'implementer')).toBeUndefined();
  });
});
