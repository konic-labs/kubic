// Runtime config load at the composition root.
//
// One call turns the six config layers into the values the product actually
// runs on: provider/model selection, approval policy + routes, permission
// classes and journal retention.
// Precedence: enterprise > global > project (trust-gated) > workspace >
// session > agent, then the documented env overrides, then an explicit CLI
// flag. The first layer to set a leaf owns it; every attempt to override a
// set leaf is reported in `overriddenAttempts`, never applied.
//
// secrets never appear in config — a `$VAR` / `!command` ref anywhere in
// the effective config is refused by name, never substituted or echoed.
//
// File access arrives as the exec FileBridge (I/O confinement): this module
// never imports node:fs. Zero network, zero real processes.

import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  DEFAULT_RESERVE_TOKENS,
  effectiveReserveTokens,
  KEEP_RECENT_TOKENS,
} from '@kubic/agent/compaction';
import {
  type PermissionClasses,
  validateClasses,
} from '@kubic/agent/permissions';
import { redactSecretShapes } from '@kubic/core/secret-shapes';
import type { FileBridge } from '@kubic/exec/file-bridge';
import { alwaysAskAutoApprove, validatePolicy } from '../approvals/index.js';
import { findProjectRoot } from '../cli/index.js';
import {
  type EffectivePolicy,
  layerPolicyFromConfig,
  type PolicyInput,
  resolveEffectivePolicy,
} from '../policy/index.js';
import { parseSecretRef } from '../secret-refs/index.js';
import {
  checkOutOfScopeEntries,
  checkRoleModelRef,
  checkThinkingLevel,
} from './checks.js';
import {
  type ApprovalsConfig,
  type ConfigLayer,
  checkGitignoreSplit,
  checkSessionCompaction,
  checkVerifyConfig,
  defaultLayerPaths,
  type KubicConfig,
  type LayerInput,
  mergeLayered,
  parseLayerConfig,
  resolveConfigSkills,
  VERIFY_COMMAND_KEYS,
} from './config.js';
import { ConfigError, ProjectUntrustedError } from './errors.js';
import {
  CONFIG_SECTIONS,
  type ConfigKey,
  configKey,
  type KeyEffect,
} from './schema.js';

// Where an effective value came from: one of the six config layers, the
// documented environment overrides, the explicit CLI flag, or the product's
// own default when nothing set it.
export type ConfigValueSource = ConfigLayer | 'env' | 'cli' | 'defaults';

// Days→ms is the only conversion journal retention needs: bounds are
// ms, the config key is days.
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Documented environment overrides, applied above every file layer and below
// an explicit CLI flag. The names are part of the CLI contract; the config
// keys' own come from the schema.
export const RUNTIME_ENV_OVERRIDES = {
  model: envOf('model', 'provider'),
  modelThinking: envOf('model', 'thinking'),
  approvalsRoute: envOf('approvals', 'route'),
  journalRetentionDays: envOf('journal', 'retentionDays'),
  trustProject: 'KUBIC_TRUST_PROJECT',
} as const;

function envOf(section: string, name: string): string {
  const env = configKey(section, name).env;
  if (env === undefined) throw new Error(`'${section}.${name}' has no env`);
  return env;
}

const DEFAULT_APPROVALS_ROUTE = configKey('approvals', 'route').default as
  | 'ask-user'
  | 'deny';

// What the runtime does with each config key (`kubic config`, `kubic
// doctor`): consumed, kept with the reason, or pending.
/** @internal */
export type RuntimeKeyEffect = KeyEffect;

/** @internal */
export type RuntimeKeyDisposition = 'consumed' | 'kept' | 'pending' | 'unknown';

