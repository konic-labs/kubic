// Layered TOML config, precedence, trust gate, example.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type BridgePick, fakeBridge } from '../test-support/config-bridge.js';
import {
  CONFIG_LAYERS,
  type ConfigLayer,
  defaultLayerPaths,
  mergeLayered,
  parseTomlConfig,
} from './config.js';
import { ConfigError, ProjectUntrustedError } from './errors.js';
import {
  checkGitignoreSplit,
  GITIGNORE_REQUIRED_ENTRIES,
} from './ignore-split.js';
import { loadRuntimeConfig } from './runtime.js';

// The canonical example, as the schema generates it (scripts/gen-config-docs.mjs).
const EXAMPLE_TOML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'example.toml'),
  'utf8',
);

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

// The live loader, given the composition root's inputs for this home and project.
function loadRuntime(
  bridge: BridgePick,
  options: { projectTrusted?: boolean } = {},
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
  });
}

describe('config layers', () => {
  it('orders precedence Enterprise > Product > Global > Project > Session > Agent', () => {
    expect(CONFIG_LAYERS).toEqual([
      'enterprise',
      'product',
      'global',
      'project',
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
      ['project', 'session'],
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
