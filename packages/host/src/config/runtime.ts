// Runtime config load at the composition root (issue #90; §35.1, §36, §40,
// §41, §42.4, §71).
//
// One call turns the six config layers into the values the product actually
// runs on: provider/model selection, approval policy + routes, permission
// classes, journal retention, modes, and a fail-closed budget posture.
// Precedence: enterprise > global > project (trust-gated) > workspace >
// session > agent, then the documented env overrides, then an explicit CLI
// flag. The first layer to set a leaf owns it; every attempt to override a
// set leaf is reported in `overriddenAttempts`, never applied.
//
// §71: budgets are NEVER defaulted — a [budgets] key is refused outright
// (config.ts owns that key) and an absent budget key yields no limits, which
// this module reports rather than invents.
// §36: secrets never appear in config — a `$VAR` / `!command` ref anywhere in
// the effective config is refused by name, never substituted or echoed.
//
// File access arrives as the exec FileBridge (I/O confinement): this module
// never imports node:fs. Zero network, zero real processes.

import {
  type PermissionClasses,
  validateClasses,
} from '../../../agents/src/policy.js';
import type { FileBridge } from '../../../exec/src/file-bridge.js';
import { validatePolicy } from '../approvals.js';
import { redactSecretShapes } from '../policy/secret-shapes.js';
import {
  type ApprovalsConfig,
  ConfigError,
  type ConfigLayer,
  checkGitignoreSplit,
  defaultLayerPaths,
  type KubicConfig,
  type LayerInput,
  mergeLayered,
  ProjectUntrustedError,
  parseLayerConfig,
} from './config.js';
import { parseSecretRef } from './secrets.js';

// Where an effective value came from: one of the six config layers, the
// documented environment overrides, the explicit CLI flag, or the product's
// own default when nothing set it.
export type ConfigValueSource = ConfigLayer | 'env' | 'cli' | 'defaults';

// Days→ms is the only conversion journal retention needs: §42.4 bounds are
// ms, the config key is days.
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Documented environment overrides, applied above every file layer and below
// an explicit CLI flag. The names are part of the CLI contract
// (docs/cli/configuration.md) and pinned by test.
export const RUNTIME_ENV_OVERRIDES = {
  model: 'KUBIC_MODEL',
  modelThinking: 'KUBIC_MODEL_THINKING',
  approvalsRoute: 'KUBIC_APPROVALS_ROUTE',
  journalRetentionDays: 'KUBIC_JOURNAL_RETENTION_DAYS',
  trustProject: 'KUBIC_TRUST_PROJECT',
} as const;

export const RUNTIME_DEFAULTS = {
  approvalsRoute: 'ask-user',
  modesSolo: true,
  modesOrchestrator: false,
} as const;

// Every documented config key, with the observable effect it has at runtime —
// or an explicit not-yet-implemented marker. docs/cli/configuration.md and
// example.toml are parsed against THIS table by config-docs.test.ts, so a
// documented key can never quietly stop doing anything.
export type RuntimeKeyEffect =
  | { effect: string }
  | { notYetImplemented: string };

