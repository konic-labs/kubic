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
  it('orders precedence Enterprise > Global > Project > Workspace > Session > Agent', () => {
    expect(CONFIG_LAYERS).toEqual([
      'enterprise',
      'global',
      'project',
      'workspace',
      'session',
      'agent',
    ]);
  });

  it('lets a higher layer win every pairwise contest', () => {
    const pairs: Array<[ConfigLayer, ConfigLayer]> = [
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
    const bridge = fakeBridge({
      '/repo/.kubic/config.toml': 'garbage [[[',
    });
    const paths = defaultLayerPaths({
      home: '/home/u',
      projectRoot: '/repo',
    });
    expect(() => loadLayered(bridge, paths, { projectTrusted: false })).toThrow(
      ProjectUntrustedError,
    );
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
  });

  it('rejects non-table sections', () => {
    expect(() => parseTomlConfig('agent = "x"\n')).toThrow(/must be a table/);
    expect(() => parseTomlConfig('modes = true\n')).toThrow(/must be a table/);
    expect(() => parseTomlConfig('[roles.a]\nmodel = 42\n')).toThrow(
      /non-empty string/,
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

  it('skips project files pre-trust even when absent layers exist', () => {
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