// The schema's runtime rows: one per `section.key`, plus a section's own row,
// which the keys of an open-ended section resolve through.
/** @internal */
export const RUNTIME_KEY_EFFECTS: Record<string, RuntimeKeyEffect> =
  Object.fromEntries(
    CONFIG_SECTIONS.flatMap((section) => {
      const rows: [string, KeyEffect][] = [];
      if ('runtime' in section) rows.push([section.name, section.runtime]);
      for (const key of section.keys as readonly ConfigKey[]) {
        if (key.runtime !== undefined) {
          rows.push([`${section.name}.${key.name}`, key.runtime]);
        }
      }
      return rows;
    }),
  );

// The table lookup is section-or-key (the rule): `roles.implementer.
// model` resolves through `roles`. Undefined means the table has no row for
// the key at all — `config-doctor` flags exactly that by name.
/** @internal */
export function keyEffectFor(key: string): RuntimeKeyEffect | undefined {
  const direct = RUNTIME_KEY_EFFECTS[key];
  if (direct !== undefined) return direct;
  const section = key.split('.')[0] as string;
  return RUNTIME_KEY_EFFECTS[section];
}

/** @internal */
export function runtimeKeyDisposition(
  entry: RuntimeKeyEffect | undefined,
): RuntimeKeyDisposition {
  if (entry === undefined) return 'unknown';
  if ('effect' in entry) return 'consumed';
  if ('kept' in entry) return 'kept';
  return 'pending';
}

interface RuntimeModelSelection {
  provider: string;
  id: string;
  thinking?: string;
}

// The effective thinking level with where it came from.
// `cli`/`env` sources are per-run overrides that beat a session's persisted
// level; a file-layer source is the config default, which a persisted
// session level and a role default both beat (resolved at lane boot).
export interface RuntimeThinking {
  level: string;
  source: ConfigValueSource;
}

// A cli/env model pin the frozen enterprise `[model]` overrode: reported
// instead of being dropped silently, so `kubic run --model x` against an
// enterprise pin says it ran the pin, not `x`.
interface ModelPinOverride {
  // The input that carried the ignored pin: `--model` (cli layer) or
  // `KUBIC_MODEL` (env layer).
  source: 'cli' | 'env';
  // The ignored `provider/id`.
  requested: string;
  // The enterprise `provider/id` that ran instead.
  pinned: string;
}

interface RuntimeApprovals {
  policy: ReturnType<typeof validatePolicy>;
  source: ConfigValueSource;
}

interface RuntimePermissions {
  classes: PermissionClasses;
  source: ConfigValueSource;
}

interface RuntimeJournal {
  // Undefined means "no age bound configured" — never an invented default.
  retentionDays?: number;
  maxAgeMs?: number;
  // The configured byte bound; undefined means the store's own
  // default applies (100 MiB), never an invented value here.
  maxBytes?: number;
  /**
   * Out-of-scope paths: undefined means none declared — the
   * Walk still skips `.git/`, `.kubic/` and `.gitignore` hits on its
   * own. Declared entries exclude the path itself and everything under it.
   * The leaf's own layer lives in `sources['journal.outOfScope']`; `source`
   * below is the retention bound's origin.
   */
  outOfScope?: string[];
  source: ConfigValueSource;
}

interface RuntimeSystemPrompt {
  // The resolved path (what `kubic config` reports) and the contents the
  // lane boots append to the assembled system prompt. Read once, at load,
  // through the file bridge — a missing or unreadable file is a named
  // ConfigError, never a silent skip.
  path: string;
  contents: string;
  // The layer that declared it (global paths are always allowed; the
  // project layer additionally requires trust and containment, enforced
  // at load).
  source: ConfigValueSource;
}

interface RuntimeCompaction {
  // Undefined means "not configured" — the lane defaults apply (automatic
  // compaction, the default reserve, the default recent window), never an
  // invented value here.
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
  // The highest-precedence layer that set a key, or 'defaults' when none
  // is set.
  source: ConfigValueSource;
}

// The merged `[model]` escalation ladder: steps plus
// the per-run bound, projected once per config load.
export interface RuntimeEscalation {
  steps: string[];
  maxEscalations: number;
}

