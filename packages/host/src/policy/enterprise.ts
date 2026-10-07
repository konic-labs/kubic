// Enterprise policy engine (TOML surface, precedence). Enterprise is the
// highest non-overridable layer: a lower layer can never unset or narrow an
// enterprise denial, and anything not explicitly allowed is denied
// (deny-by-default is the implicit 8th level below agent). Read-only wrt
// agents/policy, roles resolver, ScopedToken, doctor: no logic is duplicated
// from them and none is modified here — this module owns only the enterprise
// overlay and its evaluation. Faux-only, zero network; no node:fs (FileBridge
// owns I/O).

import type { KubicConfig } from '../config/config.js';

export const POLICY_LAYERS = [
  'enterprise',
  'product',
  'global',
  'project',
  'workspace',
  'session',
  'agent',
] as const;

export type PolicyLayer = (typeof POLICY_LAYERS)[number];

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export class PolicyDeniedError extends PolicyError {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}

export type NetworkMode = 'none' | 'allowlist' | 'full';

export interface ToolsPolicy {
  allow?: string[];
  deny?: string[];
}

export interface NetworkPolicy {
  mode?: NetworkMode;
  domains?: string[];
}

export interface ModelsPolicy {
  providers?: string[];
  ids?: string[];
  thinking?: string;
  /**
   * `allowed_models`: provider-qualified patterns
   * (`provider/id`, `*` wildcard) or bare model ids. Kept beside the exact
   * `providers`/`ids` lists so both vocabularies meet in one policy.
   */
  allowed?: string[];
}

export type FilesystemLevel = 'none' | 'read' | 'workspace-write' | 'full';

export interface FilesystemPolicy {
  level?: FilesystemLevel;
  roots?: string[];
}

export interface DataPolicy {
  retentionDays?: number;
  redactSecrets?: boolean;
  /** `data_policy`: carried, reported, not enforced yet. */
  policy?: string;
}

export type LoggingLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LoggingPolicy {
  level?: LoggingLevel;
  destinations?: string[];
  /** `logging_policy`: carried, reported, not enforced yet. */
  policy?: string;
}

export type AuditSinkKind = 'syslog' | 'file' | 'memory';

export interface AuditSinkSpec {
  kind: AuditSinkKind;
  target: string;
}

export interface AuditPolicy {
  sinks?: AuditSinkSpec[];
}

export interface LayerPolicy {
  tools?: ToolsPolicy;
  network?: NetworkPolicy;
  models?: ModelsPolicy;
  filesystem?: FilesystemPolicy;
  data?: DataPolicy;
  logging?: LoggingPolicy;
  audit?: AuditPolicy;
}

export interface PolicyInput {
  layer: PolicyLayer;
  policy: unknown;
}

export interface EffectivePolicy {
  tools: {
    allow: string[] | undefined;
    deny: string[];
    /** The layer that set the effective allow list (undefined: none set). */
    allowSource: PolicyLayer | undefined;
    /** Normalized tool name → the layer whose deny named it (highest wins). */
    denySources: Record<string, PolicyLayer>;
  };
  network: { mode: NetworkMode | undefined; domains: string[] | undefined };
  models: {
    providers: string[] | undefined;
    ids: string[] | undefined;
    thinking: string | undefined;
    allowed: string[] | undefined;
  };
  filesystem: {
    level: FilesystemLevel | undefined;
    roots: string[] | undefined;
  };
  data: {
    retentionDays: number | undefined;
    redactSecrets: boolean | undefined;
    policy: string | undefined;
  };
  logging: {
    level: LoggingLevel | undefined;
    destinations: string[] | undefined;
    policy: string | undefined;
  };
  audit: { sinks: AuditSinkSpec[] };
}

