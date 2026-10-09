// Validating one policy layer from its TOML table: every section and key,
// refused by name when it is malformed or unknown.

import type {
  AuditSinkKind,
  AuditSinkSpec,
  FilesystemLevel,
  LayerPolicy,
  LoggingLevel,
} from './types.js';
import { PolicyError } from './types.js';

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

export function validateLayerPolicy(raw: unknown, layer: string): LayerPolicy {
  if (!isRecord(raw)) {
    throw new PolicyError(`policy layer '${layer}' must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_SECTIONS.has(key)) {
      throw new PolicyError(`policy layer '${layer}': unknown key '${key}'`);
    }
  }
  const out: LayerPolicy = {};
  if (raw.tools !== undefined) out.tools = toolsSection(raw.tools, layer);
  if (raw.network !== undefined)
    out.network = networkSection(raw.network, layer);
  if (raw.models !== undefined) out.models = modelsSection(raw.models, layer);
  if (raw.filesystem !== undefined)
    out.filesystem = filesystemSection(raw.filesystem, layer);
  if (raw.data !== undefined) out.data = dataSection(raw.data, layer);
  if (raw.logging !== undefined)
    out.logging = loggingSection(raw.logging, layer);
  if (raw.audit !== undefined) out.audit = auditSection(raw.audit, layer);
  return out;
}

function toolsSection(
  tools: unknown,
  layer: string,
): NonNullable<LayerPolicy['tools']> {
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
  return {
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

function networkSection(
  network: unknown,
  layer: string,
): NonNullable<LayerPolicy['network']> {
  if (!isRecord(network)) {
    throw new PolicyError(`policy layer '${layer}': 'network' must be a table`);
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
  return {
    ...(mode === undefined ? {} : { mode }),
    domains: stringArray(network.domains, `${layer}.network.domains`),
  };
}

function modelsSection(
  models: unknown,
  layer: string,
): NonNullable<LayerPolicy['models']> {
  if (!isRecord(models)) {
    throw new PolicyError(`policy layer '${layer}': 'models' must be a table`);
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
  return {
    providers: stringArray(models.providers, `${layer}.models.providers`),
    ids: stringArray(models.ids, `${layer}.models.ids`),
    ...(thinking === undefined ? {} : { thinking }),
    allowed: modelPatternList(models.allowed, `${layer}.models.allowed`),
  };
}

function filesystemSection(
  filesystem: unknown,
  layer: string,
): NonNullable<LayerPolicy['filesystem']> {
  if (!isRecord(filesystem)) {
    throw new PolicyError(
      `policy layer '${layer}': 'filesystem' must be a table`,
    );
  }
  checkNoUnknown(filesystem, new Set(['level', 'roots']), 'filesystem', layer);
  const level = filesystem.level;
  if (
    level !== undefined &&
    (typeof level !== 'string' || !FILESYSTEM_LEVELS.includes(level))
  ) {
    throw new PolicyError(
      `policy layer '${layer}': invalid filesystem level ${JSON.stringify(level)}`,
    );
  }
  return {
    ...(level === undefined ? {} : { level: level as FilesystemLevel }),
    roots: stringArray(filesystem.roots, `${layer}.filesystem.roots`),
  };
}

function dataSection(
  data: unknown,
  layer: string,
): NonNullable<LayerPolicy['data']> {
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
  return {
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

function loggingSection(
  logging: unknown,
  layer: string,
): NonNullable<LayerPolicy['logging']> {
  if (!isRecord(logging)) {
    throw new PolicyError(`policy layer '${layer}': 'logging' must be a table`);
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
  return {
    ...(level === undefined ? {} : { level: level as LoggingLevel }),
    destinations: stringArray(
      logging.destinations,
      `${layer}.logging.destinations`,
    ),
    ...(loggingPolicy === undefined ? {} : { policy: loggingPolicy }),
  };
}

function auditSection(
  audit: unknown,
  layer: string,
): NonNullable<LayerPolicy['audit']> {
  if (!isRecord(audit)) {
    throw new PolicyError(`policy layer '${layer}': 'audit' must be a table`);
  }
  checkNoUnknown(audit, new Set(['sinks']), 'audit', layer);
  return { sinks: parseSinks(audit.sinks, layer) };
}