interface ConfigLayerReport {
  layer: ConfigLayer;
  path: string | undefined;
  present: boolean;
  trusted: boolean;
}

export interface RuntimeConfigInputs {
  // `realPath` (optional) lets the project layer's prompt file be contained
  // through symlinks too.
  bridge: Pick<FileBridge, 'exists' | 'readTextFile' | 'realPath'>;
  home: string;
  cwd: string;
  // The project root the project layer resolves at —
  // the nearest ancestor holding `.kubic/` (or the git top level). Absent
  // means the load resolves it from the cwd itself (findProjectRoot), so
  // a run from a subdirectory reads the same committed config as one from
  // the root instead of silently dropping to defaults.
  projectRoot?: string;
  workspaceRoot?: string;
  enterprisePath?: string;
  productPath?: string;
  env?: Record<string, string | undefined>;
  // Trust gate for the project layer. An explicit true is the
  // caller's accepted trust prompt; KUBIC_TRUST_PROJECT=1 also opts in.
  projectTrusted?: boolean;
  cli?: { model?: RuntimeModelSelection; thinking?: string };
  // Session/agent layers arrive programmatically, never as files.
  session?: KubicConfig;
  agent?: KubicConfig;
}

// Gate commands: what `kubic run` verifies after each
// settled run. Empty `commands` means nothing is verified — every gate
// stays unknown, never a guessed pass.
export interface RuntimeVerify {
  commands: Partial<Record<(typeof VERIFY_COMMAND_KEYS)[number], string>>;
  timeoutMs?: number;
}

export interface RuntimeConfig {
  config: KubicConfig;
  /**
   * Enterprise policy, resolved ONCE per process from the
   * per-layer `[policy]` sections (enterprise > product > … > agent) — the
   * same merge the config layers use, with deny accumulation and layer
   * provenance. Empty when no layer declares `[policy]`.
   */
  policy: EffectivePolicy;
  model: RuntimeModelSelection | undefined;
  modelSource: ConfigValueSource;
  // Undefined when nothing set a level: the lane then boots at the session's
  // persisted level, a role default, or Pi's 'off'.
  thinking: RuntimeThinking | undefined;
  // The merged `[model]` escalation ladder: the steps
  // plus the bound (defaulting to the ladder length — the ladder itself
  // bounds). Undefined when no layer named rungs: escalation is opt-in.
  // A role's own ladder wins per run at the lane, not here.
  escalate: RuntimeEscalation | undefined;
  approvals: RuntimeApprovals;
  permissions: RuntimePermissions;
  journal: RuntimeJournal;
  compaction: RuntimeCompaction;
  // Undefined when no layer declares `[agent] systemPromptFile` — the
  // lane assembles its prompt unchanged.
  systemPromptFile?: RuntimeSystemPrompt;
  verify: RuntimeVerify;
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

interface EffectiveConfigValue {
  key: string;
  // Formatted like the TOML value it came from, so the human view and the
  // machine view never disagree about what the value is.
  value: string;
  layer: ConfigValueSource;
  // What the key-effect table says this key does — 'consumed'
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
  compaction: {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
    source: ConfigValueSource;
  };
  model: RuntimeModelSelection | undefined;
  modelSource: ConfigValueSource;
  // The effective thinking level with its source, so
  // `kubic config --json` reports what the lane boots with.
  thinking: RuntimeThinking | undefined;
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
  // Tables render as JSON: the role `models` set is the
  // first array-of-tables in config, and without this branch it printed
  // `[object Object]`. Strings redact leaf-wise, never the structure.
  if (isRecord(value)) return JSON.stringify(redactDeep(value));
  return JSON.stringify(redactSecretShapes(String(value)));
}

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretShapes(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactDeep(child)]),
    );
  }
  return value;
}

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
  // Each present layer's own parsed config, in precedence order: the
  // policy resolution needs per-layer inputs so a lower layer
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
    projectRoot:
      inputs.projectRoot ??
      findProjectRoot(inputs.bridge, inputs.cwd, inputs.home),
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
        // Programmatic layers declare no file, so their
        // relative `skills` entries anchor at the invoking cwd.
        const resolved = resolveConfigSkills(
          programmatic,
          join(inputs.cwd, 'config.toml'),
        );
        layerInputs.push({ layer, config: resolved });
        perLayer.push({ layer, config: resolved });
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
        // Refused pre-trust, before the file is read. Named by path
        // so the operator knows exactly which layer is waiting on trust,
        // and with the remedies named: the durable grant or the
        // per-invocation env opt-in, never a bare issue number.
        throw new ProjectUntrustedError(
          `project-local config refused pre-trust: ${path} — run 'kubic trust' to accept this project, or set KUBIC_TRUST_PROJECT=1 for this invocation`,
        );
      }
      continue;
    }
    if (!present || path === undefined) continue;
    const parsed = parseLayerConfig(layer, inputs.bridge.readTextFile(path));
    // Relative `skills` entries anchor at the config
    // file that declared them — a project config's `../shared/skills`
    // names the project's sibling, wherever the run was invoked from.
    const resolved = resolveConfigSkills(parsed, path);
    layerInputs.push({
      layer,
      config: resolved,
      ...(layer === 'project' ? { trusted: true as const } : {}),
    });
    perLayer.push({ layer, config: resolved });
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

