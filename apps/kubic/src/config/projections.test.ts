// Composition-root trust wiring: the persisted
// decision under `~/.kubic/trust.json` is what makes a committed
// `.kubic/config.toml` usable, with no env var exported per invocation.
//
// These tests drive the real `loadCliConfig` over temp home/project dirs
// (no network, no paid tokens) and clean every temp dir up in `afterEach`.

// The `cli` config layer on the composition root's own load: `kubic run
// --model`, `kubic tui --model` and `kubic config --model` are one input to the
// ONE load dispatch performs, so the model the projection hands the lane is the
// same model `kubic config` reports — never two derivations that can drift.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  attachSession,
  openSessionStore,
} from '@kubic/agent/lane/session-store';
import { readSessionEntries } from '@kubic/agent/lane/transcript';
import { ModelSelectError } from '@kubic/agent/model-select';
import {
  BACKGROUND_CONTEXT,
  CompactionEntry,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type MutableModels,
} from '@kubic/agent/pi-boundary';
import { NodeExecutionEnv } from '@kubic/exec/env';
import { createNodeFileBridge } from '@kubic/exec/file-bridge';
import {
  effectiveConfigView,
  loadRuntimeConfig,
  NO_PROJECT_TRUST,
  ProjectTrustStore,
  projectTrustStorePath,
} from '@kubic/host/config';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../test/temp-dir.js';
import { runHeadlessPrompt } from '../run/command.js';
import { prodRunDeps } from '../runners/session.js';
import { composePromptSections } from '../session/lane.js';
import {
  doctorConfigProbe,
  loadCliConfig,
  requireRuntimeConfig,
} from './load.js';
import {
  resolveLaneLadder,
  resolveRoleThinking,
  runtimeModelFrozen,
  runtimeModelPin,
  runtimeModelPinNotes,
  runtimePolicy,
  selectModelUnderPolicy,
} from './model-selection.js';
import {
  roleLayersFromConfig,
  runtimeApprovalDeps,
  runtimeCompactionDeps,
  runtimeLaneDeps,
  runtimeRunDeps,
  runtimeSkillsDeps,
  runtimeStreamTuning,
  runtimeSystemPromptSection,
  sessionRetentionDays,
  withRunBounds,
} from './projections.js';

function storeFor(home: string): ProjectTrustStore {
  return new ProjectTrustStore(projectTrustStorePath(home));
}

// The config projections (load.ts, model-selection.ts, projections.ts),
// each driven through the real loadCliConfig over temp dirs (no network, no
// tokens).
// Helpers write one layer file at a time: the global layer needs no trust,
// the project layer loads under KUBIC_TRUST_PROJECT=1.
function globalHome(toml: string): { home: string; cwd: string } {
  const home = tempDir('kubic-proj-home-');
  const cwd = tempDir('kubic-proj-cwd-');
  mkdirSync(join(home, '.kubic'), { recursive: true });
  writeFileSync(join(home, '.kubic', 'config.toml'), toml);
  return { home, cwd };
}

function trustedProject(toml: string): { home: string; project: string } {
  const home = tempDir('kubic-proj-phome-');
  const project = tempDir('kubic-proj-project-');
  mkdirSync(join(project, '.kubic'), { recursive: true });
  writeFileSync(join(project, '.kubic', 'config.toml'), toml);
  return { home, project };
}

function refusedGlobal(): ReturnType<typeof loadCliConfig> {
  const { home, cwd } = globalHome('[bogus]\nkey = 1\n');
  const refused = loadCliConfig({ cwd, home, env: {} });
  expect(refused.runtime).toBeUndefined();
  expect(refused.error).toContain('bogus');
  return refused;
}

