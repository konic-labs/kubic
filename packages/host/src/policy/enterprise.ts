// Enterprise policy engine (issue #57; §58 TOML surface, precedence).
// Enterprise is the highest non-overridable layer: a lower layer can never
// unset or narrow an enterprise denial, and anything not explicitly allowed
// is denied (deny-by-default is the implicit 8th level below agent).
// Read-only wrt agents/policy (#15), roles resolver (#43), ScopedToken
// (#38), doctor (#29): no logic is duplicated from them and none is
// modified here — this module owns only the enterprise overlay and its
// evaluation. Faux-only, zero network; no node:fs (FileBridge owns I/O).

import { containsSecretShape } from './secret-shapes.js';

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
}

export type FilesystemLevel = 'none' | 'read' | 'workspace-write' | 'full';

export interface FilesystemPolicy {
  level?: FilesystemLevel;
  roots?: string[];
}

export interface CredentialsPolicy {
  requireCredentialBroker?: boolean;
  denyLocalCredentials?: boolean;
}

export interface DataPolicy {
  retentionDays?: number;
  redactSecrets?: boolean;
}

export type LoggingLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LoggingPolicy {
  level?: LoggingLevel;
  destinations?: string[];
}

export interface AgentPolicy {
  maxWorkers?: number;
  maxCostUsd?: number;
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
  credentials?: CredentialsPolicy;
  data?: DataPolicy;
  logging?: LoggingPolicy;
  agent?: AgentPolicy;
  audit?: AuditPolicy;
}

export interface PolicyInput {
  layer: PolicyLayer;
  policy: unknown;
}

