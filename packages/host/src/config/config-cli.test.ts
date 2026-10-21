// `kubic config`.
// Presentation only over an injected load: the command must never re-derive
// paths, trust, or env overrides of its own, and must fail closed with the
// named reason instead of printing a default.

import { EXIT_FAILED, EXIT_OK } from '@kubic/core/cli/exit-codes';
import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy } from '../policy/index.js';
import { runConfigCommand } from './config-cli.js';
import type { RuntimeConfig } from './runtime-types.js';

function runtime(): RuntimeConfig {
  return {
    config: { model: { provider: 'local', id: 'llama3' } },
    policy: resolveEffectivePolicy([]).policy,
    model: { provider: 'local', id: 'llama3' },
    modelSource: 'global',
    thinking: undefined,
    escalate: undefined,
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
    compaction: { source: 'defaults' },
    journal: {
      retentionDays: 30,
      maxAgeMs: 30 * 86_400_000,
      source: 'project',
    },
    verify: { commands: {} },
    run: {},
    spend: {},
    projectTrusted: true,
    overriddenAttempts: [],
    modelPinOverrides: [],
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

describe('kubic config', () => {
  it('renders the effective values with their layers, exit 0', () => {
    const { lines, out } = collect();
    const code = runConfigCommand({}, { load: runtime, out }).exitCode;
    expect(code).toBe(EXIT_OK);
    const text = lines.join('\n');
    expect(text).toContain('model.provider = "local" (global, consumed)');
    expect(text).toContain('approvals: route=deny (project)');
    expect(text).toContain('journal retention: 30 day(s)');
  });

  it('reports the [verify] commands as shell that runs, with their layer', () => {
    const none = collect();
    runConfigCommand({}, { load: runtime, out: none.out });
    expect(none.lines.join('\n')).toContain(
      'verify: no gate commands — nothing runs after a run settles',
    );
    const { lines, out } = collect();
    const base = runtime();
    base.verify = { commands: { tests: 'npm test', lint: 'npm run lint' } };
    base.sources['verify.tests'] = 'project';
    base.sources['verify.lint'] = 'global';
    runConfigCommand({}, { load: () => base, out });
    expect(lines.join('\n')).toContain(
      'verify: 2 gate command(s) run as shell (sh -c) after each run settles, outside approvals, each recorded in the audit ledger: tests "npm test" (project), lint "npm run lint" (global)',
    );
  });

  it('names retentionDays = 0 as retention off, never as a zero age bound', () => {
    const { lines, out } = collect();
    const base = runtime();
    base.journal = { retentionDays: 0, source: 'project' };
    runConfigCommand({}, { load: () => base, out });
    const text = lines.join('\n');
    expect(text).toContain(
      'journal retention: off (retentionDays 0, no age bound) (project)',
    );
    expect(text).not.toContain('maxAgeMs 0');
  });

  it("renders a role's allowed set with its layer", () => {
    const { lines, out } = collect();
    const base = runtime();
    base.config.roles = {
      reviewer: {
        models: [{ id: 'local/*' }, { id: 'acme/big', thinking: 'high' }],
      },
    };
    base.sources['roles.reviewer.models'] = 'project';
    const code = runConfigCommand({}, { load: () => base, out }).exitCode;
    expect(code).toBe(EXIT_OK);
    expect(lines.join('\n')).toContain(
      'roles.reviewer.models = [{"id":"local/*"}, {"id":"acme/big","thinking":"high"}] (project, consumed)',
    );
  });

  it('emits one machine-readable object covering every projection', () => {
    const { lines, out } = collect();
    expect(
      runConfigCommand({ json: true }, { load: runtime, out }).exitCode,
    ).toBe(EXIT_OK);
    const view = JSON.parse(lines.join('\n')) as Record<string, unknown>;
    expect(view.modelSource).toBe('global');
    expect(view.approvals).toMatchObject({ route: 'deny', source: 'project' });
    expect(view.permissions).toMatchObject({ source: 'defaults' });
    expect(view.journal).toMatchObject({ retentionDays: 30 });
    expect(view.projectTrusted).toBe(true);
    expect(Array.isArray(view.values)).toBe(true);
  });

  it('reports the AGENTS.md files a run here would load, and the ones it would leave out', () => {
    const instructions = {
      block: '<project_instructions/>',
      loaded: [{ path: '/repo/AGENTS.md', bytes: 40_000, truncated: true }],
      skipped: [
        { path: '/repo/pkg/AGENTS.md', reason: 'the directory is not trusted' },
      ],
      enabled: true,
    };
    const human = collect();
    runConfigCommand(
      {},
      { load: runtime, out: human.out, instructions: () => instructions },
    );
    expect(human.lines.at(-1)).toBe(
      'project instructions: 1 AGENTS.md loaded: /repo/AGENTS.md (cut); /repo/pkg/AGENTS.md not loaded (the directory is not trusted)',
    );
    const machine = collect();
    runConfigCommand(
      { json: true },
      { load: runtime, out: machine.out, instructions: () => instructions },
    );
    expect(JSON.parse(machine.lines.join('\n')).instructions).toEqual({
      enabled: true,
      loaded: [{ path: '/repo/AGENTS.md', bytes: 40_000, truncated: true }],
      skipped: [
        { path: '/repo/pkg/AGENTS.md', reason: 'the directory is not trusted' },
      ],
    });
    const off = collect();
    runConfigCommand(
      {},
      {
        load: runtime,
        out: off.out,
        instructions: () => ({ ...instructions, enabled: false }),
      },
    );
    expect(off.lines.at(-1)).toBe(
      'project instructions: off ([agent] projectInstructions = false)',
    );
  });

  it('fails closed with the named reason, never a silent default', () => {
    const { lines, out } = collect();
    const code = runConfigCommand(
      {},
      {
        load: () => {
          throw new Error("layer 'global': unknown section '[telemetry]'");
        },
        out,
      },
    ).exitCode;
    expect(code).toBe(EXIT_FAILED);
    expect(lines.join('\n')).toMatch(/unknown section '\[telemetry\]'/);
  });

  it('redacts secret-shaped material from a load failure', () => {
    const { lines, out } = collect();
    const code = runConfigCommand(
      {},
      {
        load: () => {
          throw new Error('bad value sk-live-abcdef1234567890 in [ui]');
        },
        out,
      },
    ).exitCode;
    expect(code).toBe(EXIT_FAILED);
    // Redacted, not dropped: the reason still reaches the operator.
    expect(lines.join('\n')).toContain('in [ui]');
    expect(lines.join('\n')).not.toContain('sk-live-abcdef1234567890');
  });
});
