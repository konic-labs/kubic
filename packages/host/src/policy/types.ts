// Enterprise policy engine (TOML surface, precedence). Enterprise is the
// highest non-overridable layer: a lower layer can never unset or narrow an
// enterprise denial, and anything not explicitly allowed is denied
// (deny-by-default is the implicit level below agent). Read-only wrt
// agents/policy, roles resolver, ScopedToken, doctor: no logic is duplicated
// from them and none is modified here — this module owns only the enterprise
// overlay and its evaluation. Faux-only, zero network; no node:fs (FileBridge
// owns I/O).
export const POLICY_LAYERS = [
  'enterprise',
  'product',
  'global',
  'project',
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

interface ToolsPolicy {
  allow?: string[];
  deny?: string[];
}

interface NetworkPolicy {
  mode?: NetworkMode;
  domains?: string[];
}

interface ModelsPolicy {
  providers?: string[];
  ids?: string[];
  thinking?: string;
  /**
   * `allowed_models`: provider-qualified patterns
   * (`provider/id`, `*` wildcard) or bare model ids. Kept beside the exact
   * `providers`/`ids` lists so both vocabularies meet in one policy.
   */
  allowed?: string[];
  /** `allowed_regions`: region ids or `*` globs a model endpoint may run in. */
  regions?: string[];
}

export type FilesystemLevel = 'none' | 'read' | 'workspace-write' | 'full';

interface FilesystemPolicy {
  level?: FilesystemLevel;
  roots?: string[];
}

interface DataPolicy {
  retentionDays?: number;
  redactSecrets?: boolean;
  /** `data_policy`: carried, reported, not enforced yet. */
  policy?: string;
}

export type LoggingLevel = 'error' | 'warn' | 'info' | 'debug';

interface LoggingPolicy {
  level?: LoggingLevel;
  destinations?: string[];
  /** `logging_policy`: carried, reported, not enforced yet. */
  policy?: string;
}

export type AuditSinkKind = 'syslog' | 'file' | 'memory' | 'https' | 'otlp';

export interface AuditSinkSpec {
  kind: AuditSinkKind;
  target: string;
}

interface AuditPolicy {
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
    regions: string[] | undefined;
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