// [agent] systemPromptFile: resolve the configured path against the declaring
// layer and read it now, through the bridge — fail-closed. `~` expands to the
// home directory; an absolute path is taken as typed; a relative path resolves
// against the declaring config file's directory (programmatic session/agent
// layers are never files, so a relative path there is refused, never guessed).
// The project layer additionally requires containment in the project root: a
// trusted path outside it is refused by name. Global and higher layers are
// unrestricted. A missing or unreadable file is a named ConfigError. Source
// attribution for the programmatic session/agent layers: first layer in
// precedence order that sets the leaf. File layers always win over these (they
// precede them), so this is only the fallback when no file source recorded the
// key.
function programmaticSourceFor(
  inputs: RuntimeConfigInputs,
  key: string,
): ConfigLayer | undefined {
  for (const layer of ['session', 'agent'] as const) {
    const scoped = inputs[layer];
    if (scoped !== undefined && flatten(scoped)[key] !== undefined) {
      return layer;
    }
  }
  return undefined;
}

// Whether `path` lies outside `root` (the root itself counts as outside:
// it is a directory, never the file).
function outsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel);
}

// The real path, or undefined when the bridge cannot resolve it (a missing
// file is then reported by the existence check that follows).
function realPathOf(
  bridge: Pick<FileBridge, 'realPath'>,
  path: string,
): string | undefined {
  try {
    return bridge.realPath?.(path);
  } catch {
    return undefined;
  }
}

