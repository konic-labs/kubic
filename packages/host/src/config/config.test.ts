// Layered TOML config, precedence, trust gate, example (issue #38) — RED first.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import {
  assertNoBudgetKeys,
  BudgetKeyError,
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
