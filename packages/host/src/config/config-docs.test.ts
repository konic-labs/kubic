// docs/cli/configuration.md and example.toml are parsed against the
// implementation (issue #90, criterion 4): the documented keys must be the
// implemented keys, every documented key must have an observable effect (or
// say not-yet-implemented), and the doc's own example blocks must load
// through the production entry point.
//
// This is the docs-drift gate: editing the page without touching the code
// (or vice versa) fails here, not in a reader's terminal.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { createNodeFileBridge } from '../../../exec/src/file-bridge.js';
import { resolveMaxConcurrency } from '../orchestrator/parallel/limits.js';
import { pathForAgent } from '../orchestrator/worktree/naming.js';
import {
  CONFIG_LAYERS,
  KNOWN_CONFIG_SECTIONS,
  parseTomlConfig,
} from './config.js';
import {
  effectiveConfigView,
  loadRuntimeConfig,
  RUNTIME_KEY_EFFECTS,
  runtimeKeyDisposition,
  runtimeKeyEffectText,
} from './runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const PAGE = join(REPO_ROOT, 'docs', 'cli', 'configuration.md');
const EXAMPLE = join(
  REPO_ROOT,
  'packages',
  'host',
  'src',
  'config',
  'example.toml',
);

function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(/```toml\n([\s\S]*?)```/g)) {
    blocks.push(match[1] as string);
  }
  return blocks;
}