export const RUNTIME_KEY_EFFECTS: Record<string, RuntimeKeyEffect> = {
  'agent.name': {
    notYetImplemented:
      'accepted and reported by `kubic config`; the solo lane names the agent from the session (root) today',
  },
  'model.provider': {
    effect: 'provider selection for `kubic run` (selectModel)',
  },
  'model.id': { effect: 'model selection for `kubic run` (selectModel)' },
  'model.thinking': {
    effect:
      'default thinking level reported by `kubic config`; per-run override is --model',
  },
  'modes.solo': {
    effect:
      'selects solo (the architecture) — solo=true with orchestrator=true is refused',
  },
  'modes.orchestrator': {
    effect:
      'selects orchestrator mode; contradictory [modes] values are refused by name',
  },
  'approvals.route': { effect: 'approval routing (ask-user | deny) — §41' },
  'approvals.maxPendingMs': {
    effect: 'pending-approval bound; a pending ask denies on timeout',
  },
  'approvals.autoApprove': {
    effect: 'explicit-only capability auto-approvals (never inferred)',
  },
  'approvals.sessionScoped': {
    effect:
      'reported in the effective policy; store placement is chosen by the host',
  },
  'approvals.requireJustification': {
    effect: 'reported in the effective policy; asks require justification',
  },
  'permissions.filesystem': {
    effect: 'permission classes for the lane: derived tool allowlist (§40)',
  },
  'permissions.shell': {
    effect: 'permission classes for the lane: derived tool allowlist (§40)',
  },
  'permissions.network': {
    effect: 'permission classes for the lane: derived tool allowlist (§40)',
  },
  'permissions.git': {
    effect: 'permission classes for the lane: derived tool allowlist (§40)',
  },
  'permissions.credentials': {
    effect: 'permission classes for the lane: derived tool allowlist (§40)',
  },
  'journal.retentionDays': {
    effect: 'journal age bound (maxAgeMs) enforced on every append — §42.4',
  },
  roles: {
    notYetImplemented:
      'per-role model/tools are parsed and reported; role documents land with #99',
  },
  'orchestrator.root': {
    notYetImplemented: 'orchestrator worktree root wiring lands with #94/#95',
  },
  'orchestrator.maxWorkers': {
    notYetImplemented: 'orchestrator concurrency wiring lands with #94/#95',
  },
  'ui.theme': {
    notYetImplemented: 'TUI theme selection lands with #88/#96',
  },
  'ui.statusBar': {
    notYetImplemented: 'TUI status-bar selection lands with #88/#96',
  },
  'session.store': {
    notYetImplemented:
      'jsonl is the only store implemented; sqlite/memory remain a separate decision',
  },
  'session.dir': {
    notYetImplemented:
      'the sessions root is host-owned today (~/.kubic/sessions); relocation lands with the session store work',
  },
};

export interface RuntimeModelSelection {
  provider: string;
  id: string;
  thinking?: string;
}

export interface RuntimeApprovals {
  policy: ReturnType<typeof validatePolicy>;
  source: ConfigValueSource;
}

export interface RuntimePermissions {
  classes: PermissionClasses;
  source: ConfigValueSource;
}

export interface RuntimeJournal {
  // Undefined means "no age bound configured" — never an invented default.
  retentionDays?: number;
  maxAgeMs?: number;
  source: ConfigValueSource;
}

export interface RuntimeModes {
  solo: boolean;
  orchestrator: boolean;
  source: ConfigValueSource;
}

export interface RuntimeBudgets {
  // §71: nothing is capped until the operator configures a limit, and config
  // cannot express a budget at all — so this is always false today, reported
  // rather than implied.
  configured: boolean;
  detail: string;
}

export interface ConfigLayerReport {
  layer: ConfigLayer;
  path: string | undefined;
  present: boolean;
  trusted: boolean;
}

export interface RuntimeConfigInputs {
  bridge: Pick<FileBridge, 'exists' | 'readTextFile'>;
  home: string;
  cwd: string;
  workspaceRoot?: string;
  enterprisePath?: string;
  env?: Record<string, string | undefined>;
  // Trust gate for the project layer (§35.1). An explicit true is the
  // caller's accepted trust prompt; KUBIC_TRUST_PROJECT=1 also opts in.
  projectTrusted?: boolean;
  cli?: { model?: RuntimeModelSelection };
  // Session/agent layers arrive programmatically, never as files.
  session?: KubicConfig;
  agent?: KubicConfig;
}

export interface RuntimeConfig {
  config: KubicConfig;
  model: RuntimeModelSelection | undefined;
  modelSource: ConfigValueSource;
  approvals: RuntimeApprovals;
  permissions: RuntimePermissions;
  journal: RuntimeJournal;
  modes: RuntimeModes;
  budgets: RuntimeBudgets;
  projectTrusted: boolean;
  overriddenAttempts: string[];
  layers: ConfigLayerReport[];
  // Leaf path → source, for every key the effective view reports.
  sources: Record<string, ConfigValueSource>;
}