function resolveSystemPromptFile(args: {
  bridge: Pick<FileBridge, 'exists' | 'readTextFile' | 'realPath'>;
  home: string;
  projectRoot: string;
  configured: string | undefined;
  source: ConfigValueSource | undefined;
  layerPath: string | undefined;
}): RuntimeSystemPrompt | undefined {
  const { configured, source } = args;
  if (configured === undefined) return undefined;
  if (typeof configured !== 'string' || configured === '') {
    throw new ConfigError(
      `'agent': 'systemPromptFile' must be a non-empty string`,
    );
  }
  if (source === undefined || source === 'defaults') {
    // The key is set but no layer owns it: attribution would be a guess.
    throw new ConfigError(
      `'agent': 'systemPromptFile' is set but no config layer owns it`,
    );
  }
  const layer = source as ConfigLayer;
  let resolved: string;
  if (configured.startsWith('~/')) {
    resolved = join(args.home, configured.slice(2));
  } else if (isAbsolute(configured)) {
    resolved = configured;
  } else if (args.layerPath === undefined) {
    throw new ConfigError(
      `'agent': 'systemPromptFile' '${configured}' is a relative path with no declaring config file — use an absolute path`,
    );
  } else {
    resolved = join(dirname(args.layerPath), configured);
  }
  if (layer === 'project') {
    if (outsideRoot(resolved, args.projectRoot)) {
      throw new ConfigError(
        `'agent': 'systemPromptFile' '${resolved}' is outside the project root '${args.projectRoot}'`,
      );
    }
    // A symlink inside the root can still point out of it: the target is
    // contained too, measured against the root's own real path.
    const real = realPathOf(args.bridge, resolved);
    const realRoot = realPathOf(args.bridge, args.projectRoot);
    if (
      real !== undefined &&
      realRoot !== undefined &&
      outsideRoot(real, realRoot)
    ) {
      throw new ConfigError(
        `'agent': 'systemPromptFile' '${resolved}' resolves outside the project root '${args.projectRoot}' (to '${real}')`,
      );
    }
  }
  if (!safeExists(args.bridge, resolved)) {
    throw new ConfigError(
      `'agent': 'systemPromptFile' '${resolved}' does not exist`,
    );
  }
  let contents: string;
  try {
    contents = args.bridge.readTextFile(resolved);
  } catch (error) {
    throw new ConfigError(
      `'agent': 'systemPromptFile' '${resolved}' cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { path: resolved, contents, source };
}

export function loadRuntimeConfig(inputs: RuntimeConfigInputs): RuntimeConfig {
  const env = inputs.env ?? {};
  const trustEnv = env[RUNTIME_ENV_OVERRIDES.trustProject];
  const projectTrusted = inputs.projectTrusted === true || envFlag(trustEnv);
  const loaded = loadLayers(inputs, projectTrusted);
  const merged = mergeLayered(loaded.inputs);
  const config = merged.config;
  assertNoSecretRefs(config);
  // Enterprise policy: resolved once, from EACH layer's own
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
  const envThinking = checkThinkingLevel(
    env[RUNTIME_ENV_OVERRIDES.modelThinking],
    RUNTIME_ENV_OVERRIDES.modelThinking,
  );
  const cliThinking = checkThinkingLevel(inputs.cli?.thinking, '--thinking');
  const cliModel = inputs.cli?.model;
  const fileModel = modelFrom(config);
  // Enterprise keys are frozen against every override — a lower file
  // layer, an env override, and a CLI flag included. Nothing un-sets them.
  const frozen = (key: string): boolean => loaded.sources[key] === 'enterprise';
  // Thinking level: --thinking > KUBIC_MODEL_THINKING >
  // the file layers — and an enterprise level is frozen against both (an
  // explicit flag is refused by name; the env override is not applied).
  let thinking: RuntimeThinking | undefined;
  const fileThinking = config.model?.thinking;
  // An env override a frozen enterprise level drops
  // is reported in `overriddenAttempts` (never applied), mirroring the
  // model-pin overrides below. The flag is refused by name above, so only
  // the env input can land here; an equal value overrode nothing.
  let droppedEnvThinking: string | undefined;
  if (frozen('model.thinking')) {
    if (cliThinking !== undefined) {
      throw new ConfigError(
        `--thinking ${JSON.stringify(cliThinking)} refused: model.thinking is frozen by the enterprise layer`,
      );
    }
    thinking = { level: fileThinking as string, source: 'enterprise' };
    if (envThinking !== undefined && envThinking !== fileThinking) {
      droppedEnvThinking = `model: KUBIC_MODEL_THINKING '${envThinking}' rejected: enterprise thinking '${fileThinking}' holds`;
    }
  } else if (cliThinking !== undefined) {
    thinking = { level: cliThinking, source: 'cli' };
  } else if (envThinking !== undefined) {
    thinking = { level: envThinking, source: 'env' };
  } else if (fileThinking !== undefined) {
    thinking = {
      level: fileThinking,
      source: loaded.sources['model.thinking'] ?? 'defaults',
    };
  }
  // The selected pin carries the effective level too, so `kubic config`'s
  // "selected model … (thinking: …)" line reports what the lane boots with.
  const withThinking = (
    selection: RuntimeModelSelection,
  ): RuntimeModelSelection => {
    const pin = { provider: selection.provider, id: selection.id };
    return thinking === undefined ? pin : { ...pin, thinking: thinking.level };
  };
  let model: RuntimeModelSelection | undefined;
  let modelSource: ConfigValueSource;
  if (frozen('model.provider') || frozen('model.id')) {
    model = fileModel === undefined ? undefined : withThinking(fileModel);
    modelSource = 'enterprise';
  } else if (cliModel !== undefined) {
    model = withThinking(cliModel);
    modelSource = 'cli';
  } else if (envModel !== undefined) {
    model = withThinking(envModel);
    modelSource = 'env';
  } else if (fileModel !== undefined) {
    model = withThinking(fileModel);
    modelSource =
      loaded.sources['model.provider'] ??
      loaded.sources['model.id'] ??
      'defaults';
  } else {
    model = undefined;
    modelSource = 'defaults';
  }

  // A frozen enterprise pin drops every cli/env pin
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
  // Out-of-scope paths: validated here too, because the
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
    ...(config.journal?.maxBytes === undefined
      ? {}
      : { maxBytes: config.journal.maxBytes }),
    ...(outOfScopeEntries === undefined
      ? {}
      : { outOfScope: outOfScopeEntries }),
    source: retentionEnvApplies
      ? 'env'
      : (loaded.sources['journal.retentionDays'] ?? 'defaults'),
  };

  // Session compaction policy: re-validated here,
  // because the programmatic session/agent layers never pass through the
  // TOML parser — a bad value there is refused by name, never carried to
  // the lane. Unset means the lane defaults (never an invented value here).
  const sessionCompaction = checkSessionCompaction(
    (config.session ?? {}) as Record<string, unknown>,
    'session',
  );
  // The config key is `autoCompact`; the runtime projection names the lane
  // option (`enabled`) — one spelling per surface, mapped here.
  // Provenance (review follow-up): the highest-precedence layer among the
  // set keys — evaluated per key, not the first-set key's layer in key
  // order. Each key's layer is already its highest-precedence setter (the
  // file merge is first-wins in LAYER_ORDER; the programmatic
  // session/agent fallback trails every file layer), so the minimum rank
  // wins. 'defaults' ranks below every layer and only survives when no key
  // is set at all.
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
  const compaction: RuntimeCompaction = {
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

  // Per-role model pins: validated here too, because the
  // programmatic session/agent layers never pass through the TOML parser — a
  // malformed `provider/id` ref is refused by name, never carried to the lane.
  for (const [name, role] of Object.entries(config.roles ?? {})) {
    checkRoleModelRef(role.model, name);
    // The programmatic session/agent layers never pass through
    // the TOML parser — a malformed role thinking default is refused by
    // name here, never carried to the lane.
    checkThinkingLevel(role.thinking, `'roles.${name}': 'thinking'`);
  }
  // Gate commands: re-validated for the programmatic
  // layers, which never pass through the TOML parser.
  const verifyConfig =
    config.verify === undefined
      ? {}
      : checkVerifyConfig(
          config.verify as unknown as Record<string, unknown>,
          'verify',
        );
  const verify: RuntimeVerify = {
    commands: Object.fromEntries(
      VERIFY_COMMAND_KEYS.flatMap((key) => {
        const command = verifyConfig[key];
        return command === undefined ? [] : [[key, command]];
      }),
    ),
    ...(verifyConfig.timeoutMs === undefined
      ? {}
      : { timeoutMs: verifyConfig.timeoutMs }),
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
  if (thinking?.source === 'cli' || thinking?.source === 'env') {
    loaded.sources['model.thinking'] = thinking.source;
  }
  if (approvals.source === 'env') loaded.sources['approvals.route'] = 'env';
  if (retentionEnvApplies) loaded.sources['journal.retentionDays'] = 'env';

  // [agent] systemPromptFile: the declaring layer's file
  // resolves a relative path; anything else means no declaring file.
  // The programmatic session/agent layers merge values without recording
  // sources (loadLayers records file layers only), so a key set there
  // attributes to the winning programmatic layer in precedence order —
  // never to 'defaults', and never refused as ownerless.
  const systemPromptSource =
    loaded.sources['agent.systemPromptFile'] ??
    programmaticSourceFor(inputs, 'agent.systemPromptFile');
  const systemPromptLayerPath =
    systemPromptSource !== undefined &&
    (LAYER_ORDER as readonly string[]).includes(systemPromptSource)
      ? loaded.paths[systemPromptSource as ConfigLayer]
      : undefined;

  // The merged `[model]` escalation ladder: steps
  // from the winning layer, bound defaulting to the ladder length so the
  // ladder itself bounds when no explicit max is set.
  const modelEscalate = config.model?.escalate;
  const escalate: RuntimeEscalation | undefined =
    modelEscalate === undefined
      ? undefined
      : {
          steps: [...modelEscalate],
          maxEscalations: config.model?.maxEscalations ?? modelEscalate.length,
        };

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
    thinking,
    escalate,
    approvals,
    permissions,
    journal,
    compaction,
    // [agent] systemPromptFile: resolved + read at load, so
    // the lane boots and the `kubic config` report share one derivation.
    systemPromptFile: resolveSystemPromptFile({
      bridge: inputs.bridge,
      home: inputs.home,
      projectRoot:
        inputs.projectRoot ??
        findProjectRoot(inputs.bridge, inputs.cwd, inputs.home),
      configured: config.agent?.systemPromptFile,
      source: systemPromptSource,
      layerPath: systemPromptLayerPath,
    }),
    verify,
    projectTrusted,
    overriddenAttempts: [
      ...merged.overriddenAttempts,
      ...modelPinOverrides.map(
        (entry) =>
          `model: ${entry.source === 'cli' ? '--model' : 'KUBIC_MODEL'} '${entry.requested}' rejected: enterprise pin '${entry.pinned}' holds`,
      ),
      ...(droppedEnvThinking === undefined ? [] : [droppedEnvThinking]),
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
  // [agent] systemPromptFile: the report names the EFFECTIVE
  // (resolved) path, not the declared spelling — same derivation the lane
  // boots with. The layer stays the declaring one.
  if (runtime.systemPromptFile !== undefined) {
    const row = values.find((entry) => entry.key === 'agent.systemPromptFile');
    if (row !== undefined) {
      row.value = formatValue(runtime.systemPromptFile.path);
      row.layer = runtime.systemPromptFile.source;
    }
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
    // The reportable compaction policy: configured values
    // default-filled, so the report names what the lane will run with. The
    // reserve is the EFFECTIVE one through the same clamp the lane's live
    // getter uses — with no conversation there is no model window yet, so
    // an unknown window reports the configured value and the lane re-clamps
    // per model at boot.
    compaction: {
      enabled: runtime.compaction.enabled ?? true,
      reserveTokens: effectiveReserveTokens(
        0,
        runtime.compaction.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
      ),
      keepRecentTokens:
        runtime.compaction.keepRecentTokens ?? KEEP_RECENT_TOKENS,
      source: runtime.compaction.source,
    },
    model: runtime.model === undefined ? undefined : { ...runtime.model },
    modelSource: runtime.modelSource,
    thinking:
      runtime.thinking === undefined ? undefined : { ...runtime.thinking },
    projectTrusted: runtime.projectTrusted,
    overriddenAttempts: [...runtime.overriddenAttempts],
    layers: runtime.layers.map((layer) => ({ ...layer })),
  };
}

// The effective compaction policy as one reportable line: what
// the lane runs with. The reserve is already clamped through the lane's own
// clamp; the lane re-clamps per model at boot (at most a quarter of its
// window), so a small-window model may compact sooner than this line's
// figure. Shared by `kubic config` and the doctor probe, so the two surfaces
// cannot disagree about the effective reserve.
export function compactionSummaryLine(compaction: {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  source: ConfigValueSource;
}): string {
  return `compaction: ${compaction.enabled ? 'automatic' : 'off'}, reserve=${compaction.reserveTokens} token(s) (${compaction.source}; clamped per model to at most a quarter of its window), keep-recent=${compaction.keepRecentTokens} token(s), capped to a quarter of the room below the reserve`;
}

// Human-readable rendering of the same view (one line per fact); secret
// shapes are redacted, so a mis-shaped value never reaches a terminal
// verbatim — and an operator cannot paste one back into a shared log.
export function renderEffectiveConfig(view: EffectiveConfigView): string[] {
  const lines: string[] = [];
  // The disposition split up front: a reader sees how many
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
  // The effective thinking level with its source: what the
  // lane boots with before the model clamp. The `model.thinking` value row
  // above names the file default; this names the winner.
  if (view.thinking !== undefined) {
    lines.push(
      `thinking level: ${view.thinking.level} (${view.thinking.source})`,
    );
  }
  // An always-ask capability in autoApprove never applies: named
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
  lines.push(compactionSummaryLine(view.compaction));
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

// Repository ignore split: config + roles are committed, the four
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
  git?: IgnoreSplitGit,
): { missing: string[]; checked: string[]; applicable: boolean } {
  // When a git runner is injected the toplevel and the exclude
  // resolve the way the writer resolves them — `${cwd}/.git` is a FILE in
  // a linked worktree (so `${cwd}/.git/info/exclude` fails ENOTDIR) and is
  // absent from a subdirectory. Without a runner this module stays
  // process-free and keeps the legacy bridge probe.
  if (git !== undefined) {
    return checkWorkspaceIgnoreSplitViaGit(bridge, cwd, git);
  }
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

// The git seam for the ignore-split check. Injected so this
// module never spawns a process; the prod caller passes a spawnSync runner
// mirroring the writer's.
export type IgnoreSplitGit = (
  cwd: string,
  args: readonly string[],
) => { code: number; out: string };

// The writer's own resolution (`git rev-parse --show-toplevel` +
// `--git-path info/exclude`): in a linked worktree the exclude is the
// common dir's file, unreachable through the worktree's `.git` file. Only
// a failed toplevel (not a repository) reports inapplicable.
function checkWorkspaceIgnoreSplitViaGit(
  bridge: Pick<FileBridge, 'exists' | 'readTextFile'>,
  cwd: string,
  git: IgnoreSplitGit,
): { missing: string[]; checked: string[]; applicable: boolean } {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || top.out === '') {
    return { missing: [], checked: [], applicable: false };
  }
  const probe = git(cwd, ['rev-parse', '--git-path', 'info/exclude']);
  const exclude =
    probe.code === 0 && probe.out !== ''
      ? joinGitPath(cwd, probe.out)
      : undefined;
  const candidates = [
    `${top.out}/.gitignore`,
    ...(exclude === undefined ? [] : [exclude]),
  ];
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
    missing: checkGitignoreSplit(text).missing,
    checked,
    applicable: true,
  };
}

// `rev-parse --show-toplevel` prints absolute; `--git-path` prints
// relative to the invocation cwd. No node:path import (this module stays
// import-light like the `${cwd}/.git` probes above).
function joinGitPath(cwd: string, out: string): string {
  return out.startsWith('/') ? out : `${cwd}/${out}`;
}