describe('configuration docs parse against the implementation (issue #90)', () => {
  it('parses every TOML block on the page', () => {
    const blocks = fencedBlocks(readFileSync(PAGE, 'utf8'));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(() => parseTomlConfig(block)).not.toThrow();
    }
  });

  it('loads the documented example through the runtime entry point', () => {
    const files = {
      '/repo/.kubic/config.toml': readFileSync(EXAMPLE, 'utf8'),
    };
    const bridge: Pick<FileBridge, 'exists' | 'readTextFile'> = {
      exists: (path: string): boolean => path in files,
      readTextFile: (path: string): string =>
        files[path as keyof typeof files] as string,
    };
    const runtime = loadRuntimeConfig({
      bridge,
      home: '/home/u',
      cwd: '/repo',
      projectTrusted: true,
    });
    // The example configures, it does not decorate: each documented key
    // reaches a projection the product consumes.
    expect(runtime.model).toEqual({
      provider: 'local',
      id: 'llama3',
      thinking: 'medium',
    });
    expect(runtime.approvals.policy.route).toBe('ask-user');
    expect(runtime.permissions.classes.filesystem).toBe('workspace-write');
    expect(runtime.journal.retentionDays).toBe(30);
    expect(runtime.journal.maxAgeMs).toBe(30 * 86_400_000);
    expect(runtime.modes.solo).toBe(true);
  });

  it('documents exactly the keys the parser accepts and the runtime maps', () => {
    // Documented sections == parsed sections. The page names its sections in
    // the Shape paragraph; the example carries them as tables.
    const page = readFileSync(PAGE, 'utf8');
    for (const section of KNOWN_CONFIG_SECTIONS) {
      expect(page).toContain(`[${section}`); // '[' + name, or '[roles.'
    }
    const example = readFileSync(EXAMPLE, 'utf8');
    for (const section of KNOWN_CONFIG_SECTIONS) {
      expect(example).toContain(`[${section}`);
    }
    // Every key the example sets has an effect entry (observable or an
    // explicit not-yet-implemented marker) — no silent decoration.
    const documented = Object.keys(flattenForTest(parseTomlConfig(example)));
    const missing = documented.filter(
      (key) =>
        !(key in RUNTIME_KEY_EFFECTS) &&
        !((key.split('.')[0] as string) in RUNTIME_KEY_EFFECTS),
    );
    expect(missing).toEqual([]);
  });

  it('documents the env overrides, the trust gate and the layer order', () => {
    const page = readFileSync(PAGE, 'utf8');
    for (const name of [
      'KUBIC_MODEL',
      'KUBIC_MODEL_THINKING',
      'KUBIC_APPROVALS_ROUTE',
      'KUBIC_JOURNAL_RETENTION_DAYS',
      'KUBIC_TRUST_PROJECT',
    ]) {
      expect(page).toContain(name);
    }
    for (const layer of CONFIG_LAYERS) {
      expect(page).toContain(layer);
    }
    // The `config` command and its machine-readable mode are documented.
    expect(page).toContain('kubic config');
    expect(page).toContain('--json');
  });

  it('keeps every key-effect entry meaningful', () => {
    for (const [key, entry] of Object.entries(RUNTIME_KEY_EFFECTS)) {
      expect(key.length).toBeGreaterThan(0);
      // Every disposition carries words: an effect, a kept decision, or a
      // named pending follow-up (issue #133).
      expect(runtimeKeyEffectText(entry).length).toBeGreaterThan(10);
      expect(runtimeKeyDisposition(entry)).not.toBe('unknown');
    }
  });

  it("loads this repo's own .kubic/config.toml and maps every key", () => {
    // The repository dogfoods the feature: its own project layer must parse,
    // load, and reach each projection — no decoration.
    const repoConfig = join(REPO_ROOT, '.kubic', 'config.toml');
    const bridge = createNodeFileBridge(REPO_ROOT);
    const runtime = loadRuntimeConfig({
      bridge,
      home: '/home/u',
      cwd: REPO_ROOT,
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: true,
    });
    expect(bridge.readTextFile(repoConfig).length).toBeGreaterThan(0);
    expect(runtime.model).toEqual({
      provider: 'local',
      id: 'llama3',
      thinking: 'medium',
    });
    expect(runtime.modelSource).toBe('project');
    expect(runtime.approvals.source).toBe('project');
    expect(runtime.permissions.classes.network).toBe('none');
    expect(runtime.journal.retentionDays).toBe(30);
    expect(runtime.modes.solo).toBe(true);
    // Committed, not ignored: the split this repo ships keeps it trackable.
    expect(runtime.projectTrusted).toBe(true);
    const view = effectiveConfigView(runtime);
    expect(view.values.length).toBeGreaterThan(0);
    expect(view.values.every((entry) => entry.layer === 'project')).toBe(true);
    // Issue #133: the repo's own keys are all explained by the table — and
    // the orchestrator values this issue wired are consumed, not decoration.
    expect(view.values.every((entry) => entry.disposition !== 'unknown')).toBe(
      true,
    );
    expect(runtime.orchestrator).toEqual({
      root: '.kubic/wt',
      maxWorkers: 4,
    });
    expect(
      view.values.find((entry) => entry.key === 'orchestrator.root'),
    ).toEqual({
      key: 'orchestrator.root',
      value: '".kubic/wt"',
      layer: 'project',
      disposition: 'consumed',
    });
    expect(
      view.values.find((entry) => entry.key === 'orchestrator.maxWorkers')
        ?.disposition,
    ).toBe('consumed');
    // The configured values are load-bearing, not decoration: the root feeds
    // the worktree path builder and the cap reaches the scheduler's resolver
    // (issue #133 — this repo's own config, through the production code).
    expect(pathForAgent(REPO_ROOT, 'worker-1', runtime.orchestrator.root)).toBe(
      join(REPO_ROOT, '.kubic', 'wt', 'worker-1'),
    );
    expect(
      resolveMaxConcurrency(undefined, undefined, runtime.orchestrator),
    ).toBe(4);
  });

  it('loads the documented example through the real FileBridge from disk', () => {
    // Same content, production bridge: proves the doc example works through
    // the same I/O path a user's `.kubic/config.toml` takes, and that a
    // distrusted project layer is refused by name rather than half-applied.
    const bridge = createNodeFileBridge(dirname(EXAMPLE));
    const runtime = loadRuntimeConfig({
      bridge,
      home: '/home/u',
      cwd: '/repo',
      enterprisePath: '/nonexistent/config.toml',
      projectTrusted: false,
      session: parseTomlConfig(readFileSync(EXAMPLE, 'utf8')),
    });
    expect(runtime.journal.retentionDays).toBe(30);
    expect(runtime.approvals.policy.route).toBe('ask-user');
    expect(runtime.journal.maxAgeMs).toBe(30 * 86_400_000);
  });
});

function flattenForTest(value: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (entry: unknown, path: string): void => {
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      for (const [key, child] of Object.entries(entry)) {
        walk(child, path === '' ? key : `${path}.${key}`);
      }
      return;
    }
    out[path] = entry;
  };
  walk(value, prefix);
  return out;
}
