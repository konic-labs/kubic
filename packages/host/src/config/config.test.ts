// Layered TOML config, precedence, trust gate, example.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileBridge } from '@kubic/exec/file-bridge';
import { describe, expect, it } from 'vitest';
import { checkRoleModelRef } from './checks.js';
import {
  CONFIG_LAYERS,
  type ConfigLayer,
  checkGitignoreSplit,
  defaultLayerPaths,
  GITIGNORE_REQUIRED_ENTRIES,
  mergeLayered,
  parseTomlConfig,
} from './config.js';
import { ConfigError, ProjectUntrustedError } from './errors.js';
import { loadRuntimeConfig } from './runtime.js';
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

// The canonical example, as the schema generates it (scripts/gen-config-docs.mjs).
const EXAMPLE_TOML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'example.toml'),
  'utf8',
);

describe('config layers', () => {
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

describe('prototype-pollution guard', () => {
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

describe('canonical TOML example', () => {
  it('parses the example with every required section', () => {
    const parsed = parseTomlConfig(EXAMPLE_TOML);
    expect(parsed.agent?.name).toBe('kubic');
    expect(parsed.model?.provider).toBe('local');
    expect(parsed.model?.thinking).toBe('medium');
    expect(parsed.approvals?.route).toBe('ask-user');
    expect(typeof parsed.approvals?.maxPendingMs).toBe('number');
    expect(parsed.journal?.retentionDays).toBe(30);
    expect(parsed.roles?.reviewer?.tools).toContain('read');
    expect(parsed.roles?.implementer?.model).toBe('local/llama3');
    expect(parsed.ui?.theme).toBe('dark');
    expect(parsed.session?.store).toBe('jsonl');
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

// Enterprise policy: the documented `[policy]` section and the `[[audit]]`
// array-of-tables must load verbatim — an admin who pastes the documented
// example into /etc/kubic/config.toml gets enforcement, not a refusal.
// Unknown keys stay fail-closed and are named.
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

describe('request options', () => {
  it('parses [model] timeoutMs/maxRetries/maxRetryDelayMs/cacheRetention', () => {
    const parsed = parseTomlConfig(
      '[model]\nprovider = "local"\nid = "llama3"\ntimeoutMs = 60000\nmaxRetries = 5\nmaxRetryDelayMs = 10000\ncacheRetention = "long"\n',
    );
    expect(parsed.model).toEqual({
      provider: 'local',
      id: 'llama3',
      timeoutMs: 60000,
      maxRetries: 5,
      maxRetryDelayMs: 10000,
      cacheRetention: 'long',
    });
  });

  it('parses [roles.<name>] request options over the [model] ones', () => {
    const parsed = parseTomlConfig(
      '[model]\ntimeoutMs = 60000\n[roles.a]\nmodel = "local/x"\nmaxRetries = 1\ncacheRetention = "none"\n',
    );
    expect(parsed.model?.timeoutMs).toBe(60000);
    expect(parsed.roles?.a).toEqual({
      model: 'local/x',
      maxRetries: 1,
      cacheRetention: 'none',
    });
  });

  it('refuses invalid [model] request options by name', () => {
    expect(() => parseTomlConfig('[model]\ntimeoutMs = 0\n')).toThrow(
      /'model': 'timeoutMs' must be a positive integer/,
    );
    expect(() => parseTomlConfig('[model]\ntimeoutMs = 1.5\n')).toThrow(
      /'model': 'timeoutMs' must be a positive integer/,
    );
    expect(() => parseTomlConfig('[model]\nmaxRetries = -1\n')).toThrow(
      /'model': 'maxRetries' must be a non-negative integer/,
    );
    expect(() => parseTomlConfig('[model]\nmaxRetries = 2.5\n')).toThrow(
      /'model': 'maxRetries' must be a non-negative integer/,
    );
    expect(() => parseTomlConfig('[model]\nmaxRetryDelayMs = -5\n')).toThrow(
      /'model': 'maxRetryDelayMs' must be a non-negative integer/,
    );
    expect(() =>
      parseTomlConfig('[model]\ncacheRetention = "forever"\n'),
    ).toThrow(/'model': 'cacheRetention' must be one of/);
  });

  it('refuses invalid [roles.<name>] request options by name', () => {
    expect(() => parseTomlConfig('[roles.a]\ntimeoutMs = 0\n')).toThrow(
      /'roles\.a': 'timeoutMs' must be a positive integer/,
    );
    expect(() => parseTomlConfig('[roles.a]\nmaxRetries = -1\n')).toThrow(
      /'roles\.a': 'maxRetries' must be a non-negative integer/,
    );
    expect(() =>
      parseTomlConfig('[roles.a]\ncacheRetention = "forever"\n'),
    ).toThrow(/'roles\.a': 'cacheRetention' must be one of/);
  });
});

describe('millisecond keys stay within what a timer can hold', () => {
  // Node clamps a timer delay past 2147483647 ms to 1 ms, so a bound past it
  // would fire at once instead of waiting.
  const tooLong = [
    ['[model]\ntimeoutMs = 2147483648\n', 'model', 'timeoutMs'],
    ['[model]\nmaxRetryDelayMs = 2147483648\n', 'model', 'maxRetryDelayMs'],
    ['[roles.r]\ntimeoutMs = 2147483648\n', 'roles.r', 'timeoutMs'],
    ['[verify]\ntimeoutMs = 2147483648\n', 'verify', 'timeoutMs'],
    ['[approvals]\nmaxPendingMs = 2147483648\n', 'approvals', 'maxPendingMs'],
  ] as const;

  it.each(tooLong)('refuses %j by name', (text, path, key) => {
    expect(() => parseTomlConfig(text)).toThrow(
      `'${path}': '${key}' must be at most 2147483647 milliseconds (about 24.8 days)`,
    );
  });

  it('accepts the longest delay a timer can hold', () => {
    for (const [text] of tooLong) {
      expect(() =>
        parseTomlConfig(text.replace('2147483648', '2147483647')),
      ).not.toThrow();
    }
  });

  it('refuses an approval wait that is not a number', () => {
    expect(() => parseTomlConfig('[approvals]\nmaxPendingMs = inf\n')).toThrow(
      /cannot parse value inf/,
    );
    expect(() =>
      parseTomlConfig('[approvals]\nmaxPendingMs = "forever"\n'),
    ).toThrow("'approvals': 'maxPendingMs' must be a non-negative number");
  });
});

describe('[policy] + [[audit]]', () => {
  it('parses the documented example verbatim, keys normalized for the policy engine', () => {
    const parsed = parseTomlConfig(POLICY_EXAMPLE);
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
    expect(parsed.policy?.dataPolicy).toBe('no-external-training');
    expect(parsed.policy?.loggingPolicy).toBe('full-audit');
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

  // Docs promise `facility` as "name or
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
});

describe('session.retentionDays', () => {
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

describe('[session] compaction keys', () => {
  it('parses autoCompact, reserveTokens and keepRecentTokens', () => {
    const session = parseTomlConfig(
      '[session]\nautoCompact = false\nreserveTokens = 4000\nkeepRecentTokens = 5000\n',
    ).session;
    expect(session?.autoCompact).toBe(false);
    expect(session?.reserveTokens).toBe(4000);
    expect(session?.keepRecentTokens).toBe(5000);
  });

  it('refuses malformed values by key name (fail-closed)', () => {
    expect(() => parseTomlConfig('[session]\nautoCompact = "yes"\n')).toThrow(
      /'session': 'autoCompact' must be a boolean/,
    );
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

describe('[agent] systemPromptFile', () => {
  it('parses the key and refuses malformed values by name', () => {
    expect(
      parseTomlConfig('[agent]\nsystemPromptFile = "SYSTEM.md"\n').agent
        ?.systemPromptFile,
    ).toBe('SYSTEM.md');
    expect(() => parseTomlConfig('[agent]\nsystemPromptFile = 42\n')).toThrow(
      /'agent': 'systemPromptFile' must be a non-empty string/,
    );
    expect(() => parseTomlConfig('[agent]\nsystemPromptFile = ""\n')).toThrow(
      /'agent': 'systemPromptFile' must be a non-empty string/,
    );
    expect(() =>
      parseTomlConfig('[agent]\nsystem_prompt_file = "x"\n'),
    ).toThrow(/unknown key/);
  });
});

// The live loader, given the composition root's inputs for this home and project.
function loadRuntime(
  bridge: BridgePick,
  options: { projectTrusted?: boolean; workspaceRoot?: string } = {},
) {
  return loadRuntimeConfig({
    bridge,
    home: '/home/u',
    cwd: '/repo',
    projectRoot: '/repo',
    env: {},
    ...(options.projectTrusted === undefined
      ? {}
      : { projectTrusted: options.projectTrusted }),
    ...(options.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: options.workspaceRoot }),
  });
}

describe('trust-gated project-local config', () => {
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
    expect(() => loadRuntime(bridge, { projectTrusted: false })).toThrow(
      ProjectUntrustedError,
    );
    expect(reads).toEqual([]);
  });

  it('loads layered files through the FileBridge when trusted', () => {
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[model]\nprovider = "g"\nid = "m"\n',
      '/repo/.kubic/config.toml': '[journal]\nretentionDays = 7\n',
    });
    const merged = loadRuntime(bridge, { projectTrusted: true });
    expect(merged.config.model?.provider).toBe('g');
    expect(merged.config.journal?.retentionDays).toBe(7);
  });

  it('treats absent files as empty layers', () => {
    const merged = loadRuntime(fakeBridge({}));
    expect(merged.config).toEqual({});
    expect(merged.overriddenAttempts).toEqual([]);
  });
});

describe('committed vs gitignored split', () => {
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

describe('layer paths', () => {
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

// TOML parser hardening: single-quote, escape, and malformed
// branches pinned so dropped guards fail loudly.
describe('TOML parser hardening', () => {
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

  it('parses [roles.<name>] requires like tools', () => {
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

describe('config validation hardening', () => {
  it('rejects unknown keys per section', () => {
    expect(() => parseTomlConfig('[agent]\nname = "x"\nextra = 1\n')).toThrow(
      /unknown key/,
    );
    expect(() =>
      parseTomlConfig('[approvals]\nroute = "deny"\nturbo = true\n'),
    ).toThrow(/unknown key/);
    // `maxBytes` is a real key; anything else under [journal]
    // is still refused by name.
    expect(() => parseTomlConfig('[journal]\nbogus = 1\n')).toThrow(
      /unknown key 'bogus'/,
    );
  });

  it('rejects non-table sections', () => {
    expect(() => parseTomlConfig('agent = "x"\n')).toThrow(/must be a table/);
    expect(() => parseTomlConfig('approvals = true\n')).toThrow(
      /must be a table/,
    );
    expect(() => parseTomlConfig('[roles.a]\nmodel = 42\n')).toThrow(
      /'roles\.a': 'model' must be 'provider\/id'/,
    );
    // The shape is checked too: a bare provider can never
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
    expect(() =>
      parseTomlConfig('[approvals]\nsessionScoped = "yes"\n'),
    ).toThrow(/must be a boolean/);
  });

  it('parses [roles.<name>] thinking, refusing unknown levels by name', () => {
    expect(
      parseTomlConfig('[roles.a]\nthinking = "high"\n').roles?.a?.thinking,
    ).toBe('high');
    expect(() => parseTomlConfig('[roles.a]\nthinking = "ultra"\n')).toThrow(
      /'roles\.a': 'thinking' must be one of/,
    );
  });

  it('parses [roles.<name>] models, refusing bad entries by name', () => {
    const parsed = parseTomlConfig(
      '[roles.a]\nmodels = ["local/*", { id = "acme/big", thinking = "high" }]\n',
    );
    expect(parsed.roles?.a?.models).toEqual([
      // String entries normalize to { id } tables: one shape downstream.
      { id: 'local/*' },
      { id: 'acme/big', thinking: 'high' },
    ]);
    // An empty set parses (it means all models).
    expect(
      parseTomlConfig('[roles.a]\nmodels = []\n').roles?.a?.models,
    ).toEqual([]);
    expect(() => parseTomlConfig('[roles.a]\nmodels = "local/*"\n')).toThrow(
      /'roles\.a': 'models' must be an array/,
    );
    expect(() => parseTomlConfig('[roles.a]\nmodels = [["x/y"]]\n')).toThrow(
      /nested arrays are unsupported/,
    );
    expect(() => parseTomlConfig('[roles.a]\nmodels = ["noid"]\n')).toThrow(
      /'roles\.a': 'models\[0\]' must be 'provider\/id' or 'provider\/\*'/,
    );
    expect(() => parseTomlConfig('[roles.a]\nmodels = [42]\n')).toThrow(
      /'roles\.a': 'models\[0\]' must be 'provider\/id' or 'provider\/\*'/,
    );
    // Tables land in the string-array validators nowhere else: a table in
    // `tools` is still refused by its own checker, not the parser.
    expect(() =>
      parseTomlConfig('[roles.a]\ntools = ["read", { x = 1 }]\n'),
    ).toThrow(/'roles\.a': 'tools' must be a string array/);
    expect(() =>
      parseTomlConfig('[roles.a]\nmodels = [{ id = "x/y" }]\n'),
    ).not.toThrow();
    expect(() =>
      parseTomlConfig(
        '[roles.a]\nmodels = [{ id = "x/y", thinking = "ultra" }]\n',
      ),
    ).toThrow(/'models\[0\]\.thinking' must be one of/);
    expect(() =>
      parseTomlConfig('[roles.a]\nmodels = [{ thinking = "low" }]\n'),
    ).toThrow(/'roles\.a\.models\[0\]': 'id' must be a non-empty string/);
    expect(() =>
      parseTomlConfig('[roles.a]\nmodels = [{ id = "x/y", bogus = 1 }]\n'),
    ).toThrow(/'roles\.a\.models\[0\]': unknown key 'bogus'/);
  });

  it('parses [model]/[roles.<name>] escalate + maxEscalations', () => {
    const parsed = parseTomlConfig(
      '[model]\nescalate = ["local/a", "acme/big"]\nmaxEscalations = 2\n' +
        '[roles.a]\nescalate = ["local/a", "local/b"]\n',
    );
    expect(parsed.model?.escalate).toEqual(['local/a', 'acme/big']);
    expect(parsed.model?.maxEscalations).toBe(2);
    expect(parsed.roles?.a?.escalate).toEqual(['local/a', 'local/b']);
    // Unset means no ladder, not an empty one.
    expect(
      parseTomlConfig('[model]\nprovider = "x"\n').model?.escalate,
    ).toBeUndefined();
    expect(() => parseTomlConfig('[model]\nescalate = "local/a"\n')).toThrow(
      /'model': 'escalate' must be an array/,
    );
    expect(() => parseTomlConfig('[model]\nescalate = ["noid"]\n')).toThrow(
      /'model': 'escalate\[0\]' must be 'provider\/id'/,
    );
    expect(() => parseTomlConfig('[model]\nescalate = ["local/*"]\n')).toThrow(
      /'model': 'escalate\[0\]' must be 'provider\/id'/,
    );
    expect(() => parseTomlConfig('[model]\nmaxEscalations = -1\n')).toThrow(
      /'model': 'maxEscalations' must be a non-negative integer/,
    );
    expect(() => parseTomlConfig('[model]\nmaxEscalations = 1.5\n')).toThrow(
      /'model': 'maxEscalations' must be a non-negative integer/,
    );
    expect(() => parseTomlConfig('[roles.a]\nescalate = ["noid"]\n')).toThrow(
      /'roles\.a': 'escalate\[0\]' must be 'provider\/id'/,
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
    // Byte bound: the whole store — index + blobs — is
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
    // Unset stays unset: no empty list is invented.
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
});

describe('layer merge hardening', () => {
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

describe('layered load hardening', () => {
  it('wraps file errors with the layer name', () => {
    const bridge = fakeBridge({ '/etc/kubic/config.toml': '[bad\n' });
    try {
      loadRuntime(bridge, { projectTrusted: true });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/layer 'enterprise'/);
    }
  });

  it('wraps MCP violations with the offending layer', () => {
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[mcp]\nenabled = true\n',
    });
    try {
      loadRuntime(bridge, { projectTrusted: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(McpUnsupportedError);
      expect((error as Error).message).toMatch(/layer 'global'/);
    }
  });

  it('wraps unknown-section violations with the offending layer', () => {
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[telemetry]\nenabled = true\n',
    });
    expect(() => loadRuntime(bridge)).toThrow(/layer 'global'/);
  });

  it('loads the other layers pre-trust when no project file exists', () => {
    const bridge = fakeBridge({
      '/home/u/.kubic/config.toml': '[model]\nprovider = "g"\nid = "m"\n',
    });
    const merged = loadRuntime(bridge, { projectTrusted: false });
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
    const merged = loadRuntime(bridge, {
      projectTrusted: true,
      workspaceRoot: '/ws',
    });
    expect(merged.config.ui?.theme).toBe('light');
  });
});

describe('config serialization hardening', () => {
  it('reports only the missing gitignore entries', () => {
    const partial = `.kubic/sessions/\n.kubic/journal/\n`;
    expect(checkGitignoreSplit(partial).missing).toEqual([
      '.kubic/artifacts/',
      '.kubic/audit/',
    ]);
  });

  // The required-entry list is not a second copy of the rule
  // set — it is derived from the module that writes the rules. If the two
  // ever drift, this fails instead of shipping a gate that checks fiction.
  it('derives the required entries from the shipped runtime rules', async () => {
    const shipped = await import('@kubic/exec/runtime-exclude');
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
});

describe('[verify] section', () => {
  it('parses the four gate commands and the timeout', () => {
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

describe('checkRoleModelRef', () => {
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