describe('compaction disabled survives a threshold-crossing run', () => {
  // Token math mirrors the agent's threshold test: window 3000, default
  // reserve 16384 clamps to 750, blocking threshold 2250. One exchange of
  // ~1200 + ~1200 estimated tokens crosses it — enabled, it compacts.
  function text(label: string, tokens: number): string {
    return `${label} ${'x'.repeat(Math.max(1, tokens * 4 - label.length - 1))}`;
  }

  function fauxSmallWindow(onRequest: (summary: boolean) => void) {
    const faux = fauxProvider({
      provider: 'faux',
      models: [{ id: 'small', contextWindow: 3000, maxTokens: 1000 }],
    });
    const steps: Parameters<typeof faux.setResponses>[0] = [];
    for (let index = 0; index < 20; index++) {
      steps.push((transcript) => {
        const first = transcript.messages[0];
        onRequest(
          first?.role === 'system' &&
            typeof first.content === 'string' &&
            first.content.includes('summarization'),
        );
        return fauxAssistantMessage(text('a', 1200));
      });
    }
    faux.setResponses(steps);
    const models: MutableModels = createModels();
    models.setProvider(faux.provider);
    return models;
  }

  async function compactionEntriesOf(sessionsRoot: string, sessionId: string) {
    const store = openSessionStore(
      sessionsRoot,
      createNodeFileBridge(sessionsRoot),
    );
    const session = await attachSession(store, sessionId, BACKGROUND_CONTEXT);
    try {
      const entries = await readSessionEntries(
        session.storage,
        BACKGROUND_CONTEXT,
      );
      return entries.filter((entry) => CompactionEntry.is(entry));
    } finally {
      await session.release(BACKGROUND_CONTEXT);
    }
  }

  async function crossedRun(
    compaction: ReturnType<typeof runtimeCompactionDeps>,
  ) {
    // Two turns on one session: the harness evaluates the blocking
    // threshold when the second turn arrives (the agent's threshold test
    // pins the summary reading the pre-u2 prefix), so a single exchange
    // can never compact — the second turn is what crosses.
    let summaries = 0;
    const sessionsRoot = tempDir('kubic-compact-off-sessions-');
    const deps = {
      sessionsRoot,
      models: fauxSmallWindow((summary) => {
        if (summary) summaries += 1;
      }),
      model: { provider: 'faux', id: 'small' },
      env: new NodeExecutionEnv(tempDir('kubic-compact-off-cwd-')),
      ...(compaction === undefined ? {} : { compaction }),
    };
    const first = await runHeadlessPrompt(text('u1', 1200), {}, deps);
    expect(first.terminus).toBe('completed');
    const second = await runHeadlessPrompt(
      text('u2', 20),
      {
        sessionId: first.sessionId,
      },
      deps,
    );
    expect(second.terminus).toBe('completed');
    return {
      summaries,
      entries: await compactionEntriesOf(sessionsRoot, first.sessionId),
    };
  }

  it('autoCompact = false: zero summary requests, zero pi.compaction entries', async () => {
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    try {
      // The full chain: config file → load → projection → lane boot,
      // verbatim — the boot receives exactly what the projection
      // produced, no test-side additions.
      const { home, cwd } = globalHome(
        '[session]\nautoCompact = false\nreserveTokens = 4000\nkeepRecentTokens = 200\n',
      );
      const result = loadCliConfig({ cwd, home, env: {} });
      expect(result.error).toBeUndefined();
      const compaction = runtimeCompactionDeps(result);
      expect(compaction).toEqual({
        enabled: false,
        reserveTokens: 4000,
        keepRecentTokens: 200,
      });
      const crossed = await crossedRun(compaction);
      expect(crossed.summaries).toBe(0);
      expect(crossed.entries).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('same exchange with compaction enabled compacts exactly once (positive control)', async () => {
    // Without the control, the leg above cannot distinguish "disabled
    // works" from "the threshold never crossed": identical numbers
    // with autoCompact left enabled must compact.
    vi.stubEnv('KUBIC_NO_NOTICE', '1');
    try {
      const { home, cwd } = globalHome(
        '[session]\nreserveTokens = 4000\nkeepRecentTokens = 200\n',
      );
      const result = loadCliConfig({ cwd, home, env: {} });
      expect(result.error).toBeUndefined();
      const compaction = runtimeCompactionDeps(result);
      expect(compaction).toEqual({
        reserveTokens: 4000,
        keepRecentTokens: 200,
      });
      const crossed = await crossedRun(compaction);
      expect(crossed.summaries).toBe(1);
      expect(crossed.entries).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('system prompt file section', () => {
  it('projects the file contents as the lane section', () => {
    const { home, cwd } = globalHome(
      '[agent]\nsystemPromptFile = "~/.kubic/SYSTEM.md"\n',
    );
    writeFileSync(join(home, '.kubic', 'SYSTEM.md'), 'Be terse.\n');
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(runtimeSystemPromptSection(result)).toBe('Be terse.\n');
  });

  it('is undefined when nothing is configured', () => {
    const result = loadCliConfig({
      cwd: tempDir('kubic-sysprompt-absent-cwd-'),
      home: tempDir('kubic-sysprompt-absent-home-'),
      env: {},
    });
    expect(result.error).toBeUndefined();
    expect(runtimeSystemPromptSection(result)).toBeUndefined();
  });

  it('prodRunDeps carries it into the run prompt', () => {
    const { home, cwd } = globalHome(
      '[agent]\nsystemPromptFile = "~/.kubic/SYSTEM.md"\n',
    );
    writeFileSync(join(home, '.kubic', 'SYSTEM.md'), 'Be terse.\n');
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(prodRunDeps(result).systemPromptSection).toBe('Be terse.\n');
  });

  it('composes the file section ahead of the skills block (run and tui share it)', () => {
    // The lane appends sections as suffixes after the cache-stable prefix:
    // the user's own instructions come first, discovered context second.
    expect(composePromptSections('FILE', '<skills/>')).toEqual([
      'FILE',
      '<skills/>',
    ]);
    expect(composePromptSections('FILE', undefined)).toEqual(['FILE']);
    expect(composePromptSections(undefined, '<skills/>')).toEqual([
      '<skills/>',
    ]);
    expect(composePromptSections(undefined, undefined)).toBeUndefined();
  });
});

describe('doctorConfigProbe names clean vs refused', () => {
  it('passes on a clean load', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    const probe = doctorConfigProbe(loadCliConfig({ cwd, home, env: {} }));
    expect(probe.id).toBe('config-load');
    expect(probe.ok).toBe(true);
  });

  it('fails by name on a refused load, never on defaults', () => {
    const refused = refusedGlobal();
    const probe = doctorConfigProbe(refused);
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain(refused.error ?? 'bogus');
  });
});

describe('roleLayersFromConfig', () => {
  it('turns [roles.<name>] model/tools into layer inputs', () => {
    const { home, project } = trustedProject(
      '[roles.implementer]\nmodel = "g/file"\ntools = ["read"]\n',
    );
    const result = loadCliConfig({
      cwd: project,
      home,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(result.error).toBeUndefined();
    const runtime = requireRuntimeConfig(result);
    const layers = roleLayersFromConfig(runtime);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.layer).toBe('project');
    expect(layers[0]?.roles.implementer).toEqual({
      model: 'g/file',
      tools: ['read'],
    });
    // Copied out: the projection holds its own array, not the live one.
    expect(layers[0]?.roles.implementer?.tools).not.toBe(
      runtime.config.roles?.implementer?.tools,
    );
    expect(runtime.config.roles?.implementer?.tools).toEqual(['read']);
  });

  it('carries [roles.<name>] escalate with provenance, copied', () => {
    const { home, project } = trustedProject(
      '[roles.implementer]\nescalate = ["local/a", "acme/big"]\n',
    );
    const result = loadCliConfig({
      cwd: project,
      home,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(result.error).toBeUndefined();
    const runtime = requireRuntimeConfig(result);
    const layers = roleLayersFromConfig(runtime);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.roles.implementer).toEqual({
      escalate: ['local/a', 'acme/big'],
    });
    expect(layers[0]?.roles.implementer?.escalate).not.toBe(
      runtime.config.roles?.implementer?.escalate,
    );
  });

  it('resolveLaneLadder prefers the role ladder; model fills the bound', () => {
    const model = {
      steps: ['local/a', 'acme/big'],
      maxEscalations: 1,
    };
    // Role wins outright (even []: the role opts out of climbing).
    expect(resolveLaneLadder(model, ['local/a', 'local/b'])).toEqual({
      steps: ['local/a', 'local/b'],
      maxEscalations: 1,
    });
    expect(resolveLaneLadder(model, [])).toEqual({
      steps: [],
      maxEscalations: 1,
    });
    // No role ladder: the [model] one stands; none anywhere: none.
    expect(resolveLaneLadder(model, undefined)).toEqual(model);
    expect(resolveLaneLadder(undefined, undefined)).toBeUndefined();
  });

  it('orders layers by CONFIG_LAYERS: global before project', () => {
    const home = tempDir('kubic-layers-home-');
    const project = tempDir('kubic-layers-project-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      '[roles.alpha]\ntools = ["read"]\n',
    );
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(
      join(project, '.kubic', 'config.toml'),
      '[roles.beta]\nmodel = "g/file"\n',
    );
    const result = loadCliConfig({
      cwd: project,
      home,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(result.error).toBeUndefined();
    const layers = roleLayersFromConfig(requireRuntimeConfig(result));
    expect(layers.map((entry) => entry.layer)).toEqual(['global', 'project']);
    expect(layers[0]?.roles.alpha).toEqual({ tools: ['read'] });
    expect(layers[1]?.roles.beta).toEqual({ model: 'g/file' });
  });

  it('is empty when no layer declares a role leaf', () => {
    const home = tempDir('kubic-layers-empty-home-');
    const cwd = tempDir('kubic-layers-empty-cwd-');
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(roleLayersFromConfig(requireRuntimeConfig(result))).toEqual([]);
  });
});

describe('remaining projections stay fail-closed', () => {
  it('runtimePolicy is defined on a clean load, undefined on a refusal', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    expect(runtimePolicy(loadCliConfig({ cwd, home, env: {} }))).toBeDefined();
    expect(runtimePolicy(refusedGlobal())).toBeUndefined();
  });

  it('a global pin is not a frozen enterprise pin and overrides nothing', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    const result = loadCliConfig({ cwd, home, env: {} });
    // Frozen is the enterprise [model] path (host runtime tests pin it);
    // a file pin below enterprise never freezes and overrides nothing.
    expect(runtimeModelFrozen(result)).toBe(false);
    expect(runtimeModelPinNotes(result)).toEqual([]);
  });

  it('sessionRetentionDays, approvals, run and lane projections read one load', () => {
    const { home, cwd } = globalHome(
      '[agent]\nname = "alice"\n[approvals]\nroute = "deny"\nmaxPendingMs = 4321\n[session]\nretentionDays = 9\n[permissions]\nshell = false\n',
    );
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(sessionRetentionDays(result)).toBe(9);
    expect(runtimeApprovalDeps(result).route).toBe('deny');
    const run = runtimeRunDeps(result);
    expect(run.policySource).toBe('config');
    expect(run.policyClasses?.shell).toBe(false);
    expect(run.approvals?.route).toBe('deny');
    const lane = runtimeLaneDeps(result);
    expect(lane.agentId).toBe('alice');
    expect(lane.roles?.layers).toEqual([]);
    expect(typeof lane.roles?.trustProject).toBe('function');
    // The fixture home travels on the projection, so
    // both lanes layer the global `~/.kubic/roles` under the documents.
    expect(lane.roles?.homeDir).toBe(home);
    // A refused config contributes nothing: the command fails closed first.
    const refused = refusedGlobal();
    expect(sessionRetentionDays(refused)).toBeUndefined();
    expect(runtimeRunDeps(refused).policySource).toBe('default');
    expect(runtimeLaneDeps(refused)).toEqual({});
  });

  it('fills the run bounds from [run] where the flags set none', () => {
    const { home, cwd } = globalHome(
      '[run]\ntimeoutMs = 90000\nmaxTurns = 7\n',
    );
    const result = loadCliConfig({ cwd, home, env: {} });
    expect(withRunBounds({ prompt: 'p' }, result)).toEqual({
      prompt: 'p',
      timeoutMs: 90000,
      maxTurns: 7,
    });
    // A flag wins over the config, bound by bound.
    expect(
      withRunBounds(
        { prompt: 'p', timeoutMs: 1000, maxTurns: undefined },
        result,
      ),
    ).toEqual({ prompt: 'p', timeoutMs: 1000, maxTurns: 7 });
    // No [run] section and a refused config both leave the options alone.
    const plain = globalHome('[agent]\nname = "x"\n');
    expect(
      withRunBounds(
        { prompt: 'p' },
        loadCliConfig({ cwd: plain.cwd, home: plain.home, env: {} }),
      ),
    ).toEqual({ prompt: 'p' });
    expect(withRunBounds({ prompt: 'p' }, refusedGlobal())).toEqual({
      prompt: 'p',
    });
  });
});

describe('selectModelUnderPolicy gates before the registry', () => {
  function catalog(
    spec: { provider: string; models: string[] }[],
  ): MutableModels {
    const models = createModels();
    for (const entry of spec) {
      const faux = fauxProvider({
        provider: entry.provider,
        models: entry.models.map((id) => ({ id })),
      });
      faux.setResponses([fauxAssistantMessage('ok')]);
      models.setProvider(faux.provider);
    }
    return models;
  }

  it('without a model policy it is exactly selectModel', () => {
    const { home, cwd } = globalHome('[model]\nprovider = "g"\nid = "file"\n');
    const policy = runtimePolicy(loadCliConfig({ cwd, home, env: {} }));
    const models = catalog([
      { provider: 'g', models: ['file'] },
      { provider: 'other', models: ['m'] },
    ]);
    expect(
      selectModelUnderPolicy(
        models,
        { provider: 'other', id: 'm' },
        undefined,
        undefined,
        policy,
      ).id,
    ).toBe('m');
    expect(
      selectModelUnderPolicy(
        models,
        undefined,
        { provider: 'g', id: 'file' },
        undefined,
        policy,
      ).id,
    ).toBe('file');
  });

  it('refuses a gated-out pin by name before any provider call', () => {
    const { home, cwd } = globalHome(
      '[policy]\nallowed_models = ["corp/approved"]\n',
    );
    const policy = runtimePolicy(loadCliConfig({ cwd, home, env: {} }));
    expect(policy).toBeDefined();
    const models = catalog([
      { provider: 'corp', models: ['approved'] },
      { provider: 'other', models: ['m'] },
    ]);
    expect(() =>
      selectModelUnderPolicy(
        models,
        { provider: 'other', id: 'm' },
        undefined,
        undefined,
        policy,
      ),
    ).toThrow(ModelSelectError);
    expect(() =>
      selectModelUnderPolicy(
        models,
        { provider: 'other', id: 'm' },
        undefined,
        undefined,
        policy,
      ),
    ).toThrow(/refused by enterprise policy/);
    // The allowed pin still selects.
    expect(
      selectModelUnderPolicy(
        models,
        { provider: 'corp', id: 'approved' },
        undefined,
        undefined,
        policy,
      ).id,
    ).toBe('approved');
  });

  it('refuses an out-of-set pin by name; in-set selects', () => {
    const models = catalog([
      { provider: 'anthropic', models: ['x'] },
      { provider: 'local', models: ['a'] },
    ]);
    const scope = { role: 'reviewer', models: [{ id: 'local/*' }] };
    // The `--model anthropic/x` path: the explicit selection refuses by
    // name before any provider call, naming the role and its set.
    expect(() =>
      selectModelUnderPolicy(
        models,
        { provider: 'anthropic', id: 'x' },
        undefined,
        undefined,
        undefined,
        scope,
      ),
    ).toThrow(
      /model 'anthropic\/x' refused: role 'reviewer' allows local\/\* only/,
    );
    // The implicit pick lands outside the set: refused too, rather than
    // silently running out-of-set (registration order picks anthropic/x).
    expect(() =>
      selectModelUnderPolicy(
        models,
        undefined,
        undefined,
        undefined,
        undefined,
        scope,
      ),
    ).toThrow(/role 'reviewer' allows/);
    // In-set selects; with no scope the pick is unchanged.
    expect(
      selectModelUnderPolicy(
        models,
        { provider: 'local', id: 'a' },
        undefined,
        undefined,
        undefined,
        scope,
      ).id,
    ).toBe('a');
    expect(
      selectModelUnderPolicy(
        models,
        { provider: 'anthropic', id: 'x' },
        undefined,
        undefined,
        undefined,
        undefined,
      ).id,
    ).toBe('x');
  });

  it('resolveRoleThinking prefers the matching entry over flat', () => {
    const resolved = {
      thinking: 'medium',
      models: [
        { id: 'local/*', thinking: 'low' },
        { id: 'acme/big', thinking: 'high' },
      ],
    };
    // Entry wins on match (specific beats general).
    expect(resolveRoleThinking(resolved, 'local', 'a')).toBe('low');
    expect(resolveRoleThinking(resolved, 'acme', 'big')).toBe('high');
    // Flat default stands without a match; undefined without either.
    expect(
      resolveRoleThinking({ thinking: 'medium', models: [] }, 'x', 'y'),
    ).toBe('medium');
    expect(resolveRoleThinking(undefined, 'x', 'y')).toBeUndefined();
  });
});

describe('end to end: the project [model] pin reaches the prod run runner', () => {
  // Scope says `[agent] model`; `[agent]` only carries `name` (config.ts:
  // checkNoUnknown(agent, {'name'})) — the top-level `[model]` pin is what
  // Evidence describes and what runtimeModelPin projects, so that is what
  // this drives through prodRunDeps, the builder the binary calls.
  it('project [model] provider/id becomes prodRunDeps.model', () => {
    const { home, project } = trustedProject(
      '[model]\nprovider = "g"\nid = "file"\n',
    );
    const result = loadCliConfig({
      cwd: project,
      home,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(runtimeModelPin(result)).toEqual({ provider: 'g', id: 'file' });
    expect(prodRunDeps(result).model).toEqual({ provider: 'g', id: 'file' });
  });
});

describe('request options projection', () => {
  function tunedResult(toml: string): ReturnType<typeof loadCliConfig> {
    const { home, project } = trustedProject(toml);
    const result = loadCliConfig({
      cwd: project,
      home,
      env: { KUBIC_TRUST_PROJECT: '1' },
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  it('is undefined when nothing is tuned', () => {
    const result = tunedResult('[model]\nprovider = "g"\nid = "file"\n');
    expect(runtimeStreamTuning(result)).toBeUndefined();
    expect(prodRunDeps(result).streamTuning).toBeUndefined();
  });

  it('projects [model] tuning and per-role tables through prodRunDeps', () => {
    const result = tunedResult(
      '[model]\nprovider = "g"\nid = "file"\ntimeoutMs = 60000\nmaxRetries = 5\n[roles.reader]\nmodel = "g/file"\nmaxRetries = 1\ncacheRetention = "none"\n',
    );
    expect(runtimeStreamTuning(result)).toEqual({
      model: { timeoutMs: 60000, maxRetries: 5 },
      roles: { reader: { maxRetries: 1, cacheRetention: 'none' } },
    });
    // The builder the binary calls carries the same tables the run boot
    // resolves — dropping the prod spread must not stay green.
    expect(prodRunDeps(result).streamTuning).toEqual(
      runtimeStreamTuning(result),
    );
  });

  it('re-checks the programmatic layers that bypass the parser', () => {
    // Session/agent overrides arrive as objects, never as TOML, so the
    // parser never sees them: the projection refuses a malformed value
    // here instead of handing it to the lane.
    const runtime = loadRuntimeConfig({
      bridge: {
        exists: (): boolean => false,
        readTextFile: (): string => {
          throw new Error('no layers');
        },
      },
      home: tempDir('kubic-stream-fail-home-'),
      cwd: tempDir('kubic-stream-fail-cwd-'),
      projectTrusted: true,
      session: { model: { timeoutMs: 0 } },
    });
    expect(() =>
      runtimeStreamTuning({
        runtime,
        error: undefined,
        ignoreSplit: { missing: [], checked: [], applicable: false },
        trust: NO_PROJECT_TRUST,
      }),
    ).toThrow(/'model': 'timeoutMs' must be a positive integer/);
  });
});

describe('settings skills from config', () => {
  it('resolves a relative project entry against the config file directory', () => {
    const home = tempDir('kubic-skills-home-');
    const project = tempDir('kubic-skills-project-');
    mkdirSync(join(project, '.kubic'), { recursive: true });
    mkdirSync(join(project, 'shared', 'team'), { recursive: true });
    writeFileSync(
      join(project, '.kubic', 'config.toml'),
      'skills = ["../shared/team"]\n',
    );
    storeFor(home).set(project, true);
    // Launched from a subdirectory: the entry still anchors at the
    // project config, never the invoking cwd.
    const sub = join(project, 'pkg');
    mkdirSync(sub, { recursive: true });
    const result = loadCliConfig({ cwd: sub, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(runtimeSkillsDeps(result)).toEqual({
      settingsSkills: [join(project, 'shared', 'team')],
    });
    expect(result.runtime?.sources.skills).toBe('project');
  });

  it('keeps an absolute global entry as written', () => {
    const home = tempDir('kubic-skills-home-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    const shared = tempDir('kubic-skills-shared-');
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      `skills = ["${shared}"]\n`,
    );
    const project = tempDir('kubic-skills-project-');
    const result = loadCliConfig({ cwd: project, home, env: {} });
    expect(result.error).toBeUndefined();
    expect(runtimeSkillsDeps(result)).toEqual({ settingsSkills: [shared] });
    expect(result.runtime?.sources.skills).toBe('global');
  });

  it('refuses the project skills with the project file when untrusted', () => {
    const home = tempDir('kubic-skills-home-');
    const project = tempDir('kubic-skills-project-');
    mkdirSync(join(project, '.kubic'), { recursive: true });
    writeFileSync(
      join(project, '.kubic', 'config.toml'),
      'skills = ["./team"]\n',
    );
    const refused = loadCliConfig({ cwd: project, home, env: {} });
    expect(refused.runtime).toBeUndefined();
    expect(refused.error).toContain('refused pre-trust');
  });

  it('reports the effective list in `kubic config`', () => {
    const home = tempDir('kubic-skills-home-');
    mkdirSync(join(home, '.kubic'), { recursive: true });
    const shared = tempDir('kubic-skills-shared-');
    writeFileSync(
      join(home, '.kubic', 'config.toml'),
      `skills = ["${shared}"]\n`,
    );
    const project = tempDir('kubic-skills-project-');
    const result = loadCliConfig({ cwd: project, home, env: {} });
    const view = effectiveConfigView(requireRuntimeConfig(result));
    const row = view.values.find((value) => value.key === 'skills');
    expect(row?.layer).toBe('global');
    expect(row?.value).toContain(shared);
    expect(row?.disposition).toBe('consumed');
  });
});
