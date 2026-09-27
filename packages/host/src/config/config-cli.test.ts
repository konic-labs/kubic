// `kubic config` (issue #90; §50/§78) — RED first.
// Presentation only over an injected load: the command must never re-derive
// paths, trust, or env overrides of its own, and must fail closed with the
// named reason instead of printing a default.
import { describe, expect, it } from 'vitest';
import {
  CONFIG_EXIT_FAIL,
  CONFIG_EXIT_OK,
  runConfigCommand,
} from './config-cli.js';
import type { RuntimeConfig } from './runtime.js';

function runtime(): RuntimeConfig {
  return {
    config: { model: { provider: 'local', id: 'llama3' } },
    model: { provider: 'local', id: 'llama3' },
    modelSource: 'global',
    approvals: {
      policy: {
        route: 'deny',
        autoApprove: [],
        sessionScoped: true,
        maxPendingMs: 60_000,
        requireJustification: false,
      },
      source: 'project',
    },
    permissions: {
      classes: {
        filesystem: 'workspace-write',
        shell: true,
        network: 'none',
        git: 'workspace',
        credentials: 'none',
      },
      source: 'defaults',
    },
    journal: {
      retentionDays: 30,
      maxAgeMs: 30 * 86_400_000,
      source: 'project',
    },
    modes: { solo: true, orchestrator: false, source: 'defaults' },
    budgets: {
      configured: false,
      detail: 'no budgets are defaulted by config (§71)',
    },
    projectTrusted: true,
    overriddenAttempts: [],
    layers: [
      {
        layer: 'global',
        path: '/home/u/.kubic/config.toml',
        present: true,
        trusted: true,
      },
      {
        layer: 'project',
        path: '/repo/.kubic/config.toml',
        present: true,
        trusted: true,
      },
    ],
    sources: { 'model.provider': 'global', 'approvals.route': 'project' },
  };
}

function collect(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line: string) => lines.push(line) };
}

describe('kubic config (issue #90)', () => {
  it('renders the effective values with their layers, exit 0', () => {
    const { lines, out } = collect();
    const code = runConfigCommand([], { load: runtime, out });
    expect(code).toBe(CONFIG_EXIT_OK);
    const text = lines.join('\n');
    expect(text).toContain('model.provider = "local" (global)');
    expect(text).toContain('approvals: route=deny (project)');
    expect(text).toContain('journal retention: 30 day(s)');
    expect(text).toContain('budgets: none');
  });

  it('emits one machine-readable object covering every projection', () => {
    const { lines, out } = collect();
    expect(runConfigCommand(['--json'], { load: runtime, out })).toBe(
      CONFIG_EXIT_OK,
    );
    const view = JSON.parse(lines.join('\n')) as Record<string, unknown>;
    expect(view.modelSource).toBe('global');
    expect(view.approvals).toMatchObject({ route: 'deny', source: 'project' });
    expect(view.permissions).toMatchObject({ source: 'defaults' });
    expect(view.journal).toMatchObject({ retentionDays: 30 });
    expect(view.modes).toMatchObject({ solo: true });
    expect(view.budgets).toMatchObject({ configured: false });
    expect(view.projectTrusted).toBe(true);
    expect(Array.isArray(view.values)).toBe(true);
  });

  it('fails closed with the named reason, never a silent default', () => {
    const { lines, out } = collect();
    const code = runConfigCommand([], {
      load: () => {
        throw new Error("layer 'global': unknown section '[telemetry]'");
      },
      out,
    });
    expect(code).toBe(CONFIG_EXIT_FAIL);
    expect(lines.join('\n')).toMatch(/unknown section '\[telemetry\]'/);
  });

  it('redacts secret-shaped material from a load failure', () => {
    const { lines, out } = collect();
    runConfigCommand([], {
      load: () => {
        throw new Error('bad value sk-live-abcdef1234567890 in [ui]');
      },
      out,
    });
    expect(lines.join('\n')).not.toContain('sk-live-abcdef1234567890');
  });

  it('rejects unknown flags with usage, exit 1', () => {
    const { lines, out } = collect();
    expect(runConfigCommand(['--layers'], { load: runtime, out })).toBe(
      CONFIG_EXIT_FAIL,
    );
    expect(lines.join('\n')).toContain('usage: kubic config [--json]');
  });

  // Issue #127: `config` parses through the shared flag parser now.
  it('refuses a stray operand through the same unknown-flag line', () => {
    const { lines, out } = collect();
    expect(runConfigCommand(['extra'], { load: runtime, out })).toBe(
      CONFIG_EXIT_FAIL,
    );
    expect(lines.join('\n')).toContain('error: unknown flag extra');
    expect(lines.join('\n')).toContain('usage: kubic config [--json]');
  });

  it('names the unknown flag class first in a mixed argv (issue #127)', () => {
    // The shared parser splits a mixed argv into the two classes; like the
    // other migrated commands, the unknown-flag class is named before a
    // stray operand even when the operand came first in argv.
    const { lines, out } = collect();
    expect(
      runConfigCommand(['extra', '--layers'], { load: runtime, out }),
    ).toBe(CONFIG_EXIT_FAIL);
    expect(lines.join('\n')).toContain('error: unknown flag --layers');
    expect(lines.join('\n')).toContain('usage: kubic config [--json]');
  });

  it('accepts the -- end-of-flags terminator like every migrated command', () => {
    const { lines, out } = collect();
    expect(runConfigCommand(['--'], { load: runtime, out })).toBe(
      CONFIG_EXIT_OK,
    );
    expect(lines.join('\n')).toContain('model.provider = "local" (global)');
  });
});