export interface EffectiveConfigValue {
  key: string;
  // Formatted like the TOML value it came from, so the human view and the
  // machine view never disagree about what the value is.
  value: string;
  layer: ConfigValueSource;
}

export interface EffectiveConfigView {
  values: EffectiveConfigValue[];
  sources: Record<string, ConfigValueSource>;
  approvals: {
    route: string;
    source: ConfigValueSource;
    autoApprove: string[];
    maxPendingMs: number;
    sessionScoped: boolean;
    requireJustification: boolean;
  };
  permissions: { classes: PermissionClasses; source: ConfigValueSource };
  journal: {
    retentionDays?: number;
    maxAgeMs?: number;
    source: ConfigValueSource;
  };
  model: RuntimeModelSelection | undefined;
  modelSource: ConfigValueSource;
  modes: RuntimeModes;
  budgets: RuntimeBudgets;
  projectTrusted: boolean;
  overriddenAttempts: string[];
  layers: ConfigLayerReport[];
}

const LAYER_ORDER: readonly ConfigLayer[] = [
  'enterprise',
  'global',
  'project',
  'workspace',
  'session',
  'agent',
];

const PERMISSION_KEYS = [
  'filesystem',
  'shell',
  'network',
  'git',
  'credentials',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === 'string')
    return JSON.stringify(redactSecretShapes(value));
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatValue(item)).join(', ')}]`;
  }
  return JSON.stringify(redactSecretShapes(String(value)));
}

// §36: a secret reference must never live in config — `$VAR` and
// `!command args` are models.json ref forms, resolved at request time. A
// config value shaped like one is refused by name, never echoed: the message
// carries the path, not the material.
function assertNoSecretRefs(config: KubicConfig): void {
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      const ref = parseSecretRef(value);
      if (ref.kind === 'env' || ref.kind === 'command') {
        throw new ConfigError(
          `${path || 'config'}: secrets never appear in config (§36) — declare the ref in models.json instead`,
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

function parseEnvModel(
  raw: string,
  envName: string,
): { provider: string; id: string } {
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new ConfigError(
      `${envName} must be 'provider/id' (got ${JSON.stringify(redactSecretShapes(raw))})`,
    );
  }
  return { provider: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

function parseEnvRetention(raw: string, envName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(
      `${envName} must be a non-negative integer of days (got ${JSON.stringify(redactSecretShapes(raw))})`,
    );
  }
  return Number(raw);
}

function parseEnvRoute(raw: string, envName: string): 'ask-user' | 'deny' {
  if (raw !== 'ask-user' && raw !== 'deny') {
    throw new ConfigError(
      `${envName} must be 'ask-user' or 'deny' (got ${JSON.stringify(redactSecretShapes(raw))})`,
    );
  }
  return raw;
}

function envFlag(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

interface LoadedLayers {
  inputs: LayerInput[];
  sources: Record<string, ConfigValueSource>;
  paths: Record<ConfigLayer, string | undefined>;
  reports: ConfigLayerReport[];
}

// Per-layer parse, in precedence order, with the trust gate applied before
// any project file is read. Each layer's own leaves are recorded so the
// source of an effective value is the layer that set it — never a guess.
function loadLayers(
  inputs: RuntimeConfigInputs,
  projectTrusted: boolean,
): LoadedLayers {
  const paths = defaultLayerPaths({
    home: inputs.home,
    projectRoot: inputs.cwd,
    ...(inputs.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: inputs.workspaceRoot }),
    ...(inputs.enterprisePath === undefined
      ? {}
      : { enterprisePath: inputs.enterprisePath }),
  });
  const layerInputs: LayerInput[] = [];
  const sources: Record<string, ConfigValueSource> = {};
  const reports: ConfigLayerReport[] = [];
  for (const layer of LAYER_ORDER) {
    const path = paths[layer];
    if (layer === 'session' || layer === 'agent') {
      const programmatic = layer === 'session' ? inputs.session : inputs.agent;
      reports.push({
        layer,
        path,
        present: programmatic !== undefined,
        trusted: true,
      });
      if (programmatic !== undefined)
        layerInputs.push({ layer, config: programmatic });
      continue;
    }
    const present = path !== undefined && inputs.bridge.exists(path);
    reports.push({
      layer,
      path,
      present,
      trusted: layer === 'project' ? projectTrusted : true,
    });
    if (layer === 'project' && !projectTrusted) {
      if (present) {
        // Refused pre-trust, before the file is read (§35.1). Named by path
        // so the operator knows exactly which layer is waiting on trust.
        throw new ProjectUntrustedError(
          `project-local config refused pre-trust: ${path} (issue #38)`,
        );
      }
      continue;
    }
    if (!present || path === undefined) continue;
    const parsed = parseLayerConfig(layer, inputs.bridge.readTextFile(path));
    layerInputs.push({
      layer,
      config: parsed,
      ...(layer === 'project' ? { trusted: true as const } : {}),
    });
    for (const leaf of Object.keys(flatten(parsed))) {
      if (!(leaf in sources)) sources[leaf] = layer;
    }
  }
  return { inputs: layerInputs, sources, paths, reports };
}

