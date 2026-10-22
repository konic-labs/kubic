// Resolving the effective policy from its layers, enterprise first, and
// projecting a config load into a layer.
import type { KubicConfig } from '../config/index.js';
import type {
  AuditSinkSpec,
  EffectivePolicy,
  FilesystemLevel,
  LayerPolicy,
  LoggingLevel,
  NetworkMode,
  PolicyInput,
  PolicyLayer,
  ResolvedEnterprisePolicy,
} from './types.js';
import { POLICY_LAYERS, PolicyError } from './types.js';
import { validateLayerPolicy } from './validate.js';

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
  const merge: Merge = {
    overriddenAttempts: [],
    allowSetter: '',
    deny: new Set<string>(),
    denySources: {},
    leaves: new Map(),
  };
  for (const input of ordered) {
    const parsed = validateLayerPolicy(input.policy, input.layer);
    mergeTools(merge, parsed, input.layer);
    for (const [path, read] of FIRST_SET_LEAVES) {
      mergeLeaf(merge, input.layer, path, read(parsed));
    }
  }
  const effective = effectivePolicyOf(merge);
  // A lower-layer allow that names an enterprise-denied tool is a rejected
  // override attempt even though allow/deny are separate leaves.
  for (const input of ordered) {
    if (input.layer === 'enterprise') continue;
    const parsed = validateLayerPolicy(input.policy, input.layer);
    for (const tool of parsed.tools?.allow ?? []) {
      if (merge.deny.has(tool)) {
        merge.overriddenAttempts.push(
          `${input.layer}.tools.allow '${tool}' rejected: enterprise denial holds`,
        );
      }
    }
  }
  return { policy: effective, overriddenAttempts: merge.overriddenAttempts };
}

// The merge across layers, highest first.
interface Merge {
  overriddenAttempts: string[];
  allow?: string[];
  allowSetter: string;
  allowSource?: PolicyLayer;
  deny: Set<string>;
  denySources: Record<string, PolicyLayer>;
  // Every other leaf, by its dotted path.
  leaves: Map<string, unknown>;
}

// The leaves the first (highest) layer to set them owns. A lower layer's
// different value is reported as an overridden attempt, never applied.
const FIRST_SET_LEAVES: ReadonlyArray<
  readonly [string, (policy: LayerPolicy) => unknown]
> = [
  ['network.mode', (p) => p.network?.mode],
  ['network.domains', (p) => p.network?.domains],
  ['models.providers', (p) => p.models?.providers],
  ['models.ids', (p) => p.models?.ids],
  ['models.thinking', (p) => p.models?.thinking],
  ['models.allowed', (p) => p.models?.allowed],
  ['models.regions', (p) => p.models?.regions],
  ['filesystem.level', (p) => p.filesystem?.level],
  ['filesystem.roots', (p) => p.filesystem?.roots],
  ['data.retentionDays', (p) => p.data?.retentionDays],
  ['data.redactSecrets', (p) => p.data?.redactSecrets],
  ['data.policy', (p) => p.data?.policy],
  ['logging.level', (p) => p.logging?.level],
  ['logging.destinations', (p) => p.logging?.destinations],
  ['logging.policy', (p) => p.logging?.policy],
  ['audit.sinks', (p) => p.audit?.sinks],
];

function mergeLeaf(
  merge: Merge,
  layer: string,
  path: string,
  next: unknown,
): void {
  if (next === undefined) return;
  const current = merge.leaves.get(path);
  if (current === undefined) {
    merge.leaves.set(path, Array.isArray(next) ? [...next] : next);
  } else if (JSON.stringify(current) !== JSON.stringify(next)) {
    merge.overriddenAttempts.push(
      `${layer}.${path} overridden by enterprise precedence`,
    );
  }
}

// Tools: denials accumulate from every layer (the first layer to deny a tool
// is its recorded source); the allow list is the first layer's to set.
function mergeTools(merge: Merge, parsed: LayerPolicy, layer: PolicyLayer) {
  if (parsed.tools?.deny !== undefined) {
    for (const tool of parsed.tools.deny) {
      if (!(tool in merge.denySources)) merge.denySources[tool] = layer;
      merge.deny.add(tool);
    }
  }
  if (parsed.tools?.allow !== undefined) {
    if (merge.allow === undefined) {
      merge.allow = [...parsed.tools.allow];
      merge.allowSetter = layer;
      merge.allowSource = layer;
    } else if (
      JSON.stringify(merge.allow) !== JSON.stringify(parsed.tools.allow)
    ) {
      merge.overriddenAttempts.push(
        `${layer}.tools.allow overridden by ${merge.allowSetter}`,
      );
    }
  }
}

function effectivePolicyOf(merge: Merge): EffectivePolicy {
  const leaf = <T>(path: string): T | undefined =>
    merge.leaves.get(path) as T | undefined;
  return {
    tools: {
      allow: merge.allow,
      deny: [...merge.deny].sort(),
      allowSource: merge.allowSource,
      denySources: merge.denySources,
    },
    network: {
      mode: leaf<NetworkMode>('network.mode'),
      domains: leaf<string[]>('network.domains'),
    },
    models: {
      providers: leaf<string[]>('models.providers'),
      ids: leaf<string[]>('models.ids'),
      thinking: leaf<string>('models.thinking'),
      allowed: leaf<string[]>('models.allowed'),
      regions: leaf<string[]>('models.regions'),
    },
    filesystem: {
      level: leaf<FilesystemLevel>('filesystem.level'),
      roots: leaf<string[]>('filesystem.roots'),
    },
    data: {
      retentionDays: leaf<number>('data.retentionDays'),
      redactSecrets: leaf<boolean>('data.redactSecrets'),
      policy: leaf<string>('data.policy'),
    },
    logging: {
      level: leaf<LoggingLevel>('logging.level'),
      destinations: leaf<string[]>('logging.destinations'),
      policy: leaf<string>('logging.policy'),
    },
    audit: { sinks: leaf<AuditSinkSpec[]>('audit.sinks') ?? [] },
  };
}

// → engine vocabulary: the `[policy]` section's flat keys
// become the LayerPolicy leaves `resolveEffectivePolicy` merges. The two
// spellings that differ are reconciled here, in one place:
//   network_policy = "proxy"           → network.mode = 'allowlist'
//   filesystem_policy = "workspace-only" → filesystem.level = 'workspace-write'
// The engine names are accepted in config too, so either vocabulary loads.
// `[[audit]]` is deliberately not translated: the engine's AuditSinkSpec has
// no level field, so the audit sinks (`audit/sinks.ts`) read the parsed table
// directly.
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
  if (
    p.allowedProviders !== undefined ||
    p.allowedModels !== undefined ||
    p.allowedRegions !== undefined
  ) {
    out.models = {
      ...(p.allowedProviders === undefined
        ? {}
        : { providers: [...p.allowedProviders] }),
      ...(p.allowedModels === undefined
        ? {}
        : { allowed: [...p.allowedModels] }),
      ...(p.allowedRegions === undefined
        ? {}
        : { regions: [...p.allowedRegions] }),
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
