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
import { alwaysAskAutoApprove, validatePolicy } from '../approvals.js';
import {
  type EffectivePolicy,
  layerPolicyFromConfig,
  type PolicyInput,
  resolveEffectivePolicy,
} from '../policy/enterprise.js';
import { redactSecretShapes } from '../policy/secret-shapes.js';
import {
  type ApprovalsConfig,
  ConfigError,
  type ConfigLayer,
  checkGitignoreSplit,
  checkOrchestratorMaxWorkers,
  checkOrchestratorRoot,
  checkOutOfScopeEntries,
  checkRoleModelRef,
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
// or an explicit marker for a key the product deliberately does not consume.
// docs/cli/configuration.md and example.toml are parsed against THIS table by
// config-docs.test.ts, so a documented key can never quietly stop doing
// anything. Three dispositions (issue #133):
//
//   effect           — consumed: the value reaches a code path.
//   kept             — a decision: the key is reserved and reported, and the
//                      reason it is not consumed is stated here.
//   notYetImplemented — pending work with a named follow-up; NEVER a pointer
//                      at an issue, which is how the stale rows happened.
export type RuntimeKeyEffect =
  | { effect: string }
  | { kept: string }
  | { notYetImplemented: string };

export type RuntimeKeyDisposition = 'consumed' | 'kept' | 'pending' | 'unknown';

// The table lookup is section-or-key (issue #90's rule): `roles.implementer.
// model` resolves through `roles`. Undefined means the table has no row for
// the key at all — `config-doctor` flags exactly that by name (issue #133).
export function keyEffectFor(key: string): RuntimeKeyEffect | undefined {
  const direct = RUNTIME_KEY_EFFECTS[key];
  if (direct !== undefined) return direct;
  const section = key.split('.')[0] as string;
  return RUNTIME_KEY_EFFECTS[section];
}

export function runtimeKeyDisposition(
  entry: RuntimeKeyEffect | undefined,
): RuntimeKeyDisposition {
  if (entry === undefined) return 'unknown';
  if ('effect' in entry) return 'consumed';
  if ('kept' in entry) return 'kept';
  return 'pending';
}

// The row's own words, whichever disposition it carries — one extraction, so
// the docs test, the acceptance pin, and any reader agree.
export function runtimeKeyEffectText(entry: RuntimeKeyEffect): string {
  if ('effect' in entry) return entry.effect;
  if ('kept' in entry) return entry.kept;
  return entry.notYetImplemented;
}

export const RUNTIME_KEY_EFFECTS: Record<string, RuntimeKeyEffect> = {
  'agent.name': {
    effect:
      'agent id on the solo lane + journal attribution (`kubic diff --agent`)',
  },
  'model.provider': {
    effect: 'provider selection for `kubic run` and `kubic tui` (selectModel)',
  },
  'model.id': {
    effect: 'model selection for `kubic run` and `kubic tui` (selectModel)',
  },
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
    effect:
      'pending-approval bound on the solo lane and the orchestrator; a pending ask denies on timeout',
  },
  'approvals.autoApprove': {
    effect:
      'explicit-only capability auto-approvals on the solo lane (never inferred)',
  },
  'approvals.sessionScoped': {
    effect:
      'per-session approval store (true only; false is refused — no shared store exists)',
  },
  'approvals.requireJustification': {
    effect:
      'installed on the solo lane: an approval without justification is denied',
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
  'journal.outOfScope': {
    effect:
      'paths excluded from the §42.5 baseline and the end-of-run sweep (self + children)',
  },
  roles: {
    effect:
      'per-role model/tool defaults layered under the role document (§12.1)',
  },
  'orchestrator.root': {
    effect: 'parent directory for orchestrator worktrees',
  },
  'orchestrator.maxWorkers': {
    effect: 'default admission cap for the orchestrator scheduler (§45)',
  },
  'ui.theme': {
    kept: 'pi-tui owns presentation; no theme engine exists — key parsed and reported for forward-compat only',
  },
  'ui.statusBar': {
    kept: 'pi-tui owns presentation; the status bar belongs to the TUI — key parsed and reported for forward-compat only',
  },
  'session.store': {
    kept: 'jsonl is the only store implemented; sqlite/memory are a separate decision — key parsed and reported for forward-compat only',
  },
  'session.dir': {
    notYetImplemented:
      'sessions stay under ~/.kubic/sessions; relocation is a named follow-up with no filed issue yet (session-lock placement and the runtime-exclude split must settle first)',
  },
  'session.retentionDays': {
    effect:
      'default keep-window for `kubic sessions prune` (deletion stays explicit)',
  },
  // §58 enterprise [policy] (issue #288). The allow/deny and model keys reach
  // the live path (lane tool intersection, model selection gate, `kubic
  // policy`). The rest are resolved into the effective policy and only listed
  // here (`kubic config`): parsing them is the contract, enforcement is not
  // invented, and `kubic doctor` does not report them yet.
  policy: {
    kept: '§58 enterprise policy section: resolved once per process into the effective policy; the per-key rows below say what each key does',
  },
  'policy.allowed_models': {
    effect:
      'model selection gate (`provider/id`, `provider/*`, bare ids) before any provider call',
  },
  'policy.allowed_providers': {
    effect:
      'provider gate shared by model selection and the implicit fallback pick',
  },
  'policy.allowed_tools': {
    effect:
      'lane tool intersection (active tools and the prompt tools line); a lower layer cannot widen it',
  },
  'policy.denied_tools': {
    effect:
      'lane tool intersection; the deny holds against every lower layer, role document and model grant',
  },
  'policy.network_policy': {
    kept: 'resolved into the effective policy but NOT enforced: proxy-mediated enforcement is a named follow-up, listed here rather than silently ignored (doctor does not report it yet)',
  },
  'policy.allowed_domains': {
    kept: 'resolved into the effective policy alongside network_policy; no live network enforcement exists yet',
  },
  'policy.filesystem_policy': {
    kept: 'resolved into the effective policy but NOT enforced as its own gate: the lane derives filesystem reach from [permissions] classes today',
  },
  'policy.require_credential_broker': {
    kept: 'resolved into the effective policy but NOT enforced: the credential broker is not on the worker spawn path yet, so this key protects nothing today (doctor does not report it yet)',
  },
  'policy.deny_local_credentials': {
    kept: 'resolved into the effective policy but NOT enforced: the local-credential check is not on the worker spawn path yet, so this key protects nothing today (doctor does not report it yet)',
  },
  'policy.data_policy': {
    kept: 'carried and reported; no local mechanism can promise a provider-side training policy, so it is never claimed as enforced',
  },
  'policy.logging_policy': {
    kept: 'carried and reported; the one shipped audit ledger is not (yet) selected by this key',
  },
  'policy.agent_policy': {
    kept: 'max_agents/max_cost_usd resolve into the effective policy but are NOT enforced: the orchestrator cap is a named follow-up (doctor does not report it yet)',
  },
  audit: {
    kept: '[[audit]] sinks are parsed and validated; sink construction is a named follow-up, so the CLI cannot write to them yet',
  },
};

export interface RuntimeModelSelection {
  provider: string;
  id: string;
  thinking?: string;
}

// A cli/env model pin the frozen enterprise `[model]` overrode (issue #295;
// §35.1): reported instead of being dropped silently, so `kubic run --model x`
// against an enterprise pin says it ran the pin, not `x`.
export interface ModelPinOverride {
  // The input that carried the ignored pin: `--model` (cli layer) or
  // `KUBIC_MODEL` (env layer).
  source: 'cli' | 'env';
  // The ignored `provider/id`.
  requested: string;
  // The enterprise `provider/id` that ran instead.
  pinned: string;
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
  /**
   * §35 out-of-scope paths (issue #115): undefined means none declared — the
   * §42.5 walk still skips `.git/`, `.kubic/` and `.gitignore` hits on its
   * own. Declared entries exclude the path itself and everything under it.
   * The leaf's own layer lives in `sources['journal.outOfScope']`; `source`
   * below is the retention bound's origin.
   */
  outOfScope?: string[];
  source: ConfigValueSource;
}

export interface RuntimeModes {
  solo: boolean;
  orchestrator: boolean;
  source: ConfigValueSource;
}

export interface RuntimeOrchestrator {
  /**
   * §35/§44 worktree parent (issue #133): the spawned set lives at
   * `<root>/<worktreeRoot>/<agent>`. Undefined means the shipped
   * `.kubic/wt` — never an invented path.
   */
  root?: string;
  /**
   * §45 worker cap (issue #133): the default the scheduler resolves through
   * resolveMaxConcurrency. Undefined means no configured cap; an explicit
   * session/argv cap still wins.
   */
  maxWorkers?: number;
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
  productPath?: string;
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
  /**
   * §58 enterprise policy (issue #288), resolved ONCE per process from the
   * per-layer `[policy]` sections (enterprise > product > … > agent) — the
   * same merge the config layers use, with deny accumulation and layer
   * provenance. Empty when no layer declares `[policy]`.
   */
  policy: EffectivePolicy;
  model: RuntimeModelSelection | undefined;
  modelSource: ConfigValueSource;
  approvals: RuntimeApprovals;
  permissions: RuntimePermissions;
  journal: RuntimeJournal;
  modes: RuntimeModes;
  orchestrator: RuntimeOrchestrator;
  budgets: RuntimeBudgets;
  projectTrusted: boolean;
  overriddenAttempts: string[];
  // The cli/env model pins a frozen enterprise `[model]` overrode (also named
  // in `overriddenAttempts`); empty when nothing was overridden — the same pin
  // named twice, no freeze, or no cli/env pin.
  modelPinOverrides: ModelPinOverride[];
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
  // Issue #133: what the key-effect table says this key does — 'consumed'
  // (an effect row), 'kept' (a recorded decision), 'pending' (a named
  // follow-up), or 'unknown' (no row at all; config-doctor flags it).
  disposition: RuntimeKeyDisposition;
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
    outOfScope?: string[];
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
  'product',
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
  // Each present layer's own parsed config, in precedence order: the §58
  // policy resolution (issue #288) needs per-layer inputs so a lower layer
  // can narrow a higher one's deny list without the pre-flattened merge
  // dropping the addition.
  perLayer: Array<{ layer: ConfigLayer; config: KubicConfig }>;
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
    ...(inputs.productPath === undefined
      ? {}
      : { productPath: inputs.productPath }),
  });
  const layerInputs: LayerInput[] = [];
  const perLayer: Array<{ layer: ConfigLayer; config: KubicConfig }> = [];
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
      if (programmatic !== undefined) {
        layerInputs.push({ layer, config: programmatic });
        perLayer.push({ layer, config: programmatic });
      }
      continue;
    }
    const present = path !== undefined && safeExists(inputs.bridge, path);
    reports.push({
      layer,
      path,
      present,
      trusted: layer === 'project' ? projectTrusted : true,
    });
    if (layer === 'project' && !projectTrusted) {
      if (present) {
        // Refused pre-trust, before the file is read (§35.1). Named by path
        // so the operator knows exactly which layer is waiting on trust,
        // and with the remedies named (issue #228): the durable grant or the
        // per-invocation env opt-in, never a bare issue number.
        throw new ProjectUntrustedError(
          `project-local config refused pre-trust: ${path} — run 'kubic trust' to accept this project, or set KUBIC_TRUST_PROJECT=1 for this invocation`,
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
    perLayer.push({ layer, config: parsed });
    for (const leaf of Object.keys(flatten(parsed))) {
      if (!(leaf in sources)) sources[leaf] = layer;
    }
  }
  return { inputs: layerInputs, perLayer, sources, paths, reports };
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
  // Issue #230: the host has exactly one store placement — per session
  // (<session>/approvals.json). A shared, cross-session store is not
  // implemented, so `sessionScoped = false` is refused by name rather than
  // printed as an effective policy that no lane enforces.
  if (approvals.sessionScoped === false) {
    throw new ConfigError(
      "'approvals': 'sessionScoped = false' is not supported — approval decisions are always stored per session (<session>/approvals.json); remove the key or set it to true",
    );
  }
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
  // §58 enterprise policy (issue #288): resolved once, from EACH layer's own
  // `[policy]` section in precedence order — never from the pre-flattened
  // merge, so a lower layer's added deny accumulates (the first-wins leaf
  // merge would drop it) while a lower allow can never lift an enterprise
  // deny. Absent `[policy]` anywhere leaves an empty effective policy and
  // gates nothing.
  const policyInputs: PolicyInput[] = [];
  for (const entry of loaded.perLayer) {
    const layerPolicy = layerPolicyFromConfig(entry.config);
    if (Object.keys(layerPolicy).length > 0) {
      policyInputs.push({ layer: entry.layer, policy: layerPolicy });
    }
  }
  const policy = resolveEffectivePolicy(policyInputs).policy;

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

  // §35.1 (issue #295): a frozen enterprise pin drops every cli/env pin
  // without a word unless it is recorded here — the composition root turns
  // each entry into one stderr note. A pin equal to the enterprise one
  // overrode nothing.
  const modelPinOverrides: ModelPinOverride[] = [];
  if (modelSource === 'enterprise' && model !== undefined) {
    const pinned = `${model.provider}/${model.id}`;
    const attempts: Array<['cli' | 'env', RuntimeModelSelection | undefined]> =
      [
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
  // §35 out-of-scope paths (issue #115): validated here too, because the
  // programmatic session/agent layers never pass through the TOML parser —
  // an empty entry is refused by name, never half-applied.
  const outOfScopeEntries = checkOutOfScopeEntries(
    config.journal?.outOfScope,
    'journal',
  );
  const journal: RuntimeJournal = {
    ...(retentionDays === undefined ? {} : { retentionDays }),
    ...(retentionDays === undefined
      ? {}
      : { maxAgeMs: retentionDays * MS_PER_DAY }),
    ...(outOfScopeEntries === undefined
      ? {}
      : { outOfScope: outOfScopeEntries }),
    source: retentionEnvApplies
      ? 'env'
      : (loaded.sources['journal.retentionDays'] ?? 'defaults'),
  };

  // §35/§44/§45 orchestrator keys (issue #133): validated here too, because
  // the programmatic session/agent layers never pass through the TOML
  // parser — an escaping root or a non-positive cap is refused by name,
  // never half-applied.
  const orchestratorRoot = checkOrchestratorRoot(
    config.orchestrator?.root,
    'orchestrator',
  );
  const orchestratorMaxWorkers = checkOrchestratorMaxWorkers(
    config.orchestrator?.maxWorkers,
    'orchestrator',
  );
  // §12.1 per-role model pins (issue #133): validated here too, because the
  // programmatic session/agent layers never pass through the TOML parser — a
  // malformed `provider/id` ref is refused by name, never carried to the lane.
  for (const [name, role] of Object.entries(config.roles ?? {})) {
    checkRoleModelRef(role.model, name);
  }

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
    policy,
    model,
    modelSource,
    approvals,
    permissions,
    journal,
    modes: modesFrom(config, loaded.sources),
    orchestrator: {
      ...(orchestratorRoot === undefined ? {} : { root: orchestratorRoot }),
      ...(orchestratorMaxWorkers === undefined
        ? {}
        : { maxWorkers: orchestratorMaxWorkers }),
    },
    budgets: {
      configured: false,
      detail:
        'no budgets are defaulted by config (§71): nothing is capped until you configure a limit, and [budgets] keys are refused outright',
    },
    projectTrusted,
    overriddenAttempts: [
      ...merged.overriddenAttempts,
      ...modelPinOverrides.map(
        (entry) =>
          `model: ${entry.source === 'cli' ? '--model' : 'KUBIC_MODEL'} '${entry.requested}' rejected: enterprise pin '${entry.pinned}' holds`,
      ),
    ],
    modelPinOverrides,
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
      disposition: runtimeKeyDisposition(keyEffectFor(key)),
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
    journal: {
      ...runtime.journal,
      ...(runtime.journal.outOfScope === undefined
        ? {}
        : { outOfScope: [...runtime.journal.outOfScope] }),
    },
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
  // The disposition split up front (issue #133): a reader sees how many
  // values are consumed, how many are kept decisions, and how many are
  // pending — before the per-value lines repeat it.
  const counts = { consumed: 0, kept: 0, pending: 0, unknown: 0 };
  for (const value of view.values) counts[value.disposition] += 1;
  lines.push(
    `config: ${view.values.length} value(s) from ${view.layers.filter((l) => l.present).length} present layer(s); effects: ${counts.consumed} consumed, ${counts.kept} kept, ${counts.pending} pending${
      counts.unknown === 0
        ? ''
        : `, ${counts.unknown} with no effect row (see doctor)`
    }`,
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
    lines.push(
      `${value.key} = ${value.value} (${value.layer}, ${value.disposition})`,
    );
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
  // An always-ask capability in autoApprove never applies (issue #324): named
  // and left out of the count, never printed as an approval nothing grants.
  const ignoredAutoApprove = [
    ...new Set(alwaysAskAutoApprove(view.approvals.autoApprove)),
  ];
  const effectiveAutoApprove = view.approvals.autoApprove.filter(
    (capability) => !ignoredAutoApprove.includes(capability),
  );
  lines.push(
    `approvals: route=${view.approvals.route} (${view.approvals.source}), ${effectiveAutoApprove.length} auto-approved${
      ignoredAutoApprove.length === 0
        ? ''
        : ` (${ignoredAutoApprove.join(', ')} always asks — ignored)`
    }, maxPendingMs=${view.approvals.maxPendingMs}`,
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
    view.journal.outOfScope === undefined
      ? 'journal out-of-scope: none declared — the walk still skips .git/, .kubic/ and .gitignore hits on its own'
      : `journal out-of-scope: ${view.journal.outOfScope.length} path(s) excluded from the baseline and the sweep (self + children): ${view.journal.outOfScope.join(', ')}`,
  );
  lines.push(
    `modes: solo=${String(view.modes.solo)}, orchestrator=${String(view.modes.orchestrator)} (${view.modes.source})`,
  );
  lines.push(
    `budgets: ${view.budgets.configured ? 'configured' : 'none'} — ${view.budgets.detail}`,
  );
  lines.push(
    `project layer: ${view.projectTrusted ? 'trusted' : "distrusted (refused pre-trust; run 'kubic trust' to accept this project, or set KUBIC_TRUST_PROJECT=1 for this invocation)"}`,
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
//
// `lstat` on a path under a non-directory throws ENOTDIR (a git WORKTREE has
// a `.git` FILE, not a directory). Absence is the answer we want there, so
// every existence probe in this module goes through this guard — a config
// load must never crash on a repository layout.
function safeExists(bridge: Pick<FileBridge, 'exists'>, path: string): boolean {
  try {
    return bridge.exists(path);
  } catch {
    return false;
  }
}

function safeReadTextFile(
  bridge: Pick<FileBridge, 'readTextFile'>,
  path: string,
): string | undefined {
  try {
    return bridge.readTextFile(path);
  } catch {
    return undefined;
  }
}

export function checkWorkspaceIgnoreSplit(
  bridge: Pick<FileBridge, 'exists' | 'readTextFile'>,
  cwd: string,
): { missing: string[]; checked: string[]; applicable: boolean } {
  // Outside a git repository there is nothing to ignore: `kubic run` ships
  // its exclude rules into `.git/info/exclude`, which does not exist, and
  // runtime state stays local wherever it is written. Reporting a missing
  // split there would be a false alarm, so `applicable` is false and no
  // rules are claimed to be absent.
  const applicable = safeExists(bridge, `${cwd}/.git`);
  const candidates = [`${cwd}/.gitignore`, `${cwd}/.git/info/exclude`];
  const checked: string[] = [];
  let text = '';
  for (const path of candidates) {
    if (!safeExists(bridge, path)) continue;
    const content = safeReadTextFile(bridge, path);
    if (content === undefined) continue;
    checked.push(path);
    text += `${content}\n`;
  }
  return {
    missing: applicable ? checkGitignoreSplit(text).missing : [],
    checked,
    applicable,
  };
}
