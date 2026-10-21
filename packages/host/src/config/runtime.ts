// Runtime config load at the composition root.
//
// One call turns the six config layers into the values the product
// actually runs on: provider/model selection, approval policy + routes,
// permission classes and journal retention.
// Precedence: enterprise > product > global > project (trust-gated) >
// session > agent, then the documented env overrides, then an
// explicit CLI flag. The first layer to set a leaf owns it; every attempt to override a
// set leaf is reported in `overriddenAttempts`, never applied.
//
// secrets never appear in config — a `$VAR` / `!command` ref anywhere in
// the effective config is refused by name, never substituted or echoed.
//
// File access arrives as the exec FileBridge (I/O confinement): this module
// never imports node:fs. Zero network, zero real processes.

import { validateClasses } from '@kubic/agent/permissions';
import { validatePolicy } from '../approvals/index.js';
import { findProjectRoot } from '../cli/index.js';
import type { EffectivePolicy, PolicyInput } from '../policy/index.js';
import {
  layerPolicyFromConfig,
  resolveEffectivePolicy,
} from '../policy/index.js';
import { parseSecretRef } from '../secret-refs/index.js';
import {
  checkOutOfScopeEntries,
  checkRoleModelRef,
  checkThinkingLevel,
  isRecord,
} from './checks.js';
import type { ApprovalsConfig, ConfigLayer, KubicConfig } from './config.js';
import { checkSessionCompaction } from './config.js';
import { ConfigError } from './errors.js';
import { headlessApprovalsOf } from './headless-approvals.js';
import { adminHooksOf } from './hooks-config.js';
import { mergeLayered } from './layer-merge.js';
import { checkProjectRestriction } from './project-restriction.js';
import {
  envFlag,
  parseEnvModel,
  parseEnvRetention,
  parseEnvRoute,
  RUNTIME_ENV_OVERRIDES,
} from './runtime-env.js';
import {
  LAYER_ORDER,
  type LoadedLayers,
  loadLayers,
  programmaticSourceFor,
} from './runtime-layers.js';
import { runFrom, verifyFrom } from './runtime-run.js';
import type {
  ConfigValueSource,
  ModelPinOverride,
  RuntimeApprovals,
  RuntimeCompaction,
  RuntimeConfig,
  RuntimeConfigInputs,
  RuntimeEscalation,
  RuntimeJournal,
  RuntimeModelSelection,
  RuntimePermissions,
  RuntimeSystemPrompt,
  RuntimeThinking,
} from './runtime-types.js';
import { configKey } from './schema.js';
import { spendCapsOf } from './spend-caps.js';
import { resolveSystemPromptFile } from './system-prompt-file.js';

// Days→ms is the only conversion journal retention needs: bounds are
// ms, the config key is days.
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_APPROVALS_ROUTE = configKey('approvals', 'route').default as
  | 'ask-user'
  | 'deny';

const PERMISSION_KEYS = [
  'filesystem',
  'shell',
  'network',
  'git',
  'credentials',
] as const;