export interface EffectivePolicy {
  tools: { allow: string[] | undefined; deny: string[] };
  network: { mode: NetworkMode | undefined; domains: string[] | undefined };
  models: {
    providers: string[] | undefined;
    ids: string[] | undefined;
    thinking: string | undefined;
  };
  filesystem: {
    level: FilesystemLevel | undefined;
    roots: string[] | undefined;
  };
  credentials: {
    requireCredentialBroker: boolean;
    denyLocalCredentials: boolean;
  };
  data: {
    retentionDays: number | undefined;
    redactSecrets: boolean | undefined;
  };
  logging: {
    level: LoggingLevel | undefined;
    destinations: string[] | undefined;
  };
  agent: { maxWorkers: number | undefined; maxCostUsd: number | undefined };
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
      new Set(['providers', 'ids', 'thinking']),
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
  const credentials = raw.credentials;
  if (credentials !== undefined) {
    if (!isRecord(credentials)) {
      throw new PolicyError(
        `policy layer '${layer}': 'credentials' must be a table`,
      );
    }
    checkNoUnknown(
      credentials,
      new Set(['requireCredentialBroker', 'denyLocalCredentials']),
      'credentials',
      layer,
    );
    out.credentials = {
      requireCredentialBroker: optBooleanLeaf(
        credentials,
        'requireCredentialBroker',
        `${layer}.credentials.requireCredentialBroker`,
      ),
      denyLocalCredentials: optBooleanLeaf(
        credentials,
        'denyLocalCredentials',
        `${layer}.credentials.denyLocalCredentials`,
      ),
    };
  }
  const data = raw.data;
  if (data !== undefined) {
    if (!isRecord(data)) {
      throw new PolicyError(`policy layer '${layer}': 'data' must be a table`);
    }
    checkNoUnknown(
      data,
      new Set(['retentionDays', 'redactSecrets']),
      'data',
      layer,
    );
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
      new Set(['level', 'destinations']),
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
    out.logging = {
      ...(level === undefined ? {} : { level: level as LoggingLevel }),
      destinations: stringArray(
        logging.destinations,
        `${layer}.logging.destinations`,
      ),
    };
  }
  const agent = raw.agent;
  if (agent !== undefined) {
    if (!isRecord(agent)) {
      throw new PolicyError(`policy layer '${layer}': 'agent' must be a table`);
    }
    checkNoUnknown(
      agent,
      new Set(['maxWorkers', 'maxCostUsd']),
      'agent',
      layer,
    );
    out.agent = {
      maxWorkers: optNumberLeaf(
        agent,
        'maxWorkers',
        `${layer}.agent.maxWorkers`,
      ),
      maxCostUsd: optNumberLeaf(
        agent,
        'maxCostUsd',
        `${layer}.agent.maxCostUsd`,
      ),
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
  const deny = new Set<string>();
  let mode: NetworkMode | undefined;
  let domains: string[] | undefined;
  let providers: string[] | undefined;
  let modelIds: string[] | undefined;
  let thinking: string | undefined;
  let fsLevel: FilesystemLevel | undefined;
  let fsRoots: string[] | undefined;
  let requireBroker: boolean | undefined;
  let denyLocal: boolean | undefined;
  let retentionDays: number | undefined;
  let redactSecrets: boolean | undefined;
  let logLevel: LoggingLevel | undefined;
  let logDestinations: string[] | undefined;
  let maxWorkers: number | undefined;
  let maxCostUsd: number | undefined;
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
      for (const tool of parsed.tools.deny) deny.add(tool);
    }
    if (parsed.tools?.allow !== undefined) {
      if (allow === undefined) {
        allow = [...parsed.tools.allow];
        allowSetter = input.layer;
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
      'credentials.requireCredentialBroker',
      parsed.credentials?.requireCredentialBroker,
      () => requireBroker,
      (v) => {
        requireBroker = v;
      },
    );
    take(
      input.layer,
      'credentials.denyLocalCredentials',
      parsed.credentials?.denyLocalCredentials,
      () => denyLocal,
      (v) => {
        denyLocal = v;
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
      'agent.maxWorkers',
      parsed.agent?.maxWorkers,
      () => maxWorkers,
      (v) => {
        maxWorkers = v;
      },
    );
    take(
      input.layer,
      'agent.maxCostUsd',
      parsed.agent?.maxCostUsd,
      () => maxCostUsd,
      (v) => {
        maxCostUsd = v;
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
    tools: { allow, deny: [...deny].sort() },
    network: { mode, domains },
    models: { providers, ids: modelIds, thinking },
    filesystem: { level: fsLevel, roots: fsRoots },
    credentials: {
      requireCredentialBroker: requireBroker ?? false,
      denyLocalCredentials: denyLocal ?? false,
    },
    data: { retentionDays, redactSecrets },
    logging: { level: logLevel, destinations: logDestinations },
    agent: { maxWorkers, maxCostUsd },
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

// A denied tool is not re-enableable by project, role, or model: any grant
// path funnels through this gate and the enterprise denial holds.
export function assertToolGrantable(
  policy: EffectivePolicy,
  tool: string,
  requester: { layer: string; role?: string; model?: string },
): void {
  if (isToolAllowed(policy, tool)) return;
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

// Deny-by-default for models: an unlisted provider is never allowed; an
// unlisted model id is allowed only when no id allowlist is set.
export function isProviderAllowed(
  policy: EffectivePolicy,
  provider: string,
): boolean {
  if (policy.models.providers === undefined) return false;
  return policy.models.providers.includes(provider);
}

export function isModelAllowed(
  policy: EffectivePolicy,
  provider: string,
  id: string,
): boolean {
  if (!isProviderAllowed(policy, provider)) return false;
  if (policy.models.ids === undefined) return true;
  return policy.models.ids.includes(id);
}

export interface BrokerSecret {
  ref: string;
  value: string;
}

export interface BrokeredEnv {
  env: Record<string, string>;
  // Every listed secret replaced in a value is recorded, in order: two
  // secrets sharing one value both appear here, never just the last one.
  sentinels: Record<string, string[]>;
}

// Credential broker (§36): when require_credential_broker holds, live
// secret values never reach worker env — every occurrence is replaced by a
// `broker:<ref>` sentinel that names the ref without carrying material.
// Without the broker flag the env passes through untouched. Shape backstop:
// any unlisted secret-shaped value still present after replacement is
// refused loudly — an empty secrets list never means passthrough.
export function buildBrokeredWorkerEnv(
  env: Record<string, string>,
  secrets: BrokerSecret[],
  policy: EffectivePolicy,
): BrokeredEnv {
  if (!policy.credentials.requireCredentialBroker) {
    return { env: { ...env }, sentinels: {} };
  }
  const out: Record<string, string> = {};
  const sentinels: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(env)) {
    let replaced = value;
    for (const secret of secrets) {
      if (secret.value === '') continue;
      if (replaced.includes(secret.value)) {
        replaced = replaced.split(secret.value).join(`broker:${secret.ref}`);
        const seen = sentinels[key] ?? [];
        const marker = `broker:${secret.ref}`;
        if (!seen.includes(marker)) seen.push(marker);
        sentinels[key] = seen;
      }
    }
    if (containsSecretShape(replaced)) {
      throw new PolicyDeniedError(
        'worker env contains unlisted secret-shaped material: broker violation',
      );
    }
    out[key] = replaced;
  }
  return { env: out, sentinels };
}

// Loud verifier for brokered payloads: any live secret material present
// throws, including unlisted secret-shaped material. The message never
// echoes the secret itself.
export function assertNoSecretMaterial(
  value: unknown,
  secrets: string[],
): void {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret === '') continue;
    if (text.includes(secret)) {
      throw new PolicyDeniedError(
        'worker env/dump contains secret material: broker violation',
      );
    }
  }
  if (containsSecretShape(text)) {
    throw new PolicyDeniedError(
      'worker env/dump contains secret-shaped material: broker violation',
    );
  }
}

const LOCAL_CREDENTIAL_KEYS: readonly string[] = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

function isLocalCredentialKey(key: string): boolean {
  if ((LOCAL_CREDENTIAL_KEYS as readonly string[]).includes(key)) return true;
  return (
    key.endsWith('_TOKEN') ||
    key.endsWith('_SECRET') ||
    key.endsWith('_PRIVATE_KEY')
  );
}

// deny_local_credentials: local credential keys must not appear in worker
// env at all (brokered refs travel via the broker, never as env values).
// Values are scanned too: a secret-shaped value under an innocuous key is
// refused alongside sensitive key names. Only the key name is reported,
// never any value.
export function assertNoLocalCredentials(
  env: Record<string, string>,
  policy: EffectivePolicy,
): void {
  if (!policy.credentials.denyLocalCredentials) return;
  for (const [key, value] of Object.entries(env)) {
    if (isLocalCredentialKey(key)) {
      throw new PolicyDeniedError(
        `local credential key '${key}' refused in worker env: deny_local_credentials holds`,
      );
    }
    if (containsSecretShape(value)) {
      throw new PolicyDeniedError(
        `secret-shaped value for '${key}' refused in worker env: deny_local_credentials holds`,
      );
    }
  }
}

export interface EnterpriseDoctorEnv {
  syslogAvailable: boolean;
}

// Unenforceable policy is never silent (§50): every check below is always
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