function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (entry: unknown, path: string): void => {
    if (isRecord(entry)) {
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
  const route =
    routeOverride ?? approvals.route ?? RUNTIME_DEFAULTS.approvalsRoute;
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

function modesFrom(
  config: KubicConfig,
  sources: Record<string, ConfigValueSource>,
): RuntimeModes {
  const modes = config.modes ?? {};
  // Solo is the architecture and delegation is a mode (§3/§10): setting one
  // flag true selects that mode and turns the other off. Only an explicit
  // true/false pair is a contradiction and is refused by name.
  if (modes.solo === true && modes.orchestrator === true) {
    throw new ConfigError(
      'modes: at most one of solo/orchestrator may be true — solo is the architecture, delegation is a mode',
    );
  }
  const solo =
    modes.solo ??
    (modes.orchestrator === true ? false : RUNTIME_DEFAULTS.modesSolo);
  const orchestrator =
    modes.orchestrator ??
    (modes.solo === true ? false : RUNTIME_DEFAULTS.modesOrchestrator);
  const set = modes.solo !== undefined || modes.orchestrator !== undefined;
  return {
    solo,
    orchestrator,
    source: set
      ? (sources['modes.solo'] ?? sources['modes.orchestrator'] ?? 'defaults')
      : 'defaults',
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

  const envModelRaw = env[RUNTIME_ENV_OVERRIDES.model];
  const envModel =
    envModelRaw === undefined
      ? undefined
      : parseEnvModel(envModelRaw, RUNTIME_ENV_OVERRIDES.model);
  const envThinking = env[RUNTIME_ENV_OVERRIDES.modelThinking];
  const cliModel = inputs.cli?.model;
  const fileModel = modelFrom(config);
  // §35.1: enterprise keys are frozen against every override — a lower file
  // layer, an env override, and a CLI flag included. Nothing un-sets them.
  const frozen = (key: string): boolean => loaded.sources[key] === 'enterprise';
  let model: RuntimeModelSelection | undefined;
  let modelSource: ConfigValueSource;
  if (frozen('model.provider') || frozen('model.id')) {
    model = fileModel;
    modelSource = 'enterprise';
  } else if (cliModel !== undefined) {
    model = cliModel;
    modelSource = 'cli';
  } else if (envModel !== undefined) {
    model =
      envThinking === undefined
        ? envModel
        : { ...envModel, thinking: envThinking };
    modelSource = 'env';
  } else if (fileModel !== undefined) {
    model =
      envThinking === undefined
        ? fileModel
        : { ...fileModel, thinking: envThinking };
    modelSource =
      loaded.sources['model.provider'] ??
      loaded.sources['model.id'] ??
      'defaults';
  } else if (envThinking !== undefined) {
    model = undefined;
    modelSource = 'env';
  } else {
    model = undefined;
    modelSource = 'defaults';
  }

  const envRouteRaw = env[RUNTIME_ENV_OVERRIDES.approvalsRoute];
  const approvals = approvalsFrom(
    config,
    loaded.sources,
    envRouteRaw === undefined || frozen('approvals.route')
      ? undefined
      : parseEnvRoute(envRouteRaw, RUNTIME_ENV_OVERRIDES.approvalsRoute),
  );

  const envRetentionRaw = env[RUNTIME_ENV_OVERRIDES.journalRetentionDays];
  const retentionEnvApplies =
    envRetentionRaw !== undefined && !frozen('journal.retentionDays');
  const retentionDays = retentionEnvApplies
    ? parseEnvRetention(
        envRetentionRaw as string,
        RUNTIME_ENV_OVERRIDES.journalRetentionDays,
      )
    : config.journal?.retentionDays;
  const journal: RuntimeJournal = {
    ...(retentionDays === undefined ? {} : { retentionDays }),
    ...(retentionDays === undefined
      ? {}
      : { maxAgeMs: retentionDays * MS_PER_DAY }),
    source: retentionEnvApplies
      ? 'env'
      : (loaded.sources['journal.retentionDays'] ?? 'defaults'),
  };

  // Effective provenance: an applied override owns the leaf it replaced, so
  // the view never reports a file layer for a value an override won.
  if (modelSource === 'cli' && cliModel !== undefined) {
    loaded.sources['model.provider'] = 'cli';
    loaded.sources['model.id'] = 'cli';
  } else if (modelSource === 'env' && envModel !== undefined) {
    loaded.sources['model.provider'] = 'env';
    loaded.sources['model.id'] = 'env';
  }
  if (
    model !== undefined &&
    model.thinking !== undefined &&
    envThinking !== undefined
  ) {
    loaded.sources['model.thinking'] = 'env';
  }
  if (approvals.source === 'env') loaded.sources['approvals.route'] = 'env';
  if (retentionEnvApplies) loaded.sources['journal.retentionDays'] = 'env';

  const rawPermissions = config.permissions ?? {};
  const permissions: RuntimePermissions = {
    classes: validateClasses(rawPermissions),
    source:
      PERMISSION_KEYS.map((key) => loaded.sources[`permissions.${key}`]).find(
        (origin) => origin !== undefined,
      ) ?? 'defaults',
  };

  return {
    config,
    model,
    modelSource,
    approvals,
    permissions,
    journal,
    modes: modesFrom(config, loaded.sources),
    budgets: {
      configured: false,
      detail:
        'no budgets are defaulted by config (§71): nothing is capped until you configure a limit, and [budgets] keys are refused outright',
    },
    projectTrusted,
    overriddenAttempts: merged.overriddenAttempts,
    layers: loaded.reports,
    sources: loaded.sources,
  };
}

// Machine-readable effective values: every set leaf with the layer that owns
// it, plus the projections the product actually consumes. Consumed by
// `kubic config --json` and by `kubic doctor --json` via the same function.
export function effectiveConfigView(
  runtime: RuntimeConfig,
): EffectiveConfigView {
  const values: EffectiveConfigValue[] = [];
  for (const [key, value] of Object.entries(flatten(runtime.config))) {
    values.push({
      key,
      value: formatValue(value),
      layer: runtime.sources[key] ?? 'defaults',
    });
  }
  values.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    values,
    sources: { ...runtime.sources },
    approvals: {
      route: runtime.approvals.policy.route,
      source: runtime.approvals.source,
      autoApprove: [...runtime.approvals.policy.autoApprove],
      maxPendingMs: runtime.approvals.policy.maxPendingMs,
      sessionScoped: runtime.approvals.policy.sessionScoped,
      requireJustification: runtime.approvals.policy.requireJustification,
    },
    permissions: {
      classes: { ...runtime.permissions.classes },
      source: runtime.permissions.source,
    },
    journal: runtime.journal,
    model: runtime.model === undefined ? undefined : { ...runtime.model },
    modelSource: runtime.modelSource,
    modes: { ...runtime.modes },
    budgets: { ...runtime.budgets },
    projectTrusted: runtime.projectTrusted,
    overriddenAttempts: [...runtime.overriddenAttempts],
    layers: runtime.layers.map((layer) => ({ ...layer })),
  };
}

// Human-readable rendering of the same view (one line per fact); secret
// shapes are redacted, so a mis-shaped value never reaches a terminal
// verbatim — and an operator cannot paste one back into a shared log.
export function renderEffectiveConfig(view: EffectiveConfigView): string[] {
  const lines: string[] = [];
  lines.push(
    `config: ${view.values.length} value(s) from ${view.layers.filter((l) => l.present).length} present layer(s)`,
  );
  for (const layer of view.layers) {
    lines.push(
      `layer ${layer.layer}: ${layer.present ? 'present' : 'absent'}${
        layer.layer === 'project'
          ? layer.trusted
            ? ' (trusted)'
            : ' (refused: untrusted)'
          : ''
      }${layer.path === undefined ? '' : ` ${layer.path}`}`,
    );
  }
  for (const value of view.values) {
    lines.push(`${value.key} = ${value.value} (${value.layer})`);
  }
  if (view.model !== undefined) {
    lines.push(
      `selected model: ${view.model.provider}/${view.model.id}${
        view.model.thinking === undefined
          ? ''
          : ` (thinking: ${view.model.thinking})`
      } (${view.modelSource})`,
    );
  } else {
    lines.push(
      `selected model: first available provider (${view.modelSource}) — no model pin configured`,
    );
  }
  lines.push(
    `approvals: route=${view.approvals.route} (${view.approvals.source}), ${view.approvals.autoApprove.length} auto-approved, maxPendingMs=${view.approvals.maxPendingMs}`,
  );
  lines.push(
    `permissions: filesystem=${view.permissions.classes.filesystem}, shell=${String(view.permissions.classes.shell)}, network=${view.permissions.classes.network}, git=${String(view.permissions.classes.git)}, credentials=${view.permissions.classes.credentials} (${view.permissions.source})`,
  );
  lines.push(
    view.journal.retentionDays === undefined
      ? 'journal retention: none configured (no age bound)'
      : `journal retention: ${view.journal.retentionDays} day(s) = maxAgeMs ${view.journal.maxAgeMs} (${view.journal.source})`,
  );
  lines.push(
    `modes: solo=${String(view.modes.solo)}, orchestrator=${String(view.modes.orchestrator)} (${view.modes.source})`,
  );
  lines.push(
    `budgets: ${view.budgets.configured ? 'configured' : 'none'} — ${view.budgets.detail}`,
  );
  lines.push(
    `project layer: ${view.projectTrusted ? 'trusted' : 'distrusted (refused pre-trust; KUBIC_TRUST_PROJECT=1 to accept)'}`,
  );
  lines.push(
    view.overriddenAttempts.length === 0
      ? 'overridden attempts: none'
      : `overridden attempts (reported, never applied): ${view.overriddenAttempts.join(', ')}`,
  );
  return lines;
}

// Repository ignore split (§35/D35): config + roles are committed, the five
// runtime prefixes are ignored. Reads the workspace's ignore wiring through
// the bridge (repo `.gitignore` + local `.git/info/exclude`) and reports the
// missing prefixes by name — the same check the config tests pin, now on a
// production path.
export function checkWorkspaceIgnoreSplit(
  bridge: Pick<FileBridge, 'exists' | 'readTextFile'>,
  cwd: string,
): { missing: string[]; checked: string[] } {
  const candidates = [`${cwd}/.gitignore`, `${cwd}/.git/info/exclude`];
  const checked: string[] = [];
  let text = '';
  for (const path of candidates) {
    if (!bridge.exists(path)) continue;
    checked.push(path);
    text += `${bridge.readTextFile(path)}\n`;
  }
  return { missing: checkGitignoreSplit(text).missing, checked };
}