export interface ResolvedEnterprisePolicy {
  policy: EffectivePolicy;
  overriddenAttempts: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new PolicyError(`'${path}' must be a string array`);
  }
  // Fail-closed list hygiene: empty/whitespace-only entries are refused
  // (a tools.deny of [''] must never land in the deny set), and exact
  // duplicates are collapsed to a single entry, order-preserved.
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value as string[]) {
    if (item.trim() === '') {
      throw new PolicyError(`'${path}' must not contain empty entries`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

// Tool names match case- and whitespace-insensitively: a deny entry of
// 'bash' covers 'Bash', 'BASH', and 'bash '. Normalization is trim plus
// lowercase; the empty string is never a valid tool name.
export function normalizeToolName(tool: string): string {
  return tool.trim().toLowerCase();
}

function toolNameList(
  value: string[] | undefined,
  path: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = normalizeToolName(item);
    if (normalized === '') {
      throw new PolicyError(`'${path}' must not contain empty entries`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

const FILESYSTEM_LEVELS: readonly string[] = [
  'none',
  'read',
  'workspace-write',
  'full',
];

const LOGGING_LEVELS: readonly string[] = ['error', 'warn', 'info', 'debug'];

const SINK_KINDS: readonly string[] = ['syslog', 'file', 'memory'];

// `allowed_models` patterns: `provider/id`, `provider/*`,
// a bare id, or `*` globs. Each segment is non-empty and there is at most
// one slash, so a pattern can never be a typo that matches nothing while
// looking like an allow.
function modelPatternList(value: unknown, path: string): string[] | undefined {
  const entries = stringArray(value, path);
  if (entries === undefined) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    const provider = slash === -1 ? undefined : entry.slice(0, slash);
    const id = slash === -1 ? entry : entry.slice(slash + 1);
    if (
      id === '' ||
      (provider !== undefined && provider === '') ||
      id.includes('/')
    ) {
      throw new PolicyError(
        `'${path}' must be 'provider/id', 'provider/*' or a bare model id (got ${JSON.stringify(entry)})`,
      );
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

function optBooleanLeaf(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new PolicyError(`'${path}' must be a boolean`);
  }
  return value;
}

function optNumberLeaf(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PolicyError(`'${path}' must be a non-negative number`);
  }
  return value;
}

function checkNoUnknown(
  record: Record<string, unknown>,
  known: Set<string>,
  path: string,
  layer: string,
): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new PolicyError(
        `policy layer '${layer}': unknown key '${path}.${key}'`,
      );
    }
  }
}

function parseSinks(
  value: unknown,
  layer: string,
): AuditSinkSpec[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new PolicyError(
      `policy layer '${layer}': 'audit.sinks' must be an array`,
    );
  }
  return value.map((entry, index) => {
    const path = `${layer}.audit.sinks[${index}]`;
    if (!isRecord(entry)) {
      throw new PolicyError(`'${path}' must be a table`);
    }
    checkNoUnknown(entry, new Set(['kind', 'target']), 'audit.sinks[]', layer);
    const kind = entry.kind;
    if (typeof kind !== 'string' || !SINK_KINDS.includes(kind)) {
      throw new PolicyError(
        `'${path}': invalid sink kind ${JSON.stringify(kind)}`,
      );
    }
    const target = entry.target;
    if (typeof target !== 'string' || target === '') {
      throw new PolicyError(`'${path}': 'target' must be a non-empty string`);
    }
    return { kind: kind as AuditSinkKind, target };
  });
}
// Fail-closed validation of one layer's partial policy: unknown keys and
// mistyped leaves are refused, never silently ignored.
const KNOWN_SECTIONS = new Set([
  'tools',
  'network',
  'models',
  'filesystem',
  'credentials',
  'data',
  'logging',
  'agent',
  'audit',
]);

function validateLayerPolicy(raw: unknown, layer: string): LayerPolicy {
  if (!isRecord(raw)) {
    throw new PolicyError(`policy layer '${layer}' must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SECTIONS.has(key)) {
      throw new PolicyError(`policy layer '${layer}': unknown key '${key}'`);
    }
  }
  const out: LayerPolicy = {};
  const tools = raw.tools;
  if (tools !== undefined) {
    if (!isRecord(tools)) {
      throw new PolicyError(`policy layer '${layer}': 'tools' must be a table`);
    }
    for (const key of Object.keys(tools)) {
      if (key !== 'allow' && key !== 'deny') {
        throw new PolicyError(
          `policy layer '${layer}': unknown tools key '${key}'`,
        );
      }
    }
    out.tools = {
      allow: toolNameList(
        stringArray(tools.allow, `${layer}.tools.allow`),
        `${layer}.tools.allow`,
      ),
      deny: toolNameList(
        stringArray(tools.deny, `${layer}.tools.deny`),
        `${layer}.tools.deny`,
      ),
    };
  }
  const network = raw.network;
  if (network !== undefined) {
    if (!isRecord(network)) {
      throw new PolicyError(
        `policy layer '${layer}': 'network' must be a table`,
      );
    }
    for (const key of Object.keys(network)) {
      if (key !== 'mode' && key !== 'domains') {
        throw new PolicyError(
          `policy layer '${layer}': unknown network key '${key}'`,
        );
      }
    }
    const mode = network.mode;
    if (
      mode !== undefined &&
      mode !== 'none' &&
      mode !== 'allowlist' &&
      mode !== 'full'
    ) {
      throw new PolicyError(
        `policy layer '${layer}': invalid network mode ${JSON.stringify(mode)}`,
      );
    }
    out.network = {
      ...(mode === undefined ? {} : { mode }),
      domains: stringArray(network.domains, `${layer}.network.domains`),
    };
  }
  const models = raw.models;
  if (models !== undefined) {
    if (!isRecord(models)) {
      throw new PolicyError(
        `policy layer '${layer}': 'models' must be a table`,
      );
    }
    checkNoUnknown(
      models,
      new Set(['providers', 'ids', 'thinking', 'allowed']),
      'models',
      layer,
    );
    const thinking = models.thinking;
    if (
      thinking !== undefined &&
      (typeof thinking !== 'string' ||
        !(THINKING_LEVELS as readonly string[]).includes(thinking))
    ) {
      throw new PolicyError(
        `policy layer '${layer}': invalid thinking ${JSON.stringify(thinking)}`,
      );
    }
    out.models = {
      providers: stringArray(models.providers, `${layer}.models.providers`),
      ids: stringArray(models.ids, `${layer}.models.ids`),
      ...(thinking === undefined ? {} : { thinking }),
      allowed: modelPatternList(models.allowed, `${layer}.models.allowed`),
    };
  }
  const filesystem = raw.filesystem;
  if (filesystem !== undefined) {
    if (!isRecord(filesystem)) {
      throw new PolicyError(
        `policy layer '${layer}': 'filesystem' must be a table`,
      );
    }
    checkNoUnknown(
      filesystem,
      new Set(['level', 'roots']),
      'filesystem',
      layer,
    );
    const level = filesystem.level;
    if (
      level !== undefined &&
      (typeof level !== 'string' || !FILESYSTEM_LEVELS.includes(level))
    ) {
      throw new PolicyError(
        `policy layer '${layer}': invalid filesystem level ${JSON.stringify(level)}`,
      );
    }
    out.filesystem = {
      ...(level === undefined ? {} : { level: level as FilesystemLevel }),
      roots: stringArray(filesystem.roots, `${layer}.filesystem.roots`),
    };
  }
  const data = raw.data;
  if (data !== undefined) {
    if (!isRecord(data)) {
      throw new PolicyError(`policy layer '${layer}': 'data' must be a table`);
    }
    checkNoUnknown(
      data,
      new Set(['retentionDays', 'redactSecrets', 'policy']),
      'data',
      layer,
    );
    const dataPolicy = data.policy;
    if (
      dataPolicy !== undefined &&
      (typeof dataPolicy !== 'string' || dataPolicy === '')
    ) {
      throw new PolicyError(
        `policy layer '${layer}': 'data.policy' must be a non-empty string`,
      );
    }
    out.data = {
      retentionDays: optNumberLeaf(
        data,
        'retentionDays',
        `${layer}.data.retentionDays`,
      ),
      redactSecrets: optBooleanLeaf(
        data,
        'redactSecrets',
        `${layer}.data.redactSecrets`,
      ),
      ...(dataPolicy === undefined ? {} : { policy: dataPolicy }),
    };
  }
  const logging = raw.logging;
  if (logging !== undefined) {
    if (!isRecord(logging)) {
      throw new PolicyError(
        `policy layer '${layer}': 'logging' must be a table`,
      );
    }
    checkNoUnknown(
      logging,
      new Set(['level', 'destinations', 'policy']),
      'logging',
      layer,
    );
    const level = logging.level;
    if (
      level !== undefined &&
      (typeof level !== 'string' || !LOGGING_LEVELS.includes(level))
    ) {
      throw new PolicyError(
        `policy layer '${layer}': invalid logging level ${JSON.stringify(level)}`,
      );
    }
    const loggingPolicy = logging.policy;
    if (
      loggingPolicy !== undefined &&
      (typeof loggingPolicy !== 'string' || loggingPolicy === '')
    ) {
      throw new PolicyError(
        `policy layer '${layer}': 'logging.policy' must be a non-empty string`,
      );
    }
    out.logging = {
      ...(level === undefined ? {} : { level: level as LoggingLevel }),
      destinations: stringArray(
        logging.destinations,
        `${layer}.logging.destinations`,
      ),
      ...(loggingPolicy === undefined ? {} : { policy: loggingPolicy }),
    };
  }
  const audit = raw.audit;
  if (audit !== undefined) {
    if (!isRecord(audit)) {
      throw new PolicyError(`policy layer '${layer}': 'audit' must be a table`);
    }
    checkNoUnknown(audit, new Set(['sinks']), 'audit', layer);
    out.audit = { sinks: parseSinks(audit.sinks, layer) };
  }
  return out;
}

// Merge enterprise→agent: the first (highest) layer to set a leaf wins.
// Denials accumulate downward (a lower layer may only narrow, never lift).
// Every rejected override attempt is reported, never applied.
export function resolveEffectivePolicy(
  inputs: PolicyInput[],
): ResolvedEnterprisePolicy {
  for (const input of inputs) {
    if (!(POLICY_LAYERS as readonly string[]).includes(input.layer)) {
      throw new PolicyError(`unknown policy layer '${input.layer}'`);
    }
  }
  const ordered = [...inputs].sort(
    (a, b) => POLICY_LAYERS.indexOf(a.layer) - POLICY_LAYERS.indexOf(b.layer),
  );
  const overriddenAttempts: string[] = [];
  let allow: string[] | undefined;
  let allowSetter = '';
  let allowSource: PolicyLayer | undefined;
  const deny = new Set<string>();
  const denySources: Record<string, PolicyLayer> = {};
  let mode: NetworkMode | undefined;
  let domains: string[] | undefined;
  let providers: string[] | undefined;
  let modelIds: string[] | undefined;
  let thinking: string | undefined;
  let modelAllowed: string[] | undefined;
  let fsLevel: FilesystemLevel | undefined;
  let fsRoots: string[] | undefined;
  let retentionDays: number | undefined;
  let redactSecrets: boolean | undefined;
  let dataPolicy: string | undefined;
  let logLevel: LoggingLevel | undefined;
  let logDestinations: string[] | undefined;
  let loggingPolicy: string | undefined;
  let sinks: AuditSinkSpec[] | undefined;
  const take = <T>(
    layer: string,
    path: string,
    next: T | undefined,
    get: () => T | undefined,
    set: (value: T) => void,
  ): void => {
    if (next === undefined) return;
    const current = get();
    if (current === undefined) {
      set(next);
    } else if (JSON.stringify(current) !== JSON.stringify(next)) {
      overriddenAttempts.push(
        `${layer}.${path} overridden by enterprise precedence`,
      );
    }
  };
  for (const input of ordered) {
    const parsed = validateLayerPolicy(input.policy, input.layer);
    if (parsed.tools?.deny !== undefined) {
      for (const tool of parsed.tools.deny) {
        if (!(tool in denySources)) denySources[tool] = input.layer;
        deny.add(tool);
      }
    }
    if (parsed.tools?.allow !== undefined) {
      if (allow === undefined) {
        allow = [...parsed.tools.allow];
        allowSetter = input.layer;
        allowSource = input.layer;
      } else if (JSON.stringify(allow) !== JSON.stringify(parsed.tools.allow)) {
        overriddenAttempts.push(
          `${input.layer}.tools.allow overridden by ${allowSetter}`,
        );
      }
    }
    if (parsed.network?.mode !== undefined) {
      if (mode === undefined) {
        mode = parsed.network.mode;
      } else if (mode !== parsed.network.mode) {
        overriddenAttempts.push(
          `${input.layer}.network.mode overridden by enterprise precedence`,
        );
      }
    }
    if (parsed.network?.domains !== undefined) {
      if (domains === undefined) {
        domains = [...parsed.network.domains];
      } else if (
        JSON.stringify(domains) !== JSON.stringify(parsed.network.domains)
      ) {
        overriddenAttempts.push(
          `${input.layer}.network.domains overridden by enterprise precedence`,
        );
      }
    }
    take(
      input.layer,
      'models.providers',
      parsed.models?.providers,
      () => providers,
      (v) => {
        providers = [...v];
      },
    );
    take(
      input.layer,
      'models.ids',
      parsed.models?.ids,
      () => modelIds,
      (v) => {
        modelIds = [...v];
      },
    );
    take(
      input.layer,
      'models.thinking',
      parsed.models?.thinking,
      () => thinking,
      (v) => {
        thinking = v;
      },
    );
    take(
      input.layer,
      'models.allowed',
      parsed.models?.allowed,
      () => modelAllowed,
      (v) => {
        modelAllowed = [...v];
      },
    );
    take(
      input.layer,
      'filesystem.level',
      parsed.filesystem?.level,
      () => fsLevel,
      (v) => {
        fsLevel = v;
      },
    );
    take(
      input.layer,
      'filesystem.roots',
      parsed.filesystem?.roots,
      () => fsRoots,
      (v) => {
        fsRoots = [...v];
      },
    );
    take(
      input.layer,
      'data.retentionDays',
      parsed.data?.retentionDays,
      () => retentionDays,
      (v) => {
        retentionDays = v;
      },
    );
    take(
      input.layer,
      'data.redactSecrets',
      parsed.data?.redactSecrets,
      () => redactSecrets,
      (v) => {
        redactSecrets = v;
      },
    );
    take(
      input.layer,
      'data.policy',
      parsed.data?.policy,
      () => dataPolicy,
      (v) => {
        dataPolicy = v;
      },
    );
    take(
      input.layer,
      'logging.level',
      parsed.logging?.level,
      () => logLevel,
      (v) => {
        logLevel = v;
      },
    );
    take(
      input.layer,
      'logging.destinations',
      parsed.logging?.destinations,
      () => logDestinations,
      (v) => {
        logDestinations = [...v];
      },
    );
    take(
      input.layer,
      'logging.policy',
      parsed.logging?.policy,
      () => loggingPolicy,
      (v) => {
        loggingPolicy = v;
      },
    );
    take(
      input.layer,
      'audit.sinks',
      parsed.audit?.sinks,
      () => sinks,
      (v) => {
        sinks = [...v];
      },
    );
  }
  // A lower-layer allow that names an enterprise-denied tool is a rejected
  // override attempt even though allow/deny are separate leaves.
  const effective: EffectivePolicy = {
    tools: { allow, deny: [...deny].sort(), allowSource, denySources },
    network: { mode, domains },
    models: { providers, ids: modelIds, thinking, allowed: modelAllowed },
    filesystem: { level: fsLevel, roots: fsRoots },
    data: { retentionDays, redactSecrets, policy: dataPolicy },
    logging: {
      level: logLevel,
      destinations: logDestinations,
      policy: loggingPolicy,
    },
    audit: { sinks: sinks ?? [] },
  };
  for (const input of ordered) {
    if (input.layer === 'enterprise') continue;
    const parsed = validateLayerPolicy(input.policy, input.layer);
    for (const tool of parsed.tools?.allow ?? []) {
      if (deny.has(tool)) {
        overriddenAttempts.push(
          `${input.layer}.tools.allow '${tool}' rejected: enterprise denial holds`,
        );
      }
    }
  }
  return { policy: effective, overriddenAttempts };
}

// → engine vocabulary: the `[policy]` section's flat keys
// become the LayerPolicy leaves `resolveEffectivePolicy` merges. The two
// spellings that differ are reconciled here, in one place:
//   network_policy = "proxy"           → network.mode = 'allowlist'
//   filesystem_policy = "workspace-only" → filesystem.level = 'workspace-write'
// The engine names are accepted in config too, so either vocabulary loads.
// `[[audit]]` is deliberately not translated: the engine's AuditSinkSpec has
// no level field and the syslog sink is a named follow-up, so the config
// keeps the parsed table for that work while this bridge stays honest.
const NETWORK_POLICY_MODES: Record<string, NetworkMode> = {
  proxy: 'allowlist',
  none: 'none',
  allowlist: 'allowlist',
  full: 'full',
};

const FILESYSTEM_POLICY_LEVELS: Record<string, FilesystemLevel> = {
  'workspace-only': 'workspace-write',
  none: 'none',
  read: 'read',
  'workspace-write': 'workspace-write',
  full: 'full',
};

export function layerPolicyFromConfig(config: KubicConfig): LayerPolicy {
  const p = config.policy;
  if (p === undefined) return {};
  const out: LayerPolicy = {};
  if (p.allowedTools !== undefined || p.deniedTools !== undefined) {
    out.tools = {
      ...(p.allowedTools === undefined ? {} : { allow: [...p.allowedTools] }),
      ...(p.deniedTools === undefined ? {} : { deny: [...p.deniedTools] }),
    };
  }
  if (p.allowedProviders !== undefined || p.allowedModels !== undefined) {
    out.models = {
      ...(p.allowedProviders === undefined
        ? {}
        : { providers: [...p.allowedProviders] }),
      ...(p.allowedModels === undefined
        ? {}
        : { allowed: [...p.allowedModels] }),
    };
  }
  if (p.networkPolicy !== undefined || p.allowedDomains !== undefined) {
    let mode: NetworkMode | undefined;
    if (p.networkPolicy !== undefined) {
      mode = NETWORK_POLICY_MODES[p.networkPolicy];
      if (mode === undefined) {
        throw new PolicyError(
          `'policy.network_policy' must be one of ${Object.keys(NETWORK_POLICY_MODES).join(', ')} (got ${JSON.stringify(p.networkPolicy)})`,
        );
      }
    }
    out.network = {
      ...(mode === undefined ? {} : { mode }),
      ...(p.allowedDomains === undefined
        ? {}
        : { domains: [...p.allowedDomains] }),
    };
  }
  if (p.filesystemPolicy !== undefined) {
    const level = FILESYSTEM_POLICY_LEVELS[p.filesystemPolicy];
    if (level === undefined) {
      throw new PolicyError(
        `'policy.filesystem_policy' must be one of ${Object.keys(FILESYSTEM_POLICY_LEVELS).join(', ')} (got ${JSON.stringify(p.filesystemPolicy)})`,
      );
    }
    out.filesystem = { level };
  }
  if (p.dataPolicy !== undefined) out.data = { policy: p.dataPolicy };
  if (p.loggingPolicy !== undefined) out.logging = { policy: p.loggingPolicy };
  return out;
}

// Deny-by-default: a denied tool is never allowed; an unlisted tool is
// allowed only when an explicit allow list names it. Matching is
// case- and whitespace-insensitive on both sides.
export function isToolAllowed(policy: EffectivePolicy, tool: string): boolean {
  const normalized = normalizeToolName(tool);
  if (
    policy.tools.deny.some((denied) => normalizeToolName(denied) === normalized)
  ) {
    return false;
  }
  if (policy.tools.allow === undefined) return false;
  return policy.tools.allow.some(
    (allowed) => normalizeToolName(allowed) === normalized,
  );
}

// The LANE's enterprise gate: the effective policy can only
// narrow what the lane's classes/roles already allow. It denies a named
// denied tool always, and — when the enterprise layer configured an allow
// list — anything outside it; with NO allow list configured the enterprise
// layer says nothing about the tool and the lane's own allowlist decides.
// (`isToolAllowed` keeps the engine's deny-by-default reading for callers
// that merge an explicit allowlist, like `kubic policy`.)
export function isToolAllowedByEnterprise(
  policy: EffectivePolicy,
  tool: string,
): boolean {
  const normalized = normalizeToolName(tool);
  if (
    policy.tools.deny.some((denied) => normalizeToolName(denied) === normalized)
  ) {
    return false;
  }
  if (policy.tools.allow === undefined) return true;
  return policy.tools.allow.some(
    (allowed) => normalizeToolName(allowed) === normalized,
  );
}

// A denied tool is not re-enableable by project, role, or model: any grant
// path funnels through this gate and the enterprise denial holds. The
// predicate is the LANE's: a deny
// list narrows and an absent allow list says nothing about a tool — the
// engine's deny-by-default reading (`isToolAllowed`) would refuse every role
// under a deny-only policy while the lane gate still admits its tools.
export function assertToolGrantable(
  policy: EffectivePolicy,
  tool: string,
  requester: { layer: string; role?: string; model?: string },
): void {
  if (isToolAllowedByEnterprise(policy, tool)) return;
  const who =
    requester.role !== undefined
      ? `role '${requester.role}'`
      : requester.model !== undefined
        ? `model '${requester.model}'`
        : `layer '${requester.layer}'`;
  throw new PolicyDeniedError(
    `tool '${tool}' denied for ${who}: enterprise denial holds (deny-by-default)`,
  );
}

// Deny-by-default for network: unset mode denies; allowlist names exact
// hosts; none denies everything.
export function isNetworkAllowed(
  policy: EffectivePolicy,
  host: string,
): boolean {
  if (policy.network.mode === undefined || policy.network.mode === 'none') {
    return false;
  }
  if (policy.network.mode === 'full') return true;
  return policy.network.domains?.includes(host) ?? false;
}

// `allowed_models` matching: `*` globs inside an id segment
// (or a whole segment), `provider/id`, or a bare id that matches across
// providers. A pattern with a provider segment only matches that provider —
// so `faux/*` can never widen to `other/*`.
function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function patternMatchesProvider(pattern: string, provider: string): boolean {
  const slash = pattern.indexOf('/');
  if (slash === -1) return true;
  return globMatches(pattern.slice(0, slash), provider);
}

function patternMatchesModel(
  pattern: string,
  provider: string,
  id: string,
): boolean {
  const slash = pattern.indexOf('/');
  if (slash === -1) return globMatches(pattern, id);
  return (
    globMatches(pattern.slice(0, slash), provider) &&
    globMatches(pattern.slice(slash + 1), id)
  );
}

// Whether the layer configured a tool gate at all. An absent [policy]
// section (or one that names only models) must not deny every tool by
// accident: the lane gate is only installed when this is true.
export function hasToolPolicy(policy: EffectivePolicy): boolean {
  return policy.tools.allow !== undefined || policy.tools.deny.length > 0;
}

// Same question for models: no allowlist configured means no model gate.
export function hasModelPolicy(policy: EffectivePolicy): boolean {
  return (
    policy.models.providers !== undefined ||
    policy.models.ids !== undefined ||
    policy.models.allowed !== undefined
  );
}

// Deny-by-default for models: an unlisted provider is never allowed; an
// unlisted model id is allowed only when no id allowlist is set.
// `allowed` patterns add provider-qualified matches; every
// configured list applies (intersection), never widens.
export function isProviderAllowed(
  policy: EffectivePolicy,
  provider: string,
): boolean {
  if (
    policy.models.providers !== undefined &&
    !policy.models.providers.includes(provider)
  ) {
    return false;
  }
  if (policy.models.allowed !== undefined) {
    return policy.models.allowed.some((pattern) =>
      patternMatchesProvider(pattern, provider),
    );
  }
  return policy.models.providers !== undefined;
}

export function isModelAllowed(
  policy: EffectivePolicy,
  provider: string,
  id: string,
): boolean {
  if (!isProviderAllowed(policy, provider)) return false;
  if (policy.models.ids !== undefined && !policy.models.ids.includes(id)) {
    return false;
  }
  if (policy.models.allowed !== undefined) {
    return policy.models.allowed.some((pattern) =>
      patternMatchesModel(pattern, provider, id),
    );
  }
  return true;
}

export interface BrokerSecret {
  ref: string;
  value: string;
}

export interface EnterpriseDoctorEnv {
  syslogAvailable: boolean;
}

// Unenforceable policy is never silent: every check below is always
// emitted — enforceable leaves report pass, unenforceable ones report fail
// with the reason. Check ids are enterprise-scoped so they never collide
// with the host doctor or honest-limits checks (read-only, unmodified).
export function enterpriseDoctorChecks(
  policy: EffectivePolicy,
  env: EnterpriseDoctorEnv,
): import('../doctor.js').DoctorCheck[] {
  const sinks = policy.audit.sinks;
  let sinksCheck: import('../doctor.js').DoctorCheck;
  if (sinks.length === 0) {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: 'no audit sinks: privileged actions would go unaudited',
    };
  } else if (sinks[0]?.kind !== 'syslog') {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: 'audit sinks must be syslog-first ([[audit]] order)',
    };
  } else if (
    sinks.some((sink) => sink.kind === 'syslog') &&
    !env.syslogAvailable
  ) {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'fail',
      reason: 'policy-mismatch',
      detail: 'syslog sink is unenforceable: syslog unavailable',
    };
  } else {
    sinksCheck = {
      id: 'policy:enterprise-sinks',
      label: 'policy enterprise audit sinks',
      status: 'pass',
      reason: 'ok',
      detail: `syslog-first, ${sinks.length} sink(s) configured`,
    };
  }
  const allowlistEmpty =
    policy.network.mode === 'allowlist' &&
    (policy.network.domains === undefined ||
      policy.network.domains.length === 0);
  const networkCheck: import('../doctor.js').DoctorCheck = allowlistEmpty
    ? {
        id: 'policy:enterprise-network',
        label: 'policy enterprise network',
        status: 'fail',
        reason: 'policy-mismatch',
        detail: 'network allowlist mode with no domains is unenforceable',
      }
    : {
        id: 'policy:enterprise-network',
        label: 'policy enterprise network',
        status: 'pass',
        reason: 'ok',
        detail: `network mode ${policy.network.mode ?? 'unset (deny-by-default)'}`,
      };
  const failed = [sinksCheck, networkCheck].filter(
    (check) => check.status === 'fail',
  ).length;
  const enforceability: import('../doctor.js').DoctorCheck =
    failed === 0
      ? {
          id: 'policy:enterprise-enforceability',
          label: 'policy enterprise enforceability',
          status: 'pass',
          reason: 'ok',
          detail: 'enterprise policy enforceable on this host',
        }
      : {
          id: 'policy:enterprise-enforceability',
          label: 'policy enterprise enforceability',
          status: 'fail',
          reason: 'policy-mismatch',
          detail: `${failed} unenforceable enterprise policy item(s)`,
        };
  return [sinksCheck, networkCheck, enforceability];
}