// A secret reference must never live in config — `$VAR` and
// `!command args` are models.json ref forms, resolved at request time. A
// config value shaped like one is refused by name, never echoed: the message
// carries the path, not the material.
function assertNoSecretRefs(config: KubicConfig): void {
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const ref = parseSecretRef(value);
      if (ref.kind === 'env' || ref.kind === 'command') {
        throw new ConfigError(
          `${path || 'config'}: secrets never appear in config — provider keys live in models.json instead (apiKey / header refs, resolved at request time)`,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${path}[${index + 1}]`);
      });
      return;
    }
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        walk(entry, path === '' ? key : `${path}.${key}`);
      }
    }
  };
  walk(config, '');
}

function modelFrom(config: KubicConfig): RuntimeModelSelection | undefined {
  const model = config.model;
  if (model === undefined) return undefined;
  const hasProvider = model.provider !== undefined;
  const hasId = model.id !== undefined;
  if (hasProvider !== hasId) {
    throw new ConfigError(
      "model: provider and 'id' must be set together — a half-specified model pin selects nothing",
    );
  }
  if (!hasProvider) return undefined;
  return {
    provider: model.provider as string,
    id: model.id as string,
    ...(model.thinking === undefined ? {} : { thinking: model.thinking }),
  };
}

function approvalsFrom(
  config: KubicConfig,
  sources: Record<string, ConfigValueSource>,
  routeOverride: 'ask-user' | 'deny' | undefined,
): RuntimeApprovals {
  const approvals: ApprovalsConfig = config.approvals ?? {};
  // The host has exactly one store placement — per session
  // (<session>/approvals.json). A shared, cross-session store is not
  // implemented, so `sessionScoped = false` is refused by name rather than
  // printed as an effective policy that no lane enforces.
  if (approvals.sessionScoped === false) {
    throw new ConfigError(
      "'approvals': 'sessionScoped = false' is not supported — approval decisions are always stored per session (<session>/approvals.json); remove the key or set it to true",
    );
  }
  const route = routeOverride ?? approvals.route ?? DEFAULT_APPROVALS_ROUTE;
  const source: ConfigValueSource =
    routeOverride !== undefined
      ? 'env'
      : (sources['approvals.route'] ?? 'defaults');
  return {
    policy: validatePolicy({
      route,
      autoApprove: approvals.autoApprove ?? [],
      ...(approvals.maxPendingMs === undefined
        ? {}
        : { maxPendingMs: approvals.maxPendingMs }),
      ...(approvals.sessionScoped === undefined
        ? {}
        : { sessionScoped: approvals.sessionScoped }),
      ...(approvals.requireJustification === undefined
        ? {}
        : { requireJustification: approvals.requireJustification }),
    }),
    source,
  };
}

export function loadRuntimeConfig(inputs: RuntimeConfigInputs): RuntimeConfig {
  const env = inputs.env ?? {};
  const trustEnv = env[RUNTIME_ENV_OVERRIDES.trustProject];
  const projectTrusted = inputs.projectTrusted === true || envFlag(trustEnv);
  const loaded = loadLayers(inputs, projectTrusted);
  const merged = mergeLayered(loaded.inputs);
  const config = merged.config;
  assertNoSecretRefs(config);
  const policy = effectivePolicyOf(loaded);
  const projectRestriction = checkProjectRestriction(
    loaded.perLayer,
    loaded.paths.project,
  );
  const hooks = adminHooksOf(loaded.perLayer, loaded.paths.project);
  // Enterprise keys are frozen against every override — a lower file
  // layer, an env override, and a CLI flag included. Nothing un-sets them.
  const frozen = (key: string): boolean => loaded.sources[key] === 'enterprise';
  // KUBIC_MODEL is parsed before the thinking inputs are checked, so a bad
  // model value is the refusal a run reports first.
  const envModelRaw = env[RUNTIME_ENV_OVERRIDES.model];
  const envModel =
    envModelRaw === undefined
      ? undefined
      : parseEnvModel(envModelRaw, RUNTIME_ENV_OVERRIDES.model);
  const { thinking, droppedEnvThinking } = thinkingFrom(
    inputs,
    env,
    config,
    loaded,
    frozen,
  );
  const pin = modelPinFrom(inputs, envModel, config, loaded, frozen, thinking);
  const envRouteRaw = env[RUNTIME_ENV_OVERRIDES.approvalsRoute];
  const approvals = {
    ...approvalsFrom(
      config,
      loaded.sources,
      envRouteRaw === undefined || frozen('approvals.route')
        ? undefined
        : parseEnvRoute(envRouteRaw, RUNTIME_ENV_OVERRIDES.approvalsRoute),
    ),
    ...headlessApprovalsOf(
      loaded.perLayer,
      config.approvals ?? {},
      loaded.paths.project,
    ),
  };
  const { journal, retentionEnvApplies } = journalFrom(
    env,
    config,
    loaded,
    frozen,
  );
  const compaction = compactionFrom(inputs, config, loaded);
  checkRoleSettings(config);
  const verify = verifyFrom(config);

  // Effective provenance: an applied override owns the leaf it replaced, so
  // the view never reports a file layer for a value an override won.
  if (pin.modelSource === 'cli' || pin.modelSource === 'env') {
    loaded.sources['model.provider'] = pin.modelSource;
    loaded.sources['model.id'] = pin.modelSource;
  }
  if (thinking?.source === 'cli' || thinking?.source === 'env') {
    loaded.sources['model.thinking'] = thinking.source;
  }
  if (approvals.source === 'env') loaded.sources['approvals.route'] = 'env';
  if (retentionEnvApplies) loaded.sources['journal.retentionDays'] = 'env';

  return {
    config,
    policy,
    model: pin.model,
    modelSource: pin.modelSource,
    thinking,
    escalate: escalationFrom(config),
    approvals,
    permissions: permissionsFrom(config, loaded),
    journal,
    compaction,
    // [agent] systemPromptFile: resolved + read at load, so
    // the lane boots and the `kubic config` report share one derivation.
    systemPromptFile: systemPromptFileFrom(inputs, config, loaded),
    verify,
    run: runFrom(config),
    projectTrusted,
    ...(projectRestriction === undefined ? {} : { projectRestriction }),
    ...(loaded.managed === undefined ? {} : { managed: loaded.managed }),
    spend: spendCapsOf(loaded.perLayer),
    hooks,
    overriddenAttempts: [
      ...merged.overriddenAttempts,
      ...pin.modelPinOverrides.map(
        (entry) =>
          `model: ${entry.source === 'cli' ? '--model' : 'KUBIC_MODEL'} '${entry.requested}' rejected: enterprise pin '${entry.pinned}' holds`,
      ),
      ...(droppedEnvThinking === undefined ? [] : [droppedEnvThinking]),
    ],
    modelPinOverrides: pin.modelPinOverrides,
    layers: loaded.reports,
    sources: loaded.sources,
  };
}

// Enterprise policy: resolved once, from EACH layer's own
// `[policy]` section in precedence order — never from the pre-flattened
// merge, so a lower layer's added deny accumulates (the first-wins leaf
// merge would drop it) while a lower allow can never lift an enterprise
// deny. Absent `[policy]` anywhere leaves an empty effective policy and
// gates nothing.
function effectivePolicyOf(loaded: LoadedLayers): EffectivePolicy {
  const policyInputs: PolicyInput[] = [];
  for (const entry of loaded.perLayer) {
    const layerPolicy = layerPolicyFromConfig(entry.config);
    if (Object.keys(layerPolicy).length > 0) {
      policyInputs.push({ layer: entry.layer, policy: layerPolicy });
    }
  }
  return resolveEffectivePolicy(policyInputs).policy;
}

// Thinking level: --thinking > KUBIC_MODEL_THINKING >
// the file layers — and an enterprise level is frozen against both (an
// explicit flag is refused by name; the env override is not applied).
function thinkingFrom(
  inputs: RuntimeConfigInputs,
  env: Readonly<Record<string, string | undefined>>,
  config: KubicConfig,
  loaded: LoadedLayers,
  frozen: (key: string) => boolean,
): {
  thinking: RuntimeThinking | undefined;
  droppedEnvThinking: string | undefined;
} {
  const envThinking = checkThinkingLevel(
    env[RUNTIME_ENV_OVERRIDES.modelThinking],
    RUNTIME_ENV_OVERRIDES.modelThinking,
  );
  const cliThinking = checkThinkingLevel(inputs.cli?.thinking, '--thinking');
  const fileThinking = config.model?.thinking;
  if (frozen('model.thinking')) {
    if (cliThinking !== undefined) {
      throw new ConfigError(
        `--thinking ${JSON.stringify(cliThinking)} refused: model.thinking is frozen by the enterprise layer`,
      );
    }
    // An env override a frozen enterprise level drops is reported in
    // `overriddenAttempts` (never applied), mirroring the model-pin
    // overrides. The flag is refused by name above, so only the env input
    // can land here; an equal value overrode nothing.
    return {
      thinking: { level: fileThinking as string, source: 'enterprise' },
      droppedEnvThinking:
        envThinking !== undefined && envThinking !== fileThinking
          ? `model: KUBIC_MODEL_THINKING '${envThinking}' rejected: enterprise thinking '${fileThinking}' holds`
          : undefined,
    };
  }
  if (cliThinking !== undefined) {
    return {
      thinking: { level: cliThinking, source: 'cli' },
      droppedEnvThinking: undefined,
    };
  }
  if (envThinking !== undefined) {
    return {
      thinking: { level: envThinking, source: 'env' },
      droppedEnvThinking: undefined,
    };
  }
  return {
    thinking:
      fileThinking === undefined
        ? undefined
        : {
            level: fileThinking,
            source: loaded.sources['model.thinking'] ?? 'defaults',
          },
    droppedEnvThinking: undefined,
  };
}

// The model pin: an enterprise pin, else --model, else KUBIC_MODEL, else the
// file layers. The selected pin carries the effective thinking level too, so
// `kubic config`'s "selected model … (thinking: …)" line reports what the
// lane boots with.
function modelPinFrom(
  inputs: RuntimeConfigInputs,
  envModel: RuntimeModelSelection | undefined,
  config: KubicConfig,
  loaded: LoadedLayers,
  frozen: (key: string) => boolean,
  thinking: RuntimeThinking | undefined,
): {
  model: RuntimeModelSelection | undefined;
  modelSource: ConfigValueSource;
  modelPinOverrides: ModelPinOverride[];
} {
  const cliModel = inputs.cli?.model;
  const fileModel = modelFrom(config);
  const withThinking = (
    selection: RuntimeModelSelection,
  ): RuntimeModelSelection => {
    const pin = { provider: selection.provider, id: selection.id };
    return thinking === undefined ? pin : { ...pin, thinking: thinking.level };
  };
  if (frozen('model.provider') || frozen('model.id')) {
    const model = fileModel === undefined ? undefined : withThinking(fileModel);
    // A frozen enterprise pin drops every cli/env pin
    // without a word unless it is recorded here — the composition root turns
    // each entry into one stderr note. A pin equal to the enterprise one
    // overrode nothing.
    const modelPinOverrides: ModelPinOverride[] = [];
    if (model !== undefined) {
      const pinned = `${model.provider}/${model.id}`;
      const attempts: Array<
        ['cli' | 'env', RuntimeModelSelection | undefined]
      > = [
        ['cli', cliModel],
        ['env', envModel],
      ];
      for (const [source, attempt] of attempts) {
        if (attempt === undefined) continue;
        const requested = `${attempt.provider}/${attempt.id}`;
        if (requested === pinned) continue;
        modelPinOverrides.push({ source, requested, pinned });
      }
    }
    return { model, modelSource: 'enterprise', modelPinOverrides };
  }
  if (cliModel !== undefined) {
    return {
      model: withThinking(cliModel),
      modelSource: 'cli',
      modelPinOverrides: [],
    };
  }
  if (envModel !== undefined) {
    return {
      model: withThinking(envModel),
      modelSource: 'env',
      modelPinOverrides: [],
    };
  }
  if (fileModel !== undefined) {
    return {
      model: withThinking(fileModel),
      modelSource:
        loaded.sources['model.provider'] ??
        loaded.sources['model.id'] ??
        'defaults',
      modelPinOverrides: [],
    };
  }
  return { model: undefined, modelSource: 'defaults', modelPinOverrides: [] };
}

function journalFrom(
  env: Readonly<Record<string, string | undefined>>,
  config: KubicConfig,
  loaded: LoadedLayers,
  frozen: (key: string) => boolean,
): { journal: RuntimeJournal; retentionEnvApplies: boolean } {
  const envRetentionRaw = env[RUNTIME_ENV_OVERRIDES.journalRetentionDays];
  const retentionEnvApplies =
    envRetentionRaw !== undefined && !frozen('journal.retentionDays');
  const retentionDays = retentionEnvApplies
    ? parseEnvRetention(
        envRetentionRaw as string,
        RUNTIME_ENV_OVERRIDES.journalRetentionDays,
      )
    : config.journal?.retentionDays;
  // Out-of-scope paths: validated here too, because the
  // programmatic session/agent layers never pass through the TOML parser —
  // an empty entry is refused by name, never half-applied.
  const outOfScopeEntries = checkOutOfScopeEntries(
    config.journal?.outOfScope,
    'journal',
  );
  return {
    journal: {
      ...(retentionDays === undefined ? {} : { retentionDays }),
      // 0 is retention off, the reading `kubic journal prune --keep-days 0`
      // has: no age bound is installed. A bound of 0 ms would drop every
      // entry on the next append.
      ...(retentionDays === undefined || retentionDays === 0
        ? {}
        : { maxAgeMs: retentionDays * MS_PER_DAY }),
      ...(config.journal?.maxBytes === undefined
        ? {}
        : { maxBytes: config.journal.maxBytes }),
      ...(outOfScopeEntries === undefined
        ? {}
        : { outOfScope: outOfScopeEntries }),
      source: retentionEnvApplies
        ? 'env'
        : (loaded.sources['journal.retentionDays'] ?? 'defaults'),
    },
    retentionEnvApplies,
  };
}

// Session compaction policy: re-validated here,
// because the programmatic session/agent layers never pass through the
// TOML parser — a bad value there is refused by name, never carried to
// the lane. Unset means the lane defaults (never an invented value here).
function compactionFrom(
  inputs: RuntimeConfigInputs,
  config: KubicConfig,
  loaded: LoadedLayers,
): RuntimeCompaction {
  const sessionCompaction = checkSessionCompaction(
    (config.session ?? {}) as Record<string, unknown>,
    'session',
  );
  // The config key is `autoCompact`; the runtime projection names the lane
  // option (`enabled`) — one spelling per surface, mapped here.
  // Provenance: the highest-precedence layer among the set keys — evaluated
  // per key, not the first-set key's layer in key order. Each key's layer is
  // already its highest-precedence setter (the file merge is first-wins in
  // LAYER_ORDER; the programmatic session/agent fallback trails every file
  // layer), so the minimum rank wins. 'defaults' ranks below every layer and
  // only survives when no key is set at all.
  const rankOf = (source: ConfigValueSource): number => {
    const index = (LAYER_ORDER as readonly string[]).indexOf(source);
    return index === -1 ? LAYER_ORDER.length : index;
  };
  const compactionSource = (
    [
      'session.autoCompact',
      'session.reserveTokens',
      'session.keepRecentTokens',
    ] as const
  )
    .map(
      (key) =>
        loaded.sources[key] ?? programmaticSourceFor(inputs, key) ?? 'defaults',
    )
    .reduce((best, candidate) =>
      rankOf(candidate) < rankOf(best) ? candidate : best,
    );
  return {
    ...(sessionCompaction.autoCompact === undefined
      ? {}
      : { enabled: sessionCompaction.autoCompact }),
    ...(sessionCompaction.reserveTokens === undefined
      ? {}
      : { reserveTokens: sessionCompaction.reserveTokens }),
    ...(sessionCompaction.keepRecentTokens === undefined
      ? {}
      : { keepRecentTokens: sessionCompaction.keepRecentTokens }),
    source: compactionSource,
  };
}

// Per-role model pins and thinking defaults: validated here too, because the
// programmatic session/agent layers never pass through the TOML parser — a
// malformed value is refused by name, never carried to the lane.
function checkRoleSettings(config: KubicConfig): void {
  for (const [name, role] of Object.entries(config.roles ?? {})) {
    checkRoleModelRef(role.model, name);
    checkThinkingLevel(role.thinking, `'roles.${name}': 'thinking'`);
  }
}

// [agent] systemPromptFile: the declaring layer's file
// resolves a relative path; anything else means no declaring file.
// The programmatic session/agent layers merge values without recording
// sources (loadLayers records file layers only), so a key set there
// attributes to the winning programmatic layer in precedence order —
// never to 'defaults', and never refused as ownerless.
function systemPromptFileFrom(
  inputs: RuntimeConfigInputs,
  config: KubicConfig,
  loaded: LoadedLayers,
): RuntimeSystemPrompt | undefined {
  const source =
    loaded.sources['agent.systemPromptFile'] ??
    programmaticSourceFor(inputs, 'agent.systemPromptFile');
  const layerPath =
    source !== undefined && (LAYER_ORDER as readonly string[]).includes(source)
      ? loaded.paths[source as ConfigLayer]
      : undefined;
  return resolveSystemPromptFile({
    bridge: inputs.bridge,
    home: inputs.home,
    projectRoot:
      inputs.projectRoot ??
      findProjectRoot(inputs.bridge, inputs.cwd, inputs.home),
    configured: config.agent?.systemPromptFile,
    source,
    layerPath,
  });
}

// The merged `[model]` escalation ladder: steps
// from the winning layer, bound defaulting to the ladder length so the
// ladder itself bounds when no explicit max is set.
function escalationFrom(config: KubicConfig): RuntimeEscalation | undefined {
  const modelEscalate = config.model?.escalate;
  return modelEscalate === undefined
    ? undefined
    : {
        steps: [...modelEscalate],
        maxEscalations: config.model?.maxEscalations ?? modelEscalate.length,
      };
}

function permissionsFrom(
  config: KubicConfig,
  loaded: LoadedLayers,
): RuntimePermissions {
  return {
    classes: validateClasses(config.permissions ?? {}),
    source:
      PERMISSION_KEYS.map((key) => loaded.sources[`permissions.${key}`]).find(
        (origin) => origin !== undefined,
      ) ?? 'defaults',
  };
}
